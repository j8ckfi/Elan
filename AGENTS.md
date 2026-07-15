# AGENTS.md — read this first

Elan is a **singleplayer agent orchestrator** shaped like Linear crossed with
Slack: an issue tracker where the assignees are your model subscriptions. You
don't chat with agents — you file work, tag agents into it, and the board is
the interface. This repo is a fork of
[Mari](https://github.com/j8ckfi/Mari), a desktop frontend for agent CLIs; it
keeps Mari's adapter/host core intact and replaces the chat shell with the
board.

If you're an agent (or human) dropped in blind, this file is the map. Deep
dives live in `docs/`:

| Doc | What it covers |
| --- | --- |
| [docs/ELAN.md](docs/ELAN.md) | **Start here.** The product, the kernel, the glossary, locked design decisions. |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Entities and the store contract. |
| [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) | Tag → spawn, the `elan` CLI, worktrees. |
| [docs/FRONTEND.md](docs/FRONTEND.md) | Elan's design language: shape, motion, surfaces, component landmarks. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Inherited from Mari. Dataflow, session model, the two runtimes, the hosts, invariants. |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Inherited from Mari. **The one seam.** How to point Elan at a new agent CLI, step by step. |

---

## The shape of the system

```
                    (one per open session/tab)
┌─ your CLI ──► stdout JSONL ──► Transport ──► AdapterSession.handleLine()
│   child                        (Tauri IPC          │  wire → AgentEvent[]
│                                 or WS bridge)      ▼
│                                              core reducer  ──► ChatItem[]
│                                              (src/lib/agent/reducer.ts)   │
│                                                                           ▼
└── stdin  ◄── Transport.send ◄── adapter intents ◄── UI actions ◄── React components
               (prompt / abort / setModel / …)
```

- Everything protocol-shaped lives in an **adapter** (`src/lib/adapters/*`).
- Everything rendering-shaped consumes the **neutral view model**
  (`ChatItem` et al. in `src/lib/agent/types.ts`). No component ever sees a
  wire event.
- The **capabilities object** on your adapter gates UI chrome: no `models`
  capability → no model picker renders, and so on. A minimal adapter
  (spawn + prompt + streamed text) yields a complete working app.
- Hosts (the Rust core / dev bridge) are **protocol-blind**: they spawn the
  `SpawnSpec` your adapter builds (`bin` + `args` + `cwd`) and shuttle JSONL
  lines. The only Pi-specific host code is the sidebar's session-store
  listing, kept at the bottom of `src-tauri/src/pi.rs`.

## Dev loops

- **UI-only work:** `bun run dev` (Vite :1420) + `bun dev/elan-host.ts` (or
  `bun run host`) — the board is always host-backed, so the host must be up.
  Add `bun dev/pi-bridge.ts` (WS bridge :4317, one CLI child per session) for
  chat-session work. Fast, no Rust rebuild. `.claude/launch.json` has an
  `elan-preview` config (port 5199) for the Claude Preview MCP.
- **No agent CLIs:** open `/?agent=mock` — the mock **chat adapter** streams a
  scripted response with zero external dependencies, for chat-session UI work.
  Note the **board** still needs a host; the e2e suite boots a real host with
  an all-`mock` roster (see `playwright.config.ts`).
- **Adapter selection in dev:** `?agent=pi|mock|claude-code` URL param or
  `VITE_AGENT=…` env (see `src/config.ts`). Forks change the default import.
- **Anything touching Rust (`src-tauri/`):** `bun run tauri dev`, or
  `tauri build` + install (below). Rust does **not** hot-reload.
- Working Pi providers vary by environment; `openai-codex/gpt-5.5` is a
  reliable default (`VITE_PI_MODEL` overrides). The local Laguna default is
  often down.

## Tests — run them, extend them

```sh
bun run test   # unit + fixture tests (tests/): reducer fold, adapter translation
bun run e2e    # Playwright against the real UI + mock adapter (e2e/)
bunx tsc --noEmit                                  # typecheck
cargo check --manifest-path src-tauri/Cargo.toml   # Rust core
```

CI (`.github/workflows/ci.yml`) runs all four. House rules:

- **New adapter → new fixture test.** Record/craft a wire-event stream, fold
  it through `createSession().handleLine` + the core reducer, assert the
  `ChatItem`s (see `tests/pi-adapter.test.ts` for the pattern).
- **Core reducer changes → cover them in `tests/reducer.test.ts`.** That file
  is the contract every backend relies on.
- The e2e suite needs no credentials — keep it that way (it drives the mock).

## Gotchas cheat-sheet (hard-won, don't relearn)

- **Process keys are `crypto.randomUUID()`** (`nextKey()` in App.tsx), never a
  module counter — HMR resets module state while React keeps live tabs, and a
  reissued key renders two panes at once.
- **No React StrictMode** (main.tsx): it double-invokes effects, which would
  spawn/kill the stateful CLI subprocess twice on mount.
- **"Won't connect from the installed app" → suspect PATH first.** GUI apps
  launched from Finder get a bare PATH. The fix (login-shell probe + fallback
  dirs, generic bare-bin resolution) lives in `src-tauri/src/pi.rs`
  (`augmented_path`, `resolve_bin`). Pull `pi://stderr` to confirm before
  assuming credentials.
- **Malformed content must never white-screen.** Adapters normalize wire
  content (string | array | missing — see `normContent` in the Pi adapter);
  each session is wrapped in an error boundary so one bad transcript takes
  down only itself. Preserve both layers.
- **Session-store parsing has three mirrors:** `store-format.ts` (TS),
  `dev/pi-bridge.ts` (reads disk with it), `src-tauri/src/pi.rs` (Rust port).
  Change one → change all three (tests cover the TS one).
- **`pgrep` for bridge-spawned CLIs:** they show in `ps` as the bare binary,
  not the full arg string. Use `pgrep -P <bridge-pid>`.
- **Claude Preview MCP quirks:** the headless browser reports
  `window.innerHeight === 0`, so scroll/viewport-height behavior can't be
  trusted there — assert per-element geometry/classes instead, and verify true
  scrolling in the desktop app. Offcanvas sidebar content may be unmounted
  while collapsed; toggle it open before asserting on it.
- **Commit identity:** commits in this repo use
  `git -c user.name="Elan" -c user.email="dovakinvsalduin444444@gmail.com"`.
- **Foreground `sleep` is blocked** in the agent harness; use background tasks
  / until-loops to wait on conditions.

## Build / install (desktop)

```sh
bun run tauri build
# quit running app, replace the bundle, relaunch:
osascript -e 'tell application "Elan" to quit'
rm -rf /Applications/Elan.app
cp -R "src-tauri/target/release/bundle/macos/Elan.app" /Applications/Elan.app
killall Dock          # refresh the dock icon
open /Applications/Elan.app
```

`tauri dev` runs a bare binary (no bundle), so the dock icon only reflects a
bundled build.

### The app icon pipeline (learned the hard way)

The source is an Icon Composer `.icon` bundle at
`src-tauri/icons/source/MariIcon.icon`. **Do NOT hand-composite the icon** —
export the appearance you want straight from Icon Composer (File → Export,
1024), inset it to the macOS grid (~824/1024, centered), then
`bunx tauri icon <inset-master>.png`. Details in
`src-tauri/icons/source/README.md`. Dock not updating? `killall Dock`.

## Releases & updates

Auto-update = Tauri updater plugin + a Developer ID-signed and notarized GitHub
Release carrying a `latest.json` manifest.

- Signing keypair: `bunx tauri signer generate`. **Public key →
  tauri.conf.json. Private key + password → GitHub repo secrets**
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — set via
  `gh secret set`, never committed. Losing the key means users reinstall once.
- Gatekeeper trust requires a paid Apple Developer account and a **Developer ID
  Application** certificate. Apple credentials stay on the release Mac: the
  signing identity is in the login Keychain and `notarytool` uses the Keychain
  profile `elan-notary`. Do not export the identity, upload a `.p12`, or add
  Apple credentials to GitHub. An Apple Development certificate or ad-hoc
  signature is not sufficient for downloads.
- **Build a release:** bump the version in `package.json`,
  `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (keep them in sync),
  then run `.github/scripts/build-notarized-macos.sh`. It signs and notarizes
  the app and DMG locally, staples both tickets, runs `codesign`, Gatekeeper
  (`spctl`), and `stapler`, and creates the updater archive.
- **Publish a release:** create a draft GitHub Release with the notarized DMG
  and `Elan_universal.app.tar.gz`, then dispatch `.github/workflows/release.yml`
  from `main` with its `vX.Y.Z` tag (`gh workflow run release.yml --ref main
  -f tag=vX.Y.Z`). CI re-verifies both artifacts, signs the archive with the
  existing Tauri updater secret, creates `latest.json`, and only then publishes
  the release. Watch with `gh run watch`.
- A team's first Developer ID submission can sit at `In Progress` for hours
  with no log. Keep the original submission ID and poll `notarytool history`;
  do not create a stream of duplicate submissions. Nothing may publish before
  the accepted ticket is stapled and the verification script passes.

---

*Keep this file current: when you learn something the hard way, add it here or
to the right doc in `docs/`.*
