//! Agent CLI process manager.
//!
//! Spawns the command the frontend's adapter describes (a SpawnSpec: bin +
//! args + cwd) and bridges its JSONL stdio protocol to the webview:
//!   - every stdout line is emitted verbatim as `pi://event`
//!   - stderr lines are emitted as `pi://stderr`
//!   - process exit is emitted as `pi://exit`
//! The frontend sends commands (one JSON object per line) via `pi_send`.
//!
//! This module is protocol-blind: what the lines *mean* is the frontend
//! adapter's business (src/lib/adapters/). The only Pi-specific code here is
//! the session-store section at the bottom (listing/watching Pi's on-disk
//! sessions), which mirrors src/lib/adapters/pi/store-format.ts.
//!
//! Framing note: the Pi RPC docs warn that generic line readers which split on
//! U+2028/U+2029 are NOT protocol-compliant. Rust's `AsyncBufReadExt::lines()`
//! splits on `\n` only (and strips a trailing `\r`), so it is safe here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// One live agent child, addressed by a caller-supplied `key`.
struct ProcHandle {
    stdin: ChildStdin,
    child: Child,
}

/// Pool of running agent children, keyed by session/process key. Mari runs one
/// process per open session so background agents keep streaming when you
/// navigate away — the `key` routes every command/event to the right child.
#[derive(Default)]
pub struct PiState {
    procs: Mutex<HashMap<String, ProcHandle>>,
}

/// Resolve a binary name to something spawnable. `Command::new` resolves bare
/// names against the PARENT's PATH — which, for a Finder-launched app, is the
/// bare system default that the user's CLIs are never on. So bare names are
/// searched against the augmented PATH ourselves; explicit paths pass through.
fn resolve_bin(bin: &str, path: &str) -> String {
    if bin.contains('/') {
        return bin.to_string();
    }
    for dir in path.split(':').filter(|s| !s.is_empty()) {
        let candidate = PathBuf::from(dir).join(bin);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    bin.to_string()
}

/// A PATH the spawned Pi can actually run under. `pi` is a `#!/usr/bin/env node`
/// script, so it needs `node` on PATH — but an app launched from Finder inherits
/// only a bare PATH (`/usr/bin:/bin:…`), where neither node nor pi live. We build
/// a real one once: the login shell's PATH (covers Homebrew, nvm/fnm/volta,
/// `~/.local/bin`, …) plus a static safety net, de-duped. Cached for the process.
fn augmented_path() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut dirs: Vec<String> = Vec::new();

            // Probe the login shell for its PATH. Non-interactive (`-lc`) so it
            // can't hang on a prompt; markers isolate the value from rc noise.
            if let Ok(shell) = std::env::var("SHELL") {
                if let Ok(out) = std::process::Command::new(&shell)
                    .args(["-lc", "printf '<<MARIPATH>>%s<<END>>' \"$PATH\""])
                    .output()
                {
                    let s = String::from_utf8_lossy(&out.stdout);
                    if let (Some(a), Some(b)) = (s.find("<<MARIPATH>>"), s.find("<<END>>")) {
                        if b > a {
                            let inner = &s[a + "<<MARIPATH>>".len()..b];
                            for d in inner.split(':').filter(|s| !s.is_empty()) {
                                dirs.push(d.to_string());
                            }
                        }
                    }
                }
            }

            // Static safety net — the common toolchain locations, in case the
            // shell probe found nothing (or the user has no login PATH setup).
            if let Ok(home) = std::env::var("HOME") {
                for rel in [".local/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
                    dirs.push(format!("{home}/{rel}"));
                }
            }
            for d in [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ] {
                dirs.push(d.to_string());
            }

            // Finally whatever we already inherited.
            if let Ok(existing) = std::env::var("PATH") {
                for d in existing.split(':').filter(|s| !s.is_empty()) {
                    dirs.push(d.to_string());
                }
            }

            let mut seen = std::collections::HashSet::new();
            dirs.retain(|d| seen.insert(d.clone()));
            dirs.join(":")
        })
        .clone()
}

