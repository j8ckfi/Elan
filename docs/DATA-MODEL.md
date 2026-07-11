# Data model

The board's entities and the store contract. Canonical types live in
`src/lib/board/types.ts`; this doc is the rationale and the contract.

## Entities

```ts
// Authors: the literal "user" is the human (singleplayer — exactly one).
// Anything else is a roster handle ("fable-5"). "user" is a reserved handle.
export type Author = string;

export interface Project {
  id: string;            // uuid
  key: string;           // short uppercase slug for thread numbers: "ENG"
  name: string;
  repoPath: string;      // absolute path to the bound repo
  color: string;         // hex, drives project glyph tint
  createdAt: number;     // epoch ms everywhere
}

export interface RosterEntry {
  handle: string;        // "fable-5" — no "@" in data, "@" is syntax
  harness: string;       // adapter id: "claude-code" | "codex" | "mock" | …
  model?: string;        // harness-specific model flag value
  color: string;         // avatar tint
}

export type ThreadStatus =
  | "todo" | "in_progress" | "in_review" | "done" | "canceled";

export interface Thread {
  id: string;
  projectId: string;
  number: number;        // per-project sequence → "ENG-12"
  title: string;
  body: string;          // markdown; image attachments referenced by path
  status: ThreadStatus;
  labels: string[];
  createdBy: Author;
  createdAt: number;
  updatedAt: number;     // any post/event bumps this
  worktreePath?: string; // set on first tag (see ORCHESTRATION.md)
}

export interface Attachment {
  name: string;
  path: string;          // file path (repo- or app-data-relative)
}

export interface Post {
  id: string;
  threadId: string;
  author: Author;
  body: string;          // markdown; @handle mentions are plain text, parsed at render
  createdAt: number;
  replyTo?: string;      // parent post id → this post lives inside an exchange.
                         // One level deep only: a replyTo must point at a
                         // top-level post (store enforces by re-parenting).
  kind: "comment" | "resolution";  // resolution = the ⚑ post; anyone can file one
  attachments: Attachment[];
}

// Activity lines. Separate from posts (Linear does the same): they're
// system-generated, dedupe/group differently, and never have replies.
export type BoardEventType =
  | "created"        // payload: {}
  | "status"         // payload: { from: ThreadStatus; to: ThreadStatus }
  | "tagged"         // payload: { handle: string }  (actor tagged handle)
  | "session-start"  // payload: { sessionId: string; handle: string }
  | "session-end"    // payload: { sessionId: string; handle: string; outcome: "done"|"error"|"waiting" }
  | "artifact"       // payload: { attachment: Attachment }
  | "label";         // payload: { added?: string; removed?: string }

export interface BoardEvent {
  id: string;
  threadId: string;
  actor: Author;
  type: BoardEventType;
  payload: Record<string, unknown>;
  at: number;
}

export type SessionState =
  | "queued" | "spawning" | "running"
  | "idle"     // hot: alive/resumable, no turn in flight — the steady state
  | "waiting"  // legacy (pre-hot wake model); normalized to idle on host boot
  | "done"     // legacy; hot sessions never finish, they idle
  | "error";

export interface AgentSessionRecord {
  id: string;
  threadId: string;
  handle: string;
  state: SessionState;
  procKey?: string;      // live engine process key while running
  harnessSessionId?: string; // for --resume
  wakeOn?: { event: "session-end" | "post"; handle?: string }; // waiting state
  triggerEventId?: string; // durable intent (legacy claim; see turns)
  // The hot model's turn queue: ONE session per (thread, handle), forever;
  // every ping becomes a turn. An event is handled iff some record's
  // turns[] carries it (or legacy triggerEventId matches).
  turns?: Array<{ eventId: string; state: "pending" | "done" | "failed"; at: number }>;
  reason?: string;       // terminal-state cause ("timeout", "runner-not-found", …)
  exitCode?: number;
  logPath?: string;      // full transcript on the host's disk
  queuedAt?: number;
  startedAt: number;
  endedAt?: number;
}
```

## Derived: exchanges

