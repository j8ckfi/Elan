// The BoardStore rules module + the browser (localStorage) implementation.
// Contract and enforced rules live in docs/DATA-MODEL.md — keep the two in
// sync. Three stores share createBoardStore: this file's createLocalStore,
// the host's file-backed store (dev/elan-host.ts), and the UI's host client
// (host-store.ts) which proxies to the host instead of using it directly.

import { emptyState } from "./seed";
import {
  parseMentions,
  USER,
  type AgentSessionRecord,
  type RosterEntry,
  type Attachment,
  type Author,
  type BoardEvent,
  type BoardState,
  type Post,
  type Project,
  type Thread,
} from "./types";

// v3: v2 could hold records persisted by mid-refactor dev builds (posts
// missing `attachments`, pre-rename roster entries). Bumping the key
// abandons them; normalizeState() below keeps future drift from crashing.
const STORAGE_KEY = "elan.board.v3";
const PERSIST_DEBOUNCE_MS = 150;

export interface BoardStore {
  getState(): BoardState;
  subscribe(cb: () => void): () => void;

  createProject(input: {
    name: string;
    repoPath: string;
    key?: string;
    color?: string;
    /** Client-minted id (host clients pre-mint so optimistic state and the
     *  host's authoritative state agree). Minted here when absent. */
    id?: string;
  }): Project;
  createThread(input: {
    projectId: string;
    title: string;
    body: string;
    createdBy?: Author;
    id?: string;
  }): Thread;
  updateThread(
    id: string,
    patch: Partial<
      Pick<Thread, "title" | "body" | "status" | "labels" | "worktreePath">
    >,
    actor: Author,
  ): void;
  /** Removes the thread and all its posts/events/sessions. Emits no event. */
  deleteThread(id: string): void;
  /** Removes the project and everything under it (threads and their
   *  posts/events/sessions). Emits no event. The escape hatch back to
   *  Welcome when the last project goes. */
  deleteProject(id: string): void;
  addPost(input: {
    threadId: string;
    author: Author;
    body: string;
    replyTo?: string;
    kind?: Post["kind"];
    attachments?: Attachment[];
    id?: string;
    /** Skip @mention → tagged-event parsing. Host-side only: fallback posts
     *  the host files on an agent's behalf must never trigger spawns. */
    suppressTags?: boolean;
  }): Post;
  addEvent(input: Omit<BoardEvent, "id" | "at">): BoardEvent;
  /** Add or replace a session record by id. Host-side (the orchestrator's
   *  bookkeeping); UI clients only ever read sessions. Emits no event. */
  upsertSession(record: AgentSessionRecord): void;
  /** Replace the roster wholesale (the roster editor saves the full list).
   *  Validates: unique non-empty handles; "user" is reserved. Invalid
   *  entries are dropped, not thrown — the board must never wedge. */
  setRoster(roster: RosterEntry[]): void;
}

// Globally-unique ids. NOT a module counter: state can be hydrated from disk
// (ids already assigned) and HMR would reset a counter to 0, reissuing an id
// that collides with hydrated data. A UUID can never collide.
function nextId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// "Elan Orchestrator" → "EO", "engram" → "ENG"; de-duped with a numeric
// suffix against existing keys.
function deriveKey(name: string, taken: Set<string>): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const base =
    (words.length >= 2
      ? words.map((w) => w[0]).join("")
      : name.slice(0, 3)
    )
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4) || "PRJ";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

const PROJECT_COLORS = ["#5e6ad2", "#7c6df2", "#0f9d8f", "#d97706", "#b5487a"];

export interface BoardStoreOptions {
  initial: BoardState;
  /** Called with the new state after every mutation. Debounce inside the
   *  callback if the medium wants it (localStorage does, a file might). */
  persist: (state: BoardState) => void;
}

/** The rules module: every mutation, every store-enforced invariant, written
 *  once. Implementations differ only in where state comes from and goes. */
