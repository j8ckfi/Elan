# Plan 003: The desktop app owns its host — Tauri spawns or adopts the Elan host

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP updating `plans/README.md` — your reviewer
> maintains the index.
>
> **Drift check (run first)**: `git diff --stat 84100c3..HEAD -- src-tauri package.json .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (file-disjoint from 001/002; the user-visible payoff — the webview connecting — lands when 002 merges)
- **Category**: direction / bug
- **Planned at**: commit `84100c3`, 2026-07-12

## Why this matters

The desktop app is Elan's flagship build, but nothing in it starts the Elan
host — the process that owns BoardState and spawns agent CLIs
(`dev/elan-host.ts`, Bun, port 4519). `docs/ORCHESTRATION.md` records "on
desktop it will be the Rust core (same API — parity is build-order step 5)".
The maintainer's decision: the app must **always work** — launching the
desktop app must guarantee a host is running. This plan makes the Tauri
process spawn the host (or adopt one already listening on 4519) and own its
lifecycle. Full Rust parity remains future work; this ships the guarantee now
by managing the existing Bun host as a child process (dev) / bundled sidecar
binary (release).

## Current state

- `src-tauri/src/lib.rs` — Tauri 2 builder: plugins (opener, dialog, updater,
  process), `.setup()` calls `pi::init(app.handle())` and macOS
  `glass::apply_sidebar_glass`, then `invoke_handler` with `pi_*` commands,
  then `.run(tauri::generate_context!()).expect(…)`.

```rust
#[cfg(target_os = "macos")]
mod glass;
mod pi;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            pi::init(app.handle());
            ...
        })
        .invoke_handler(tauri::generate_handler![ pi::pi_start, ... ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- `src-tauri/src/pi.rs` — existing child-process machinery for Mari's
  chat-session CLIs (spawn, stdin/stdout shuttling). Read it for
  process-handling conventions (kill-on-drop, thread patterns) before writing
  host.rs — match its style. Do not modify it.
- `src-tauri/tauri.conf.json` — `productName: "Elan"`, identifier
  `app.elan.desktop`, `beforeDevCommand: "bun run dev"`, `devUrl:
  http://localhost:1420`, `frontendDist: ../dist`.
- The host: `bun dev/elan-host.ts`, config via env: `ELAN_HOST_PORT` (default
  4519), `ELAN_STATE_DIR` (default `./.elan`), plus orchestrator knobs. State
  file `${ELAN_STATE_DIR}/board.json`.
- The frontend (at 84100c3) only connects to a host given `VITE_ELAN_HOST` or
  `?host=` — plan 002 makes `http://127.0.0.1:4519` the unconditional
  default. THIS plan does not touch frontend code.
- Repo verification commands: `cargo check --manifest-path
  src-tauri/Cargo.toml` (CI runs it), `bunx tsc --noEmit`, `bun test tests`.
- Check `src-tauri/Cargo.toml` for available deps before adding any. Prefer
  std-only (TcpStream for the port probe, std::process for spawning).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install JS deps | `bun install` | exit 0 |
| Rust check | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Host manually | `bun dev/elan-host.ts` | listens on :4519 |
| Probe | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4519/api/state` | `200` |
| Full app (manual/reviewer) | `bun run tauri dev` | window opens, host on :4519 |

## Scope

**In scope**:
- `src-tauri/src/host.rs` (create)
- `src-tauri/src/lib.rs` (wire host::init + exit cleanup)
- `src-tauri/tauri.conf.json` (release sidecar config, Step 4 only)
- `src-tauri/Cargo.toml` (only if a dependency is truly unavoidable — justify in NOTES)
- `package.json` (add `build:host` script, Step 4 only)
- `.gitignore` (ignore `src-tauri/binaries/`)

**Out of scope**:
- `src-tauri/src/pi.rs`, `glass.rs` — inherited core.
- ALL frontend code (`src/**`) — plan 002 owns the connection story.
- `dev/elan-host.ts` — plan 002 touches it; you only spawn it.
- `e2e/**`, `tests/**`.

## Git workflow

- Branch: `advisor/003-tauri-owns-the-host`
- Commit per step; short imperative messages matching `git log` style.
- Do NOT push or open a PR.

## Steps

### Step 1: host.rs — probe, adopt or spawn, own

Create `src-tauri/src/host.rs`:

- `const HOST_PORT: u16 = 4519;`
- `fn port_open() -> bool` — `std::net::TcpStream::connect_timeout(("127.0.0.1", HOST_PORT), ~300ms)`.
  A listener on 4519 is treated as an existing Elan host and **adopted**
  (do not spawn a second; log via `eprintln!` or the tauri log convention
  used elsewhere). Document the limitation: we can't distinguish a foreign
  service on 4519; a comment is enough.
- `pub struct HostChild(Mutex<Option<std::process::Child>>);` held in Tauri
  managed state (`app.manage(...)`).
- `pub fn init(app: &tauri::AppHandle)` — if `port_open()`, adopt and return.
  Else spawn:
  - **Dev builds** (`#[cfg(debug_assertions)]`): `Command::new("bun")`, arg
    `dev/elan-host.ts`, `current_dir` = the repo root — resolve as
    `env!("CARGO_MANIFEST_DIR")` parent (compile-time path is fine for dev
    builds; add a comment). State dir stays the repo's `./.elan` (host
    default), preserving existing dev state.
  - **Release builds**: spawn the bundled sidecar binary named `elan-host`
    sitting next to the app executable
    (`std::env::current_exe()?.parent().join("elan-host")`), with env
    `ELAN_STATE_DIR` = the app data dir
    (`app.path().app_data_dir()?.join("elan")` — create it first).
  - Both: stdio inherited or piped-and-dropped (match pi.rs's convention),
    store the `Child` in `HostChild`.
  - After spawning, poll `port_open()` up to ~5s (e.g. 20 × 250ms) and log
    failure loudly rather than crashing the app — the (plan 002) banner
    communicates an unreachable host to the user.
- `pub fn shutdown(app: &tauri::AppHandle)` — take the child from `HostChild`
  and `kill()` + `wait()` it. Adopted hosts (we didn't spawn) are not killed.

### Step 2: Wire into lib.rs

- `mod host;`, call `host::init` in `.setup()` (after `pi::init`).
- Exit cleanup: change the tail to the build-then-run form so we see exit:

```rust
tauri::Builder::default()
    …
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            host::shutdown(app);
        }
    });
```

(Confirm against the tauri 2 API in the locked Cargo.toml; if the installed
tauri version's `run` closure signature differs, match it. `RunEvent::ExitRequested` fires before exit — `Exit` is the final one; killing in
`Exit` is correct.)

**Verify (steps 1+2)**: `cargo check --manifest-path src-tauri/Cargo.toml` →
exit 0. Then the runtime check: with nothing on 4519, run
`bun run tauri dev` in the background, wait up to 60s, then
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4519/api/state` →
`200`. Quit the app (kill the tauri dev process group), wait 3s, then
`curl` again → connection refused (the child died with the app). If you
cannot run a windowed app in your environment, run `cargo check` plus a
compile-only pass and record in NOTES that runtime verification is deferred
to the reviewer — do not fake it.

### Step 3: Adoption path check

With a manually started host (`bun dev/elan-host.ts` in background), launch
the app the same way and confirm from the app logs that it **adopted** (no
second spawn; the manual host keeps serving). Kill the app; confirm the
manual host is still alive (we never kill adopted hosts). Kill the manual
host. Same environment caveat as Step 2 — defer to reviewer with a NOTE if
headless.

### Step 4: Release sidecar (separately committable; own STOP condition)

- `package.json`: add script
  `"build:host": "bun build --compile dev/elan-host.ts --outfile src-tauri/binaries/elan-host-$(rustc -vV | sed -n 's/host: //p')"`.
- Run it once: expect a self-contained executable at
  `src-tauri/binaries/elan-host-<triple>`. Smoke-test it:
  `ELAN_HOST_PORT=4533 ELAN_STATE_DIR=$(mktemp -d) ./src-tauri/binaries/elan-host-* &`
  then curl `:4533/api/state` → 200; kill it.
- `src-tauri/tauri.conf.json`: add `"bundle": { "externalBin": ["binaries/elan-host"] }`
  (merge into the existing bundle object if present — read the file first).
  Tauri resolves the `-<target-triple>` suffix at bundle time and ships the
  binary next to the app executable — which is where Step 1's release path
  looks.
- `.gitignore`: add `src-tauri/binaries/`.
- Chain the build: prepend `bun run build:host && ` to the existing
  `beforeBuildCommand` in tauri.conf.json (dev builds don't need it).

**Verify**: the smoke test above passes; `cargo check` still exit 0;
`bunx tsc --noEmit` still exit 0 (package.json script addition can't break it,
but run it anyway). A full `tauri build` is NOT required — it's slow and
needs signing config; the reviewer decides whether to run it.

## Test plan

No JS/Rust unit tests are practical for process-lifecycle glue; the
verification gates in Steps 2–4 (curl probes, adoption check, sidecar smoke
test) are the test plan. Record each probe's actual output in your report.
`bun test tests` must still pass (nothing in scope should affect it — run it
once at the end to prove no accidental damage).

## Done criteria

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0
- [ ] `bunx tsc --noEmit` exits 0, `bun test tests` exits 0
- [ ] `src-tauri/src/host.rs` exists; `lib.rs` calls `host::init` and kills the child on `RunEvent::Exit`
- [ ] Runtime probes (Steps 2–3) pass, or are explicitly deferred to reviewer in NOTES with the reason
- [ ] Sidecar binary builds and serves `/api/state` (Step 4), or Step 4 is reported STOPPED with the exact `bun build --compile` error
- [ ] `git status` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- The installed tauri 2 version's builder/run API doesn't expose an exit
  event compatible with Step 2 after checking the real API docs in the
  vendored crate source (`cargo doc` or the source in `~/.cargo`).
- `bun build --compile` fails on `dev/elan-host.ts` (dynamic imports or Bun
  APIs that don't compile) — commit Steps 1–3 (dev spawn is independently
  valuable), report Step 4 STOPPED with the exact error.
- `pi.rs` conventions conflict with the child-ownership design (e.g. a global
  process registry you'd have to modify) — do not modify pi.rs.
- Spawning `bun` in dev fails because bun isn't on the app's PATH when
  launched from Finder — note it; dev builds launched from a terminal are the
  supported dev path. (Do NOT build a PATH-resolution layer; that's scope
  creep.)

## Maintenance notes

- This plan + plan 002 together give the always-working desktop app: 002
  points the webview at 127.0.0.1:4519 unconditionally; this plan guarantees
  something is listening there. Merge order between them doesn't matter.
- Port 4519 is fixed. If two Elan installs ever need to coexist, the port
  must become dynamic (spawn with ELAN_HOST_PORT=0-style allocation + inject
  the URL into the webview) — deliberately out of scope now.
- Full Rust host parity (ORCHESTRATION.md "build-order step 5") replaces the
  sidecar eventually; host.rs's probe/adopt/spawn seam is where it slots in.
- Reviewer should scrutinize: child cleanup on abnormal exit (SIGKILL of the
  app leaks the child — acceptable, document), and that the adopted-host path
  never kills a host it didn't spawn.
