# AGENTS.md — Mari working notes

Tribal knowledge for anyone (human or agent) working on Mari. The stuff that
isn't obvious from the code, and the traps that already bit us. Keep this
current — when you learn something the hard way, add it here.

---

## What Mari is

A Tauri 2 (Rust core) + React desktop client for **Pi** (`pi --mode rpc`), a
Claude-Code-style coding agent with a bidirectional JSONL RPC protocol over
stdin/stdout. Mari does not embed Pi — it spawns the user's installed `pi`
binary and bridges its protocol to the webview.

Design bet: **taste is the differentiator.** Calm blank-slate surface, motion
that means something, deep polish on the chat surface.

---

## Two runtimes, one frontend

The React app is transport-agnostic (`src/lib/pi/client.ts`, `createPiTransport(key)`):

- **Desktop (Tauri):** the Rust core (`src-tauri/src/pi.rs`) owns the `pi`
  child. Commands go through `invoke("pi_start"|"pi_send"|"pi_stop")`; events
  come back on the `pi://event` Tauri event as `{key, line}` envelopes. A
  module-level hub demuxes envelopes by key.
- **Browser (dev):** `dev/pi-bridge.ts` — a Bun WebSocket server on **:4317**
  that spawns one `pi` per socket. Lets you iterate on UI with Vite HMR and **no
  Rust rebuild**. `VITE_PI_BRIDGE_URL` overrides the URL.

Anything protocol-shaped must work through **both** transports. When you add a
command/event, wire it in `client.ts` for Tauri and confirm the bridge relays it.

### Dev loops

- **UI-only work:** `bun run dev` (Vite :1420) + `bun dev/pi-bridge.ts`. Fast.
  `.claude/launch.json` has a `mari-preview` config (port 5199) for the Claude
  Preview MCP.
- **Anything touching Rust (`pi.rs`/`lib.rs`):** `bun run tauri dev`, or
  `tauri build` + install (see below). Rust changes do **not** hot-reload.
- Working Pi providers vary by environment; `openai-codex/gpt-5.5` is a reliable
  default. The local Laguna default is often down.

---

## Session model: one process per session (warm pool)

Pi is **one-session-per-process** (`switch_session` swaps the single active
session in a process). Mari instead runs **one `pi` process per open session**
so background agents keep streaming when you navigate away.

- `src/App.tsx` is the **session manager**: holds tabs, the active key, per-engine
  status, and mounts one `<SessionEngine>` (which calls `usePiSession`) per tab.
- **Warm pool reaping** (App.tsx): keep the active tab + every *running*
  (streaming) tab + the last `settings.warmPoolSize` recently-viewed idle tabs;
  unmount (→ kill process) the rest. Running sessions are never reaped.
- `usePiSession` is the **per-session engine**: owns one transport, folds events
  into the reducer, tracks model/identity/stats, exposes the session actions.

### Process keys MUST be `crypto.randomUUID()`

Not a module counter. HMR resets module state to 0 while React keeps the live
tabs, so a counter reissues a key that collides with an existing tab → two tabs
match `activeKey` and both render (the "stacked panes" bug). A UUID can't collide
across an HMR reload. See `nextKey()` in App.tsx.

---

## The `/Applications` PATH trap (important)

`pi` is a `#!/usr/bin/env node` script. A Finder-launched app inherits a **bare
PATH** (`/usr/bin:/bin:…`) with no `~/.local/bin`, so `env` can't find `node`,
`pi` dies instantly, and the UI shows "Pi disconnected." `tauri dev` works only
because it inherits your terminal PATH.

Fix lives in `pi.rs` `augmented_path()`: probe the login shell's PATH
(`$SHELL -lc`, non-interactive to avoid hangs, markers to isolate from rc noise)
+ a static fallback set (`~/.local/bin`, `~/.bun/bin`, homebrew, …), cached. Set
on the spawned child's PATH. Settings can add extra dirs / override the binary
(`StartOptions.piBin` / `pathDirs`, camelCase serde-renamed on the Rust side).

**Any time Pi "won't connect from the installed app," suspect PATH first.** Pull
`pi://stderr` to confirm before assuming a credentials issue.

---

## Reducer / hydration safety

- `reduce()` (`src/lib/pi/reducer.ts`) folds the Pi event stream into view items.
- `normContent()` coerces message content (string | undefined | array) into a
  block array. Pi sometimes sends string content; without normalization a
  `content.some(...)` blows up and white-screens the app. Every consumer must go
  through the normalizers.
- Each `<SessionEngine>` is wrapped in a class **error boundary** so a malformed
  transcript takes down only that session, not the whole app.

---

## Sidebar / session sync

- The sidebar reads the on-disk session list (`~/.pi/agent/sessions`), grouped by
  project (cwd). Order + collapsed-set persist in localStorage.
- **Durability:** a `notify` filesystem watcher in Rust emits
  `pi://sessions-changed`; the browser path polls. A session written by *any*
  process — even a terminal `pi` — syncs into the sidebar within ~120ms
  (debounced). Don't add a manual "refresh" path; keep the watch authoritative.

---

## Model + thinking pickers

- **Model picker** (`ModelPicker.tsx`) is a Base UI **Combobox** — searchable
  (200+ models), auto-focused input, opens **upward** and pinned
  (`collisionAvoidance={{ side: "none" }}`) so it never flips. Grouped by provider.
