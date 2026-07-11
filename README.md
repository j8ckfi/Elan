# Elan

Super, super beta. Mostly slop right now.

Elan is a **singleplayer agent orchestrator** shaped like Linear crossed with
Slack — an issue tracker where the assignees are your model subscriptions.
File work, tag agents into it, and watch them plan, implement, review, and
merge on a shared board. 

Start here: **[docs/ELAN.md](docs/ELAN.md)** — the product, the kernel, the
glossary, and the locked design decisions.

## Quick start

```sh
bun install

# Fast browser iteration (no native rebuild):
bun run dev                 # Vite on :1420

# The full desktop app (spawns agent CLIs via the Rust core):
bun run tauri dev
```

## Inherited architecture

This repo keeps Mari's neutral core and per-CLI adapter seam intact:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — dataflow, session model,
  the two runtimes, the hosts.
- **[docs/ADAPTERS.md](docs/ADAPTERS.md)** — the one seam: how to point Elan
  at a new agent CLI.

For everything else — the data model, orchestration (tag → spawn, the `elan`
CLI, worktrees), and Elan's design language — see [AGENTS.md](AGENTS.md) and
the rest of `docs/`.