/// The augmented PATH with the user's extra Settings dirs prepended (highest
/// priority), de-duped against the cached base.
fn path_with_extra(extra: &[String]) -> String {
    if extra.is_empty() {
        return augmented_path();
    }
    let base = augmented_path();
    let mut dirs: Vec<String> = extra.iter().filter(|s| !s.is_empty()).cloned().collect();
    for d in base.split(':') {
        dirs.push(d.to_string());
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs.join(":")
}

/// How to launch one session's CLI — built by the frontend adapter
/// (`AgentAdapter.spawn`, see src/lib/agent/types.ts). This host stays
/// protocol- and flag-blind.
#[derive(serde::Deserialize, Default)]
pub struct SpawnSpec {
    /// Binary name or explicit path (bare names resolve on the augmented PATH).
    pub bin: Option<String>,
    /// Full argument list, verbatim.
    pub args: Option<Vec<String>>,
    /// Working directory for the agent (defaults to the user's home).
    pub cwd: Option<String>,
    /// Extra directories prepended to the child's PATH (Settings override).
    #[serde(rename = "pathDirs")]
    pub path_dirs: Option<Vec<String>>,
}

/// Every stdout line is emitted as `pi://event` wrapped in a `{key, line}`
/// envelope so the webview can route it to the owning session. Same shape for
/// the synthetic `cwd` line below. `pi://started` / `pi://exit` carry the bare
/// key string.
fn emit_line(app: &AppHandle, key: &str, line: &str) {
    let env = serde_json::json!({ "key": key, "line": line }).to_string();
    let _ = app.emit("pi://event", env);
}

/// Start (or restart) the agent subprocess for `key`.
#[tauri::command]
pub async fn pi_start(
    app: AppHandle,
    state: State<'_, PiState>,
    key: String,
    spec: Option<SpawnSpec>,
) -> Result<(), String> {
    // Tear down any previous child under this key first so restart is clean.
    stop_one(&state, &key).await;

    let spec = spec.unwrap_or_default();
    // Finder-launched apps inherit a bare PATH; give the child a real one so a
    // `#!/usr/bin/env node` shebang (and any tools it shells out to) resolve.
    // Any extra dirs from Settings take priority.
    let path = path_with_extra(spec.path_dirs.as_deref().unwrap_or(&[]));
    let bin = resolve_bin(spec.bin.as_deref().filter(|s| !s.is_empty()).unwrap_or("pi"), &path);
    let args = spec.args.unwrap_or_default();

    let mut cmd = Command::new(&bin);
    cmd.env("PATH", path);
    cmd.args(&args);
    let cwd = spec
        .cwd
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOME").ok());
    if let Some(cwd) = cwd.as_ref() {
        cmd.current_dir(cwd);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{bin} {}`: {e}", args.join(" ")))?;

    let stdout = child.stdout.take().ok_or("no stdout on pi child")?;
    let stderr = child.stderr.take().ok_or("no stderr on pi child")?;
    let stdin = child.stdin.take().ok_or("no stdin on pi child")?;

    // stdout → pi://event (one JSON object per line, key-tagged). When the
    // stream closes, the process has exited: emit pi://exit(key) so the UI can
    // surface a disconnected state for just that session.
    {
        let app = app.clone();
        let key = key.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                emit_line(&app, &key, &line);
            }
            let _ = app.emit("pi://exit", &key);
        });
    }

    // stderr → pi://stderr (diagnostics / startup banners).
    {
        let app = app.clone();
        let key = key.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let env = serde_json::json!({ "key": key, "line": line }).to_string();
                let _ = app.emit("pi://stderr", env);
            }
        });
    }

    state
        .procs
        .lock()
        .await
        .insert(key.clone(), ProcHandle { stdin, child });

    let _ = app.emit("pi://started", &key);
    // Report the working directory pi was spawned in (get_state omits it) so the
    // breadcrumb shows the real project path. Mirrors dev/pi-bridge.ts.
    if let Some(cwd) = cwd.as_ref() {
        let line = serde_json::json!({ "type": "cwd", "cwd": cwd }).to_string();
        emit_line(&app, &key, &line);
    }
    Ok(())
}

/// Send one RPC command line (already-serialized JSON, without newline) to the
/// child that owns `key`.
#[tauri::command]
pub async fn pi_send(state: State<'_, PiState>, key: String, line: String) -> Result<(), String> {
    let mut guard = state.procs.lock().await;
    let handle = guard.get_mut(&key).ok_or("pi is not running")?;
    handle
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    handle
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    handle
        .stdin
        .flush()
        .await
        .map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Stop the Pi subprocess for `key`.
#[tauri::command]
pub async fn pi_stop(state: State<'_, PiState>, key: String) -> Result<(), String> {
    stop_one(&state, &key).await;
    Ok(())
}

async fn stop_one(state: &State<'_, PiState>, key: &str) {
    // Take the handle out and drop the pool lock BEFORE awaiting the child's
    // death, so killing one session never blocks commands to the others.
    let handle = state.procs.lock().await.remove(key);
    if let Some(mut handle) = handle {
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }
}

// ── Session listing ─────────────────────────────────────────────────────────
// Pi has no cross-session "list" RPC, so we read the on-disk store directly.
// Mirrors dev/pi-bridge.ts + src/lib/pi/sessions.ts (keep the three in sync).

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    path: String,
    id: String,
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    title: String,
    created_at: i64,
    updated_at: i64,
    messages: u32,
}

/// The session store root, `~/.pi/agent/sessions`.
fn sessions_base() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(PathBuf::from(home).join(".pi/agent/sessions"))
}

/// A path is a deletable/renamable session only if it's a `.jsonl` file inside
/// the session store — never touch anything outside it.
fn valid_session_path(path: &str) -> Result<PathBuf, String> {
    let base = sessions_base()?;
    let p = PathBuf::from(path);
    let ok = p.starts_with(&base)
        && p.extension().and_then(|e| e.to_str()) == Some("jsonl");
    if ok {
        Ok(p)
    } else {
        Err("path is not inside the session store".into())
    }
}

/// Permanently delete a saved session file.
#[tauri::command]
pub fn pi_delete_session(path: String) -> Result<(), String> {
    let p = valid_session_path(&path)?;
    std::fs::remove_file(&p).map_err(|e| format!("delete failed: {e}"))
}

/// Rename a saved session by appending a `session_info` line — the listing
/// reads the last one, so this wins. Used for sessions with no live process;
/// the app renames open ones over RPC instead (pi owns that file).
#[tauri::command]
pub fn pi_rename_session(path: String, name: String) -> Result<(), String> {
    use std::io::Write;
    let p = valid_session_path(&path)?;
    let line = serde_json::json!({ "type": "session_info", "name": name }).to_string();
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| format!("open failed: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("write failed: {e}"))
}

/// Encode a cwd to its session-store directory name (mirrors pi's SessionManager).
fn encode_cwd_dir(cwd: &str) -> String {
    let trimmed = cwd.trim_start_matches(['/', '\\']);
    let safe: String = trimmed
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    format!("--{safe}--")
}

/// Parse an RFC3339 timestamp like `2026-07-07T19:39:25.407Z` to epoch ms.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let min = num(14, 16)?;
    let sec = num(17, 19)?;
    let ms = if b.get(19) == Some(&b'.') {
        s.get(20..23).and_then(|f| f.parse::<i64>().ok()).unwrap_or(0)
    } else {
        0
    };
    // days_from_civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + hour * 3600 + min * 60 + sec) * 1000) + ms)
}

fn first_user_text(msg: &serde_json::Value) -> String {
    match &msg["content"] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<String>(),
        _ => String::new(),
    }
}

fn collapse(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > n {
        let mut t: String = one.chars().take(n - 1).collect();
        t.push('…');
        t
    } else {
        one
    }
}

fn parse_session_meta(content: &str, path: &str, mtime_ms: i64) -> Option<SessionSummary> {
    let mut id = String::new();
    let mut cwd = String::new();
    let mut created_at = mtime_ms;
    let mut name: Option<String> = None;
    let mut title = String::new();
    let mut messages: u32 = 0;

    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Ok(e) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match e["type"].as_str() {
            Some("session") => {
                id = e["id"].as_str().unwrap_or("").to_string();
                cwd = e["cwd"].as_str().unwrap_or("").to_string();
                if let Some(ts) = e["timestamp"].as_str() {
                    if let Some(ms) = parse_iso_ms(ts) {
                        created_at = ms;
                    }
                }
            }
            Some("session_info") => {
                if let Some(n) = e["name"].as_str() {
                    let n = n.trim();
                    if !n.is_empty() {
                        name = Some(n.to_string());
                    }
                }
            }
            Some("message") => {
                let role = e["message"]["role"].as_str();
                if role == Some("user") || role == Some("assistant") {
                    messages += 1;
                }
                if role == Some("user") && title.is_empty() {
                    title = collapse(&first_user_text(&e["message"]), 80);
                }
            }
            _ => {}
        }
    }

    if id.is_empty() {
        return None;
    }
    if title.is_empty() && name.is_none() {
        return None;
    }
    let display = name.clone().unwrap_or_else(|| {
        if title.is_empty() {
            "Untitled".to_string()
        } else {
            title.clone()
        }
    });
    Some(SessionSummary {
        path: path.to_string(),
        id,
        cwd,
        name,
        title: display,
        created_at,
        updated_at: mtime_ms,
        messages,
    })
}

/// List saved sessions. With a cwd, reads just that project's dir; without one,
/// scans EVERY project dir so the sidebar can group all projects (each session
/// carries its own cwd). Mirrors dev/pi-bridge.ts.
#[tauri::command]
pub fn pi_list_sessions(cwd: Option<String>) -> Result<Vec<SessionSummary>, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let base = PathBuf::from(&home).join(".pi/agent/sessions");

    let dirs: Vec<PathBuf> = match cwd.filter(|s| !s.is_empty()) {
        Some(c) => vec![base.join(encode_cwd_dir(&c))],
        None => match std::fs::read_dir(&base) {
            Ok(rd) => rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect(),
            Err(_) => return Ok(Vec::new()),
        },
    };

    let mut out: Vec<SessionSummary> = Vec::new();
    for dir in dirs {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if let Ok(content) = std::fs::read_to_string(&p) {
                if let Some(meta) = parse_session_meta(&content, &p.to_string_lossy(), mtime_ms) {
                    out.push(meta);
                }
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// Watch the on-disk session store and emit `pi://sessions-changed` on ANY
/// change — so the sidebar syncs instantly, even to sessions created or edited
/// by another process (e.g. `pi` run from a terminal), not just ones this app
/// drives. The frontend coalesces the events into a single re-list.
fn start_session_watcher<R: tauri::Runtime>(app: AppHandle<R>) {
    use notify::{RecursiveMode, Watcher};

    std::thread::spawn(move || {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        let base = PathBuf::from(home).join(".pi/agent/sessions");
        let _ = std::fs::create_dir_all(&base);

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let _ = tx.send(res);
            },
        ) {
            Ok(w) => w,
            Err(_) => return,
        };
        // Recursive: new project subdirs and their session files are all covered.
        if watcher.watch(&base, RecursiveMode::Recursive).is_err() {
            return;
        }
        // Hold `watcher` alive by looping on its event channel for the app's life.
        for res in rx {
            if res.is_ok() {
                let _ = app.emit("pi://sessions-changed", ());
            }
        }
    });
}

/// Register the Pi state + commands on the builder.
pub fn init<R: tauri::Runtime>(app: &AppHandle<R>) {
    app.manage(PiState::default());
    start_session_watcher(app.clone());
}