- **Thinking picker** is a plain Base UI **Select** (few options).
- **Thinking levels are model-aware** (`src/lib/pi/thinking.ts`): read each
  model's `thinkingLevelMap` from `get_available_models` and mirror pi-ai's
  `getSupportedThinkingLevels` — non-reasoning models hide the picker; GLM-5.2
  shows only High + Max; `xhigh` renders as "Max". **Never hard-code the level
  list.** Note the *same* model id under different providers can have different
  maps.

---

## Look & feel conventions

- **Squircle / radius system** lives in `src/lib/shape-context.tsx`. No
  `ShapeProvider` is mounted, so `useShape()` falls back to `shapeMap.pill` —
  that object drives most corner radii app-wide (despite the name it's been
  tuned "properly square": container 8px, items 5px). `--radius` (index.css,
  6px) cascades to `rounded-sm/md/lg/xl` via `@theme`. Genuinely circular
  controls (send button, model/thinking pills, dots) use `rounded-full` directly.
- **Motion** (Emil Kowalski school): custom easings (`--ease-out:
  cubic-bezier(0.23,1,0.32,1)`), durations <300ms for UI, `:active` scale 0.97,
  origin-aware popovers, never `scale(0)` / `ease-in` / `transition: all`.
- **NEVER use a pulsing/pinging green dot for the agent-working indicator.** It
  was rejected on sight. Use expressive assets (title shimmer `.shimmer-run`,
  etc.).
- Blank slate: no border beam, no connection status dot. The "Pi disconnected"
  banner is the only connection affordance (it's load-bearing — the reconnect).

---

## Settings

`src/lib/settings.ts` — a `SettingsProvider` over plain **localStorage** (works
identically in the Tauri webview and browser dev; no store plugin, no Rust
round-trip). It also owns **theme** application (system/light/dark, live). Values
that must reach Rust (`piBin`, `pathDirs`) are read here and passed through
`pi_start`'s options — Rust stays stateless. App version is injected via a Vite
`define` (`__APP_VERSION__`).

---

## The app icon pipeline (learned the hard way)

The source is an **Icon Composer** `.icon` bundle (macOS 26) at
`src-tauri/icons/source/MariIcon.icon`. Tauri ships one static icon.

**Rule: do NOT hand-composite the icon.** `xcrun actool` renders the `.icon`,
but for a standalone `.icns` it only emits the **light** appearance (dark pixels
are locked in an adaptive asset in the compiled `Assets.car`). Hand-compositing
the dark variant lost Icon Composer's gloss/bevel and looked broken.

**Do this instead:** export the appearance you want straight from Icon Composer
(File → Export → Dark, 1024). Icon Composer's export is full-bleed (iOS framing),
so inset it to the macOS grid (~824/1024, centered) before slicing. Then
`bunx tauri icon <inset-master>.png`. See `src-tauri/icons/source/README.md`.

Dock not updating after a rebuild? It's the macOS icon cache: `killall Dock`.

---

## Build / install workflow

```sh
bun run tauri build
# quit running app, replace the bundle, relaunch:
osascript -e 'tell application "Mari" to quit'
rm -rf /Applications/Mari.app
cp -R "src-tauri/target/release/bundle/macos/Mari.app" /Applications/Mari.app
killall Dock          # refresh the dock icon
open /Applications/Mari.app
```

> The bundle is `Mari.app` (productName is `Mari`); the identifier stays
> `com.mari.desktop`. macOS's default filesystem is case-insensitive, so an
> in-place updater swap over an older `mari.app` resolves to the same path.

`tauri dev` runs a bare binary (no bundle), so the **dock icon only reflects a
bundled build**, not dev.

---

## Releases & updates

Auto-update = Tauri updater plugin + a signed GitHub Release carrying a
`latest.json` manifest.

- Signing keypair: `bunx tauri signer generate`. **Public key → tauri.conf.json.
  Private key + password → GitHub repo secrets** (`TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — set via `gh secret set`, never
  committed. Losing the key means users must reinstall once.
- `.github/workflows/release.yml` (tauri-action) builds/signs/publishes on a
  `v*` tag.
- **Cut a release:** bump the version in `package.json` **and**
  `src-tauri/tauri.conf.json` (keep them in sync), then
  `git tag vX.Y.Z && git push --tags`. Watch with `gh run watch`.
- **Not notarized** (deliberate, for now): first install needs right-click →
  Open, and unsigned auto-updates can occasionally be re-quarantined by
  Gatekeeper. If self-replace gets flaky, fall back to a "new version → download"
  nudge until notarization is added.

---

## Verifying with the Claude Preview MCP

The headless preview browser reports **`window.innerHeight === 0`**, so anything
scroll/viewport-height-dependent (seat-at-top, jump-to-latest reappearance,
popup flip direction, dialog backdrop coverage) can't be trusted there — but
`getBoundingClientRect` on individual elements, class assertions, and computed
styles **do** work. Verify geometry per-element; verify true scroll behavior on
the desktop app.

Offcanvas sidebar content may be unmounted when collapsed — toggle it open before
asserting on sidebar elements.

---

## Gotchas cheat-sheet

- **`pgrep` for bridge-spawned pi:** the bridge spawns `pi` via `Bun.spawn(["pi",…])`,
  so it shows in `ps` as bare `pi`, not `pi --mode rpc`. Use `pgrep -P <bridge-pid>`.
- **Foreground `sleep` is blocked** in the harness; use background tasks /
  until-loops to wait on conditions.
- **Commit identity:** commits in this repo use
  `git -c user.name="Mari" -c user.email="dovakinvsalduin444444@gmail.com"`.
- **No React StrictMode** (main.tsx): it double-invokes effects, which would
  spawn/kill the stateful `pi` subprocess twice on mount.
