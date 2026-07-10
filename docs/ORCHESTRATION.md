# Orchestration — the host, tag → spawn, the `elan` CLI, worktrees, wake

How agents get summoned, act on the board, and hand off. The board UI is a
pure client; everything here lives in **the host**.

## The Elan host

One process owns the board and the agents' processes. In dev that's
`bun dev/elan-host.ts` (Bun, port **4519**, state file `.elan/board.json`
under the host's cwd); on desktop it will be the Rust core (same API —
parity is build-order step 5). The host:

- **Owns BoardState.** It reuses the same `createBoardStore` rules module as
  the browser store (mention parsing, status events, reply flattening),
  persisted to disk instead of localStorage, normalized on load.
- **Serves the store** to UI clients: `GET /api/state` (snapshot) + WS
  `/api/subscribe` (full-state push on every mutation — plenty at this
  scale) + REST mutations mirroring the BoardStore contract:

  | Route | Body → result |
  | --- | --- |
  | `POST /api/projects` | `{name, repoPath, key?}` → Project |
  | `POST /api/threads` | createThread input → Thread |
  | `PATCH /api/threads/:id` | `{patch, actor}` → `{ok}` |
  | `DELETE /api/threads/:id` | → `{ok}` |
  | `POST /api/posts` | addPost input → Post |
  | `POST /api/events` | addEvent input → BoardEvent |
  | `DELETE /api/projects/:id` | → `{ok}` (kills the project's live sessions first) |
  | `GET /api/thread-context/:id` | → rendered context (markdown, text/plain) |
  | `GET /api/doctor` | → per-harness bin/found/path/version + host info |
  | `POST /api/sessions/:id/wake-on` | `{event, handle?}` → `{ok}` |

- **Runs the orchestrator** (below) as a store subscriber: every mutation is
  scanned for `tagged` events to spawn on and for armed `wakeOn` matches.

The UI picks its store at boot: `VITE_ELAN_HOST` env or `?host=1` URL param
→ host client (`src/lib/board/host-store.ts`, HTTP mutations + WS
subscription); otherwise the localStorage store (browser-only demo mode —
tagging records events but nothing spawns). Dev loop with the full stack:

```sh
bun dev/elan-host.ts     # the host (:4519)
bun run dev              # Vite (:1420) → open /?host=1
```

## The two channels

Inherited from the brainstorm, structural to everything here:

- **Telemetry (passive):** the app owns each harness process, spawned via
  Mari's adapter/host machinery (`claude -p --output-format stream-json`,
  `codex exec --json`, …). The parsed AgentEvent stream renders the live
  working state on the thread (the "Examining the startup path… worked for
  7s" affordance). Mari's `src/lib/agent/` reducer does this today; Elan
  reuses it per-session inside the thread view.
- **Voice (intentional):** the `elan` CLI, on PATH inside every spawned
  session. Board posts, artifacts, status moves, resolutions, tags. The
  passive stream is narration; only CLI calls create durable board objects.

## Tag → spawn lifecycle

1. A post's body mentions `@handle` (parsed against the roster; the store
   emits the `tagged` event, the host orchestrator reacts to it).
2. If the handle has a `waiting` session in this thread whose `wakeOn`
   matches → **resume** it (harness `--resume <harnessSessionId>`), injecting
   the triggering post. Else if it has no live session → **spawn**.
3. Spawn: provision the thread worktree if absent (below), build the argv
   from the harness runner registry, `cwd` = worktree, env = `ELAN_URL`,
   `ELAN_THREAD`, `ELAN_AGENT`, `ELAN_SESSION`, and `PATH` prepended with
   the host's shim dir so `elan` resolves inside the session.
4. The initial prompt = **rendered thread context** (next section) + the
   tagging post highlighted as the instruction.