export function createBoardStore({ initial, persist }: BoardStoreOptions): BoardStore {
  let state = initial;
  const subscribers = new Set<() => void>();

  function setState(next: BoardState) {
    state = next;
    persist(state);
    for (const cb of subscribers) cb();
  }

  /** Re-parent a reply to a top-level post, per the one-level-deep rule. */
  function flattenReplyTo(replyTo: string | undefined): string | undefined {
    if (!replyTo) return undefined;
    const parent = state.posts.find((p) => p.id === replyTo);
    return parent?.replyTo ?? replyTo;
  }

  function touchThread(threads: Thread[], id: string, at: number): Thread[] {
    return threads.map((t) => (t.id === id ? { ...t, updatedAt: at } : t));
  }

  return {
    getState: () => state,

    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    createProject(input) {
      const taken = new Set(state.projects.map((p) => p.key));
      // Explicit keys are de-duped too — two "ENG" projects would make
      // ENG-1 ambiguous.
      let key = input.key?.toUpperCase() ?? deriveKey(input.name, taken);
      for (let n = 2; taken.has(key); n++)
        key = `${(input.key ?? key).toUpperCase().replace(/\d+$/, "")}${n}`;
      const project: Project = {
        id: input.id ?? nextId(),
        key,
        name: input.name,
        repoPath: input.repoPath,
        color:
          input.color ?? PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
        createdAt: Date.now(),
      };
      setState({ ...state, projects: [...state.projects, project] });
      return project;
    },

    createThread(input) {
      const now = Date.now();
      const number =
        state.threads
          .filter((t) => t.projectId === input.projectId)
          .reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const createdBy = input.createdBy ?? USER;
      const thread: Thread = {
        id: input.id ?? nextId(),
        projectId: input.projectId,
        number,
        title: input.title,
        body: input.body,
        status: "todo",
        labels: [],
        createdBy,
        createdAt: now,
        updatedAt: now,
      };
      const created: BoardEvent = {
        id: nextId(),
        threadId: thread.id,
        actor: createdBy,
        type: "created",
        payload: {},
        at: now,
      };
      setState({
        ...state,
        threads: [...state.threads, thread],
        events: [...state.events, created],
      });
      return thread;
    },

    updateThread(id, patch, actor) {
      const thread = state.threads.find((t) => t.id === id);
      if (!thread) return;
      const now = Date.now();
      const updated: Thread = { ...thread, ...patch, updatedAt: now };

      const events: BoardEvent[] = [];
      if (patch.status !== undefined && patch.status !== thread.status) {
        events.push({
          id: nextId(),
          threadId: id,
          actor,
          type: "status",
          payload: { from: thread.status, to: patch.status },
          at: now,
        });
      }
      setState({
        ...state,
        threads: state.threads.map((t) => (t.id === id ? updated : t)),
        events: [...state.events, ...events],
      });
    },

    deleteProject(id) {
      const threadIds = new Set(
        state.threads.filter((t) => t.projectId === id).map((t) => t.id),
      );
      setState({
        ...state,
        projects: state.projects.filter((p) => p.id !== id),
        threads: state.threads.filter((t) => !threadIds.has(t.id)),
        posts: state.posts.filter((p) => !threadIds.has(p.threadId)),
        events: state.events.filter((e) => !threadIds.has(e.threadId)),
        sessions: state.sessions.filter((s) => !threadIds.has(s.threadId)),
      });
    },

    deleteThread(id) {
      setState({
        ...state,
        threads: state.threads.filter((t) => t.id !== id),
        posts: state.posts.filter((p) => p.threadId !== id),
        events: state.events.filter((e) => e.threadId !== id),
        sessions: state.sessions.filter((s) => s.threadId !== id),
      });
    },

    addPost(input) {
      const now = Date.now();
      const post: Post = {
        id: input.id ?? nextId(),
        threadId: input.threadId,
        author: input.author,
        body: input.body,
        createdAt: now,
        replyTo: flattenReplyTo(input.replyTo),
        kind: input.kind ?? "comment",
        attachments: input.attachments ?? [],
      };

      const mentions = input.suppressTags
        ? []
        : parseMentions(input.body, state.roster).filter(
            (handle) => handle !== input.author,
          );
      const tagged: BoardEvent[] = mentions.map((handle) => ({
        id: nextId(),
        threadId: input.threadId,
        actor: input.author,
        type: "tagged",
        payload: { handle },
        at: now,
      }));

      setState({
        ...state,
        posts: [...state.posts, post],
        events: [...state.events, ...tagged],
        threads: touchThread(state.threads, input.threadId, now),
      });
      return post;
    },

    addEvent(input) {
      const event: BoardEvent = { ...input, id: nextId(), at: Date.now() };
      setState({ ...state, events: [...state.events, event] });
      return event;
    },

    setRoster(roster) {
      const seen = new Set<string>(["user"]);
      const clean = roster.filter((r) => {
        const handle = (r.handle ?? "").trim();
        if (!handle || !r.harness || seen.has(handle)) return false;
        seen.add(handle);
        return true;
      });
      setState({ ...state, roster: clean });
    },

    upsertSession(record) {
      const exists = state.sessions.some((s) => s.id === record.id);
      setState({
        ...state,
        sessions: exists
          ? state.sessions.map((s) => (s.id === record.id ? record : s))
          : [...state.sessions, record],
      });
    },

  };
}

