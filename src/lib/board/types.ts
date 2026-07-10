// The board's entities — the contract everything renders from.
// Rationale and rules live in docs/DATA-MODEL.md; keep the two in sync.

/** The literal "user" is the human (singleplayer — exactly one). Anything
 *  else is a roster handle ("fable-5"). "user" is a reserved handle. */
export type Author = string;

export const USER: Author = "user";

export interface Project {
  id: string;
  /** Short uppercase slug for thread numbers: "ENG" → ENG-12. */
  key: string;
  name: string;
  /** Absolute path to the bound repo. */
  repoPath: string;
  /** Hex tint for the project glyph. */
  color: string;
  createdAt: number;
}

export interface RosterEntry {
  /** "fable-5" — no "@" in data; "@" is syntax. */
  handle: string;
  /** Adapter id: "claude-code" | "codex" | "mock" | … */
  harness: string;
  /** Harness-specific model flag value, if pinned. */
  model?: string;
  /** Avatar tint. */
  color: string;
}

export type ThreadStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

export interface Thread {
  id: string;
  projectId: string;
  /** Per-project sequence; renders as `${project.key}-${number}`. */
  number: number;
  title: string;
  /** Markdown; image attachments referenced by path. */
  body: string;
  status: ThreadStatus;
  labels: string[];
  createdBy: Author;
  createdAt: number;
  /** Any post/event bumps this. */
  updatedAt: number;
  /** Set on first tag; see docs/ORCHESTRATION.md. */
  worktreePath?: string;
}

export interface Attachment {
  name: string;
  path: string;
}

export interface Post {
  id: string;
  threadId: string;
  author: Author;
  /** Markdown; @handle mentions are plain text, parsed at render/mutation. */
  body: string;
  createdAt: number;
  /** Parent post id → this post lives inside that exchange. One level deep
   *  only: the store re-parents deeper chains to the top-level post. */
  replyTo?: string;
  /** "resolution" is the ⚑ post that closes an exchange; anyone may file one. */
  kind: "comment" | "resolution";
  attachments: Attachment[];
}

export type BoardEventType =
  | "created"
  | "status"
  | "tagged"
  | "session-start"
  | "session-end"
  | "artifact"
  | "label";

/** System activity lines — separate from posts (they group differently and
 *  never have replies), interleaved with posts by time in the feed. */
export interface BoardEvent {
  id: string;
  threadId: string;
  actor: Author;
  type: BoardEventType;
  payload: Record<string, unknown>;
  at: number;
}

export type SessionState =
  | "queued"
  | "spawning"
  | "running"
  | "waiting"
  | "done"
  | "error";

export interface AgentSessionRecord {
  id: string;
  threadId: string;
  handle: string;
  state: SessionState;
  /** Live engine process key while running. */
  procKey?: string;
  /** Harness-native id, for --resume. */
  harnessSessionId?: string;
  /** Armed wake condition while state === "waiting". */
  wakeOn?: { event: "session-end" | "post"; handle?: string };
  /** The tagged/wake event this session answers — durable-intent marker:
   *  an event is handled iff a session carries its id here. */
  triggerEventId?: string;
  /** Why the session is in its terminal state ("timeout",
   *  "runner-not-found", "orphaned-by-restart", …). */
  reason?: string;
  exitCode?: number;
  /** Full stdout+stderr transcript on the host's disk. */
  logPath?: string;
  queuedAt?: number;
  startedAt: number;
  endedAt?: number;
}

export interface BoardState {
  projects: Project[];
  /** Global roster for now; per-project later. */
  roster: RosterEntry[];
  threads: Thread[];
  posts: Post[];
  events: BoardEvent[];
  sessions: AgentSessionRecord[];
}

// ── Derived helpers (pure; shared by UI and context rendering) ──────────────

/** A top-level post plus its replies, ordered by time. Not stored — derived. */
export interface Exchange {
  root: Post;
  replies: Post[];
  /** Latest resolution post among root+replies, if any ⇒ exchange is resolved. */
  resolution?: Post;
}

/** Group a thread's posts into exchanges (top-level order preserved). */
export function toExchanges(posts: Post[]): Exchange[] {
  const roots = posts.filter((p) => !p.replyTo);
  const byParent = new Map<string, Post[]>();
  for (const p of posts) {
    if (!p.replyTo) continue;
    const list = byParent.get(p.replyTo) ?? [];
    list.push(p);
    byParent.set(p.replyTo, list);
  }
  return roots.map((root) => {
    const replies = (byParent.get(root.id) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    const resolution = [...replies, root]
      .filter((p) => p.kind === "resolution")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return { root, replies, resolution };
  });
}

/** Distinct participants of an exchange, in first-appearance order. */
export function exchangeParticipants(x: Exchange): Author[] {
  const seen = new Set<Author>();
  const out: Author[] = [];
  for (const p of [x.root, ...x.replies]) {
    if (!seen.has(p.author)) {
      seen.add(p.author);
      out.push(p.author);
    }
  }
  return out;
}

/** Parse @handle mentions in a body against the roster. */
export function parseMentions(body: string, roster: RosterEntry[]): string[] {
  const handles = new Set(roster.map((r) => r.handle));
  const out = new Set<string>();
  for (const m of body.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)) {
    const h = m[1].toLowerCase();
    if (handles.has(h)) out.add(h);
  }
  return [...out];
}