An **exchange** is not stored — it's a top-level post plus all posts with
`replyTo` pointing at it, ordered by time. An exchange is **resolved** when it
contains a `kind: "resolution"` post (the latest one wins as the summary).

Two consumers of resolution state:

1. **UI**: resolved exchanges collapse to one line: `▸ N replies · a ⇄ b ·`
   the resolution text.
2. **Context rendering** (ORCHESTRATION.md): resolved exchanges inject only
   the resolution line into a newly tagged agent's context; the full exchange
   is fetchable via `elan read <post-id>`.

## The store contract

`src/lib/board/store.ts`. UI consumes it via `useSyncExternalStore`; the
implementation is swappable (v1 below, later a host-backed one).

```ts
export interface BoardState {
  projects: Project[];
  roster: RosterEntry[];          // global roster for now; per-project later
  threads: Thread[];
  posts: Post[];
  events: BoardEvent[];
  sessions: AgentSessionRecord[];
}

export interface BoardStore {
  getState(): BoardState;
  subscribe(cb: () => void): () => void;

  createProject(input: { name: string; repoPath: string;
    key?: string; color?: string }): Project;  // key derived from name when absent
  createThread(input: { projectId: string; title: string; body: string;
    createdBy?: Author }): Thread;
  updateThread(id: string, patch: Partial<Pick<Thread,
    "title" | "body" | "status" | "labels">>, actor: Author): void;
  // Removes the thread and all its posts/events/sessions. Emits no event.
  deleteThread(id: string): void;
  // Removes the project and everything under it. The escape hatch back to
  // Welcome when the last project goes.
  deleteProject(id: string): void;
  addPost(input: { threadId: string; author: Author; body: string;
    replyTo?: string; kind?: Post["kind"]; attachments?: Attachment[];
    suppressTags?: boolean /* host-only: fallback posts never spawn */ }): Post;
  addEvent(input: Omit<BoardEvent, "id" | "at">): BoardEvent;
  /** Host-side session bookkeeping; UI clients only read sessions. */
  upsertSession(record: AgentSessionRecord): void;
  /** Replace the roster wholesale (the roster editor saves the full list).
   *  Store validates: unique non-empty handles, "user" reserved. */
  setRoster(roster: RosterEntry[]): void;
}
```

Three implementations share one rules module (`createBoardStore(opts)` in
`src/lib/board/store.ts` — mutations, mention parsing, event emission written
once): `createLocalStore()` (localStorage, browser-only mode), the **host**'s
store (same module in Bun, persisted to `.elan/board.json` — see
ORCHESTRATION.md), and `createHostStore(url)`
(`src/lib/board/host-store.ts`) — the UI's client when a host is present
(REST mutations, WS full-state subscription).

Rules the store enforces (not the callers):

- `updateThread` with a `status` change emits the `status` BoardEvent itself.
- `addPost` bumps the thread's `updatedAt`; a `replyTo` chain is flattened to
  the top-level parent (one level deep, always).
- `addPost` scans the body for `@handle` mentions against the roster and
  emits `tagged` events. Self-mentions by the same author are ignored.
- **A reply to an agent's exchange implicitly tags that agent** — a reply
  is a message to its author. Deduped against explicit mentions; never for
  self-replies, human-rooted exchanges, or host-fallback (suppressTags)
  posts.

## Persistence & first run

`createLocalStore()` — in-memory state, JSON-serialized to
`localStorage["elan.board.v3"]` on every mutation (debounced), hydrated on
boot. **An absent or corrupt key falls back to `emptyState()`** — no
projects, the default roster (`defaultRoster()` in seed.ts), nothing else.
There is no demo board in the product (removed 2026-07-10 — it blocked
first-run testing and risked spawning real sessions on fictional history);
`seedState()` survives purely as the tests' rich fixture. Never seed data
implicitly: a user's first board must be their own.

`deleteThread` removes a thread and every post/event/session scoped to it in
one mutation; unlike `updateThread`, it emits no BoardEvent (there's no
thread left to log activity against).

Seed data must exercise every rendering path: multiple projects, threads in
every status, a thread with a long resolved agent-vs-agent exchange, an
unresolved live exchange, artifacts, and system events of each type.