// ── Hostile-input normalization ──────────────────────────────────────────

// localStorage / a state file is external input (older builds, other tabs,
// hand edits) — normalize every record on the way in so a stale shape
// degrades to a dropped record, never a render crash. The error boundary is
// the last line of defense, not the first.
export function normalizeState(parsed: Partial<BoardState>): BoardState {
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const rec = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v != null;
  const str = (v: unknown): v is string => typeof v === "string";
  const num = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  const VALID_STATUS = new Set(["todo", "in_progress", "in_review", "done", "canceled"]);
  const threads = arr<Thread>(parsed.threads).filter(
    (t) =>
      rec(t) && str(t.id) && str(t.projectId) && str(t.title) &&
      str(t.status) && VALID_STATUS.has(t.status) &&
      num(t.createdAt) && num(t.updatedAt),
  );
  const threadIds = new Set(threads.map((t) => t.id));

  return {
    projects: arr<BoardState["projects"][number]>(parsed.projects).filter(
      (p) => rec(p) && str(p.id) && str(p.key) && str(p.name),
    ),
    roster: arr<BoardState["roster"][number]>(parsed.roster).filter(
      (r) => rec(r) && str(r.handle) && str(r.harness),
    ),
    threads: threads.map((t) => ({
      ...t,
      body: str(t.body) ? t.body : "",
      labels: arr<string>(t.labels).filter(str),
    })),
    posts: arr<Post>(parsed.posts)
      .filter(
        (p) =>
          rec(p) && str(p.id) && str(p.author) && str(p.body) &&
          num(p.createdAt) && str(p.threadId) && threadIds.has(p.threadId),
      )
      .map((p) => ({
        ...p,
        kind: p.kind === "resolution" ? "resolution" : "comment",
        attachments: arr<Attachment>(p.attachments).filter(
          (a) => rec(a) && str(a.name) && str(a.path),
        ),
        replyTo: str(p.replyTo) ? p.replyTo : undefined,
      })),
    events: arr<BoardEvent>(parsed.events)
      .filter(
        (e) =>
          rec(e) && str(e.id) && str(e.actor) && str(e.type) &&
          num(e.at) && str(e.threadId) && threadIds.has(e.threadId),
      )
      .map((e) => ({ ...e, payload: rec(e.payload) ? e.payload : {} })),
    sessions: arr<BoardState["sessions"][number]>(parsed.sessions).filter(
      (s) =>
        rec(s) && str(s.id) && str(s.handle) && str(s.state) &&
        str(s.threadId) && threadIds.has(s.threadId),
    ),
  };
}

// ── The browser store ────────────────────────────────────────────────────

function loadState(): BoardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<BoardState> | null;
    if (!parsed || !Array.isArray(parsed.threads)) return emptyState();
    return normalizeState(parsed);
  } catch {
    // Corrupt JSON, quota weirdness, whatever — never throw. Empty, not
    // demo: a user's first board must be their own (docs/DATA-MODEL.md).
    return emptyState();
  }
}

export function createLocalStore(): BoardStore {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  return createBoardStore({
    initial: loadState(),
    persist(state) {
      if (persistTimer != null) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
          // Best-effort; a full quota shouldn't crash the app.
        }
      }, PERSIST_DEBOUNCE_MS);
    },
  });
}