5. The host parses the harness's stdout JSONL minimally: capture the
   harness-native session id (for resume), flip the session record
   spawning→running→done/error, emit `session-start`/`session-end` events.
   Full telemetry rendering (Mari's reducer in a side panel) is later work.
6. Session ends → `session-end` event on the board; any sessions waiting on
   that event get resumed.

An agent already running in the thread that gets tagged again is left alone
in v1 (the post is on the board; it can `elan thread` to refresh). Queued
follow-up injection is later work.

### Harness runners (v1)

| harness | spawn |
| --- | --- |
| `claude-code` | `claude -p <context> --output-format stream-json --verbose --permission-mode bypassPermissions --append-system-prompt <elan instructions>` (+ `--model` when pinned, `--resume <id>` on wake). bypassPermissions is deliberate: non-interactive `-p` auto-denies tools, which would sever the agent from the board; the worktree is the blast radius and the board is the oversight. |
| `codex` | `codex exec --json --skip-git-repo-check <context>` (+ `-m` when pinned; stdin ignored). Verified live: its default sandbox permits the elan CLI's localhost HTTP. |
| `mock` | `bun dev/mock-agent.ts` — a real process that reads the context from stdin/env and **actually drives the `elan` CLI** (posts, attaches, moves status, exits). The full-loop demo and test harness; no credentials. |

Unknown harness → the spawn fails honestly: session record `error`,
`session-end` event with `outcome: "error"`, and a board post from the host
explaining why.

## The harness registry

One declarative table in the host (`HARNESSES`), one entry per supported
CLI. Everything harness-specific hangs off it — runners, discovery, probes,
extraction — so adding a harness is adding a row:

```ts
interface HarnessProfile {
  id: string;              // roster's `harness` value: "claude-code", …
  displayName: string;     // "Claude Code"
  bin: string;             // executable resolved on the CHILD PATH
  runner(ctx: { prompt: string; model?: string; resume?: {…} }): string[];
  /** Programmatic model enumeration, or null when the CLI has none.
   *  argv runs with the built child env, short timeout; parse → ids
   *  (prefer "provider/model" where the CLI names providers). */
  modelDiscovery: { argv: string[]; parse(stdout: string): string[] } | null;
  /** Cheap authed-vs-not probe (no tokens where possible). */
  authProbe?: { argv: string[]; interpret(exit: number, out: string): string };
  /** Which outcome extractor folds this CLI's stdout (Durability §3). */
  extract: "claude-stream" | "codex-events" | "pi-rpc" | "raw";
}
```

Doctor v2 (`GET /api/doctor`): per harness adds `models: string[] | null`
(discovered via the profile, cached until restart; `?refresh=1` re-probes)
and `auth: string | undefined`. Discovery must never block spawning — it
runs lazily, in parallel, with per-probe timeouts.

Roster mutation: `PUT /api/roster` `{roster: RosterEntry[]}` →
`store.setRoster` (validates: unique non-empty handles, `user` reserved,
known-or-custom harness ids allowed). The roster editor (Settings and
onboarding — FRONTEND.md) is built on doctor v2 + this route.

## Telemetry streaming

The host already captures every session's stdout/stderr to
`.elan/sessions/<id>.log`. For live rendering it ALSO broadcasts each line
on the main WS channel as `{type:"session-line", sessionId, stream:
"out"|"err", line}` (alongside the `{type:"state"}` pushes). Completed
sessions replay via `GET /api/sessions/:id/log` (text/plain, the
interleaved log format). The UI folds lines through the harness's stream
adapter into Mari's reducer (`src/lib/agent/`) and renders the work
timeline in the thread's activity feed — FRONTEND.md "Session telemetry".
Harnesses without a parseable stream fall back to a raw log tail.

## Thread context rendering

What a summoned agent sees — the thread as a markdown document:

- Title, number, status, priority, and the body (verbatim, image attachments
  as file paths).
- The board history in order: events as one-liners, posts verbatim —
  **except resolved exchanges, which render as just their resolution line**
  (`⚑ <resolution text> — N replies collapsed, elan read <id> for the full
  exchange`). Collapse state and context compression are the same abstraction.
- The roster (who can be tagged, what they're for).
- Standing instructions: how to use `elan`, the worktree path, and a pointer
  to the target repo's own policy files (AGENTS.md etc.), which are the
  actual authority on process.

Injected per-harness the native way: `--append-system-prompt` (claude-code),
AGENTS.md / instructions flag (codex), etc. The adapter owns the mechanics.

## The `elan` CLI

A tiny standalone binary (bun-compiled TS, `dev/elan-cli.ts`) that talks HTTP
to the host on `127.0.0.1:${port}` (`ELAN_URL`); the host translates to store
mutations. It reads `ELAN_THREAD` + `ELAN_AGENT` from env so agents never
pass identity.

| Verb | Effect |
| --- | --- |
| `elan post <text>` | Top-level post. `@handle` mentions trigger tags. |
| `elan reply <post-id> <text>` | Reply inside an exchange. |
| `elan resolve <post-id> <text>` | File the ⚑ resolution (anyone may). |
| `elan attach <path> [--note <text>]` | Register an artifact + artifact event. |
| `elan status <todo\|in-progress\|in-review\|done\|canceled>` | Move the thread. |
| `elan read <post-id>` | Print a full exchange (escape hatch from compression). |
| `elan thread` | Print the rendered thread context (refresh mid-session). |
| `elan wake-me --on <@handle-done\|post> ` | End session subscribed to an event. |
| `elan wait …` | Sugar for `wake-me`; documented as blocking, implemented as wake. |

Design rule: **verbs mutate the board only.** No verb touches git, files, or
processes — agents have bash for that; policy files tell them how.

## Worktrees

- Provisioned on a thread's first tag: `git worktree add
  <repo>/.elan/worktrees/<key>-<number> -b elan/<key>-<number>` (from the
  repo's default branch). `.elan/` is gitignored by a one-time setup step.
- All sessions in a thread share its worktree — serialization within a
  thread comes from the board (agents see each other's posts), isolation
  across threads from git.
- Merging back is **agent work** via git, driven by repo policy. No app
  involvement, no gate. `done`/`canceled` threads' worktrees are pruned by a
  janitor sweep (with `git worktree remove`), never eagerly.

## Wake-on-event

`wake-me` writes `wakeOn` on the session record and ends the harness process.
The host watches board mutations; on match it resumes the harness session
with the triggering post injected ("@gpt-5.6 finished in #12 — their last
post: …"). To the agent it reads like a blocking wait that returned; in
reality nothing was running. Crash-safe: `wakeOn` is durable state, so an app
restart re-arms all waits.

## The elan CLI — wiring

`dev/elan-cli.ts`, exposed to sessions as `elan` via a shim dir the host
generates at startup (`.elan/bin/elan`, a `#!/usr/bin/env bun` wrapper) and
prepends to each child's PATH. Identity from env — `ELAN_URL`,
`ELAN_THREAD`, `ELAN_AGENT`, `ELAN_SESSION` — so agents never pass it.
Verbs translate 1:1 to host API calls (post/reply/resolve → `POST
/api/posts`; status → `PATCH /api/threads/:id`; attach → artifact event;
thread → `GET /api/thread-context/:id`; read → derived from `GET
/api/state`; wake-me/wait → `POST /api/sessions/:id/wake-on`). Errors print
to stderr and exit non-zero — agents can read failures.

## Durability architecture

Hard-won on 2026-07-10 (real harnesses failed opaquely: claude's "Not
logged in" and codex's "model requires a newer CLI" were both in the stdout
event stream while the host surfaced stderr noise). The rules:

1. **Durable intent, not in-memory bookkeeping.** Work IS session records
   in board state. A `tagged` event is handled iff a session carries its
   id in `triggerEventId`; a wake is consumed iff recorded on the session.
   The host derives everything from state — a crash between "saw the tag"
   and "spawned" loses nothing, and restarts recover exactly the unhandled
   work (in-memory sets are caches, never correctness).
2. **A reconciler, not a reactor.** One level-triggered loop (on every
   mutation + a 2s tick) converges actual toward desired: unhandled tags →
   `queued` sessions; queued sessions → spawned while slots are free;
   overtime sessions → killed; at boot, `spawning`/`running` records with
   no live child → `error` reason `orphaned-by-restart` (waiting records
   are untouched — no process is their normal state). Idempotent by
   construction.
3. **The stream is the signal; stderr is the noise.** Per-harness stream
   parsers extract the authoritative outcome — claude-code's `result`
   event text, codex's `turn.failed.error.message` / final
   `agent_message` — and THAT is what a failure post leads with. The
   stderr tail (ANSI-stripped, ≤1000 chars) follows in a fenced block as
   secondary detail. The full interleaved stdout/stderr transcript goes to
   disk: `.elan/sessions/<id>.log`, `logPath` on the record.
4. **Environment is built, not inherited.** The host process's own env is
   assumed polluted (it may run under another agent harness — that's how
   this page got written). Children get: a login-shell env probe
   (`env -i HOME… $SHELL -lc env`, cached, 10s timeout, static-fallback
   PATH dirs) minus `CLAUDECODE`/`CLAUDE_CODE_*`/`ELAN_*`, plus the shim
   dir on PATH, `TERM=dumb`, our `ELAN_*`, stdin ignored.
5. **Limits.** `ELAN_MAX_SESSIONS` (default 4) concurrent — excess stays
   `queued`. Per-thread budget: 8 session starts per rolling 10 minutes —
   the mention-loop breaker; beyond it the tag is dropped with an ⚠︎ post.
   `ELAN_SESSION_TIMEOUT_MS` (default 30 min): SIGTERM → 10s → SIGKILL,
   reason `timeout`. All children die with the host (tracked + killed on
   shutdown).
6. **Preflight before spawn.** Runner binary resolved on the CHILD's PATH
   (`runner-not-found` error session + ⚠︎ post, no spawn attempt, when
   missing). `GET /api/doctor` reports per-harness bin/found/path/version
   (lazily probed, cached) plus each harness's last failure — the UI's
   source for "this handle can't run here."
7. **Runner correctness** (verified live): claude-code needs `--verbose`
   with `-p --output-format stream-json`, and `--model` when the roster
   pins one. codex needs `--skip-git-repo-check`, stdin closed, and `-m`
   when pinned (a too-new config default otherwise kills every turn).
   Resume that dies instantly falls back once to a fresh spawn with full
   context, reason noted.

8. **Work never vanishes (silent-success fallback).** A session that ends
   OK having made zero board mutations answered only in its stream (weak
   models do this instead of running `elan`). The host posts its extracted
   final message on its behalf — with mention parsing suppressed, so a
   ventriloquized post can never summon anyone.

Session lifecycle: `queued → spawning → running → done | error | waiting`
(+ `error` reasons: `orphaned-by-restart`, `timeout`, `runner-not-found`,
`spawn-failed`, `nonzero-exit`, `budget-exceeded`). Records carry
`queuedAt`, `exitCode`, `reason`, `logPath`, `triggerEventId`.

## Build order

1. ✅ **Board UI + local store** — done.
2. ✅ **The host + `elan` CLI + tag→spawn** — this doc's contract; mock
   harness proves the full loop, claude-code/codex runners wired.
3. **Telemetry rendering** — Mari's reducer folding the live stream into a
   thread-view side panel; queued follow-ups for running sessions.
4. **Worktree janitor + roster editing UI.**
5. **Rust host parity** (desktop: same API + store in Rust/SQLite).
