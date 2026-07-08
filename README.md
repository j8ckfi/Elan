# Mari

A native macOS desktop client for **[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**
(`pi --mode rpc`) — the coding agent — built with Tauri 2 + React. Mari wraps
Pi's RPC protocol in a calm, fast chat surface: streaming that feels alive,
per-session background agents, a searchable model picker, and a blank-slate
aesthetic.

> Status: pre-1.0, single-author. The UI is deep on the chat surface; the rest
> is wired up and improving.

## Requirements

Mari drives your existing Pi install — it does **not** bundle Pi, Node, or your
model credentials.

- **Pi** installed and configured: `npm i -g @earendil-works/pi-coding-agent`
  (Mari looks for `pi` on your PATH / `~/.local/bin`; configure a different path
  in Settings). Your providers/models are whatever `pi` already has.
- **Node** (Pi is a `#!/usr/bin/env node` script) and **[Bun](https://bun.sh)**
  (package manager + the dev bridge runtime).
- **Rust** + **Xcode** (to build the Tauri app / regenerate the icon).

## Quick start

```sh
bun install

# The full desktop app (spawns pi via the Rust core):
bun run tauri dev

# Fast browser iteration (no native rebuild): run the dev bridge, then Vite.
bun run dev                 # Vite on :1420
bun dev/pi-bridge.ts        # WebSocket bridge on :4317 (spawns one pi per session)
```

The desktop app talks to Pi through the Rust core (Tauri IPC). The browser path
swaps that for a small WebSocket bridge so you can iterate on the UI without
recompiling Rust. Same frontend, two transports — see `src/lib/pi/client.ts`.

## Build & install

```sh
bun run tauri build        # -> src-tauri/target/release/bundle/macos/mari.app (+ .dmg)
```

The app is **not notarized** (yet), so first launch needs the one-time
right-click → **Open** to get past Gatekeeper.

## What's inside

| Area | Where |
| --- | --- |
| Session engine (one `pi` process per session) | `src/hooks/usePiSession.ts` |
| Session manager / warm pool / tab mounting | `src/App.tsx` |
| RPC client + transports (Tauri IPC / WS bridge) | `src/lib/pi/client.ts` |
| Event → view-state reducer | `src/lib/pi/reducer.ts` |
| Rust process manager (`pi_start`/`send`/`stop`, fs watch) | `src-tauri/src/pi.rs` |
| Chat surface (composer, conversation, pickers) | `src/components/chat/` |
| Settings (persistence + panel) | `src/lib/settings.ts`, `src/components/chat/SettingsDialog.tsx` |
| App icon source + pipeline | `src-tauri/icons/source/` |

For architecture, conventions, and the non-obvious bits, read **[AGENTS.md](AGENTS.md)**.

## Settings

Gear in the sidebar footer: theme (system/light/dark), default working dir,
default model + thinking level, the `pi` binary path + extra PATH dirs (fixes
"disconnected" when launched from `/Applications`), and the warm-session-pool
size. Persisted in `localStorage`.

## Updates

Auto-updates ship via GitHub Releases (signed with Tauri's updater key). Toggle
in Settings → About. See [AGENTS.md](AGENTS.md#releases--updates) for cutting a
release.

## License

TBD.
