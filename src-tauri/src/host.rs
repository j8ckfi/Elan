//! The Elan host lifecycle.
//!
//! The desktop app must ALWAYS work: launching it guarantees a host — the
//! process that owns BoardState and spawns agent CLIs (`dev/elan-host.ts`,
//! Bun, port 4519) — is running. This module makes the Tauri process own that
//! guarantee: on startup it probes 127.0.0.1:4519 and either ADOPTS a host
//! already listening there, or SPAWNS one and owns its lifecycle (killing it
//! when the app exits).
//!
//! Dev builds spawn `bun dev/elan-host.ts` from the repo root (preserving the
//! repo's `./.elan` state). Release builds spawn the bundled `elan-host`
//! sidecar sitting next to the app executable, with state under the app data
//! dir. Full Rust parity for BoardState is future work (docs/ORCHESTRATION.md,
//! build-order step 5); this ships the always-works guarantee now by managing
//! the existing Bun host as a child process.
//!
//! Process handling deliberately uses `std::process` (not the `tokio::process`
//! that pi.rs uses for its stdio-shuttling children): the host is fire-and-own
//! — we never read its streams, we just spawn it, probe the port, and kill it
//! on exit — so the blocking std API is the simpler fit.

use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The host's fixed port. Mirrors `ELAN_HOST_PORT`'s default in
/// dev/elan-host.ts; the frontend's default connection target is the same.
const HOST_PORT: u16 = 4519;

/// The child host we spawned, if any. `None` means either we haven't spawned
/// yet or we adopted a pre-existing host (which we must NOT kill). Held in
/// Tauri managed state.
pub struct HostChild(Mutex<Option<std::process::Child>>);

/// Is something listening on 127.0.0.1:4519? We treat any listener as an
/// existing Elan host and adopt it. LIMITATION: we can't distinguish a genuine
/// Elan host from an unrelated service that happens to hold the port — a short
/// connect probe is all we have; a foreign service would be silently adopted
/// (and the webview would then fail to talk to it, surfacing via the
/// connection banner). Acceptable for a fixed, app-owned port.
fn port_open() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], HOST_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Poll the port after a spawn, up to ~5s. Returns true once it's listening.
fn wait_for_port() -> bool {
    for _ in 0..20 {
        if port_open() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    port_open()
}

/// Ensure a host is running. Adopt one already on :4519, else spawn and own it.
/// Never crashes the app: a failed spawn / unreachable host is logged loudly
/// and left for the frontend's connection banner to surface to the user.
pub fn init(app: &AppHandle) {
    app.manage(HostChild(Mutex::new(None)));

    if port_open() {
        eprintln!("[elan-host] adopting existing host on 127.0.0.1:{HOST_PORT} (not spawning)");
        return;
    }

    let child = match spawn(app) {
        Ok(child) => child,
        Err(e) => {
            eprintln!("[elan-host] failed to spawn host: {e}");
            return;
        }
    };

    // Stash the child BEFORE the poll so exit cleanup can reap it even if it
    // never comes up.
    if let Some(state) = app.try_state::<HostChild>() {
        *state.0.lock().unwrap() = Some(child);
    }

    if wait_for_port() {
        eprintln!("[elan-host] host is up on 127.0.0.1:{HOST_PORT}");
    } else {
        eprintln!(
            "[elan-host] spawned host did not start listening on 127.0.0.1:{HOST_PORT} within 5s"
        );
    }
}

/// Spawn the host child appropriate to the build. Stdio is inherited so the
/// host's own logs (banners, per-turn failures) land in the app's console —
/// useful in dev, harmless in release (where there's no attached console).
#[cfg(debug_assertions)]
fn spawn(_app: &AppHandle) -> std::io::Result<std::process::Child> {
    // Dev: run the TypeScript host with Bun from the repo root, so the host's
    // default `./.elan` state dir resolves to the repo's existing dev state.
    // `CARGO_MANIFEST_DIR` is src-tauri; its parent is the repo root. A
    // compile-time path is fine here — dev builds only ever run from this tree.
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR has a parent")
        .to_path_buf();

    Command::new("bun")
        .arg("dev/elan-host.ts")
        .current_dir(&repo_root)
        .env("ELAN_OWNER_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
}

#[cfg(not(debug_assertions))]
fn spawn(app: &AppHandle) -> std::io::Result<std::process::Child> {
    // Release: run the bundled `elan-host` sidecar sitting next to the app
    // executable (Tauri's `externalBin` ships it there). State goes under the
    // app data dir so a packaged app never writes into its own bundle.
    let bin = std::env::current_exe()?
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no exe parent dir"))?
        .join("elan-host");

    let state_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("no app data dir: {e}")))?
        .join("elan");
    std::fs::create_dir_all(&state_dir)?;

    Command::new(&bin)
        .env("ELAN_STATE_DIR", &state_dir)
        .env("ELAN_OWNER_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Kill the host we spawned, on app exit. Adopted hosts (we never stored a
/// child for them) are left alone — we didn't start them, we don't stop them.
///
/// This is the graceful half of the contract: `RunEvent::Exit` doesn't fire
/// when the app dies by signal, so the host also watches ELAN_OWNER_PID (set
/// in `spawn` above) and exits on its own if we vanish without calling this.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<HostChild>() else {
        return;
    };
    let child = state.0.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
