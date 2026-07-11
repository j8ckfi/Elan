// The UI's client store when an Elan host is present. Same BoardStore
// contract as store.ts, but this implementation doesn't share the rules
// module — it proxies to the host over HTTP (mutations) + WebSocket (full-
// state subscription), per docs/DATA-MODEL.md / docs/ORCHESTRATION.md.
//
// Every mutation applies an optimistic local update (built to look exactly
// like what the rules module would produce) so the UI feels instant, then
// fires the real HTTP call. The host's next WS push is a full-state
// replace, so any optimistic guess is corrected — or dropped, on failure —
// within one round trip. We never optimistically add the *derived* events
// (created/tagged/status/…) a mutation triggers server-side; the WS push
// brings those, and adding our own guesses first would just cause flicker.

import { normalizeState, type BoardStore } from "./store";
import { emptyState } from "./seed";
import type { SessionLine } from "./telemetry";
import {
  USER,
  type BoardEvent,
  type BoardState,
  type Post,
  type Project,
  type Thread,
} from "./types";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

// ── Connection status ────────────────────────────────────────────────────
// Module-level, not per-store: there's only ever one host store instance
// (useBoard.ts's singleton), and the UI needs to read/subscribe to this from
// outside the BoardStore contract (useHostStatus() in useBoard.ts) without
// threading a new method through every BoardStore implementation. Local mode
// never touches this module at all — see useHostStatus's null semantics.
export type HostStatus = "connecting" | "connected" | "disconnected";

let currentHostStatus: HostStatus = "connecting";
const hostStatusSubscribers = new Set<() => void>();

export function hostStatus(): HostStatus {
  return currentHostStatus;
}

export function subscribeHostStatus(cb: () => void): () => void {
  hostStatusSubscribers.add(cb);
  return () => hostStatusSubscribers.delete(cb);
}

function setHostStatus(next: HostStatus) {
  if (currentHostStatus === next) return;
  currentHostStatus = next;
  for (const cb of hostStatusSubscribers) cb();
}

// ── Session-line telemetry fan-out ───────────────────────────────────────
// Module-level for the same reason as the status above: the WS socket lives
// in the singleton host store, but session blocks subscribe per-session from
// component land (useSessionTelemetry) without widening the BoardStore
// contract. Each LIVE session keeps a bounded line buffer so a block that
// mounts mid-run still gets the prefix; buffers drop when the session
// leaves its live states (the full transcript is on disk from then on).

const SESSION_LINE_BUFFER_MAX = 2000;
const sessionLineSubscribers = new Map<string, Set<(line: SessionLine) => void>>();
const sessionLineBuffers = new Map<string, SessionLine[]>();

// The base URL the singleton store was created with — completed-session
// replay (GET /api/sessions/:id/log) fetches against the same host.
let currentHostBase: string | null = null;

export function hostBaseUrl(): string | null {
  return currentHostBase;
}

export function subscribeSessionLines(
  sessionId: string,
  cb: (line: SessionLine) => void,
): () => void {
  let set = sessionLineSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionLineSubscribers.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) sessionLineSubscribers.delete(sessionId);
  };
}

/** Lines received so far for a live session (the prefix a late subscriber
 *  missed). Bounded to the last {@link SESSION_LINE_BUFFER_MAX}. */
export function bufferedSessionLines(sessionId: string): readonly SessionLine[] {
  return sessionLineBuffers.get(sessionId) ?? [];
}

function dispatchSessionLine(sessionId: string, line: SessionLine): void {
  let buf = sessionLineBuffers.get(sessionId);
  if (!buf) {
    buf = [];
    sessionLineBuffers.set(sessionId, buf);
  }
  buf.push(line);
  if (buf.length > SESSION_LINE_BUFFER_MAX)
    buf.splice(0, buf.length - SESSION_LINE_BUFFER_MAX);
  const subs = sessionLineSubscribers.get(sessionId);
  if (subs) for (const cb of subs) cb(line);
}

function pruneSessionLineBuffers(state: BoardState): void {
  if (sessionLineBuffers.size === 0) return;
  const live = new Set(
    state.sessions
      .filter((s) => s.state === "queued" || s.state === "spawning" || s.state === "running")
      .map((s) => s.id),
  );
  for (const id of [...sessionLineBuffers.keys()])
    if (!live.has(id)) sessionLineBuffers.delete(id);
}

// Mirrors store.ts's palette — duplicated, not imported: this store doesn't
// share createBoardStore, and the guess only has to survive until the
// host's own (authoritative) color assignment arrives over WS.
const PROJECT_COLORS = ["#5e6ad2", "#7c6df2", "#0f9d8f", "#d97706", "#b5487a"];

// Same shape as store.ts's deriveKey — see that file for the rationale.
// Only used for the optimistic guess; the POST body carries the caller's
// original (possibly absent) `key`, so the host still derives canonically.
function guessKey(name: string, taken: Set<string>): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const base =
    (words.length >= 2 ? words.map((w) => w[0]).join("") : name.slice(0, 3))
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4) || "PRJ";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

function wsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/subscribe`;
}

export function createHostStore(baseUrl: string): BoardStore {
  const base = baseUrl.replace(/\/+$/, "");
  currentHostBase = base;
  let state: BoardState = emptyState();
  const subscribers = new Set<() => void>();

  function setState(next: BoardState) {
    state = next;
    for (const cb of subscribers) cb();
  }

  // Re-fetch the authoritative snapshot. Called after any failed mutation
  // (drops the optimistic entry naturally) and once at boot for a faster
  // first paint than waiting on the WS's first push.
  async function reconcile() {
    try {
      const res = await fetch(`${base}/api/state`);
      if (!res.ok) return;
      setState(normalizeState((await res.json()) as Partial<BoardState>));
    } catch (err) {
      console.error("[host-store] GET /api/state failed:", err);
    }
  }

  // Fire-and-forget mutation call. Never awaited by the sync BoardStore
  // methods — the optimistic update already ran.
  async function send(method: string, path: string, body?: unknown): Promise<void> {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`[host-store] ${method} ${path} failed:`, err);
      void reconcile();
    }
  }

  // ── WebSocket subscription, reconnect with backoff ──────────────────────
  // Status transitions: "connecting" is only the pre-first-contact default
  // (module init, below) — once any attempt resolves, status is only ever
  // "connected" or "disconnected". A drop sets "disconnected" and it STAYS
  // there across every backoff retry (not bounced back to "connecting" per
  // attempt) so the banner reads as one steady "still retrying", not a
  // flicker each time a doomed retry starts and fails.
  let backoff = RECONNECT_MIN_MS;
  function connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(base));
    } catch (err) {
      console.error("[host-store] WebSocket construction failed:", err);
      setHostStatus("disconnected");
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      backoff = RECONNECT_MIN_MS;
      setHostStatus("connected");
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type?: string;
          state?: unknown;
          sessionId?: string;
          stream?: string;
          line?: string;
        };
        if (msg.type === "state" && msg.state != null) {
          const next = normalizeState(msg.state as Partial<BoardState>);
          setState(next);
          pruneSessionLineBuffers(next);
        } else if (
          msg.type === "session-line" &&
          typeof msg.sessionId === "string" &&
          typeof msg.line === "string"
        ) {
          dispatchSessionLine(msg.sessionId, {
            stream: msg.stream === "err" ? "err" : "out",
            line: msg.line,
          });
        }
      } catch (err) {
        console.error("[host-store] bad WS message:", err);
      }
    });
    // An error is always followed by close; only close reschedules, so a
    // single failure never double-advances the backoff.
    ws.addEventListener("error", () => ws.close());
    ws.addEventListener("close", () => {
      setHostStatus("disconnected");
      scheduleReconnect();
    });
  }
  function scheduleReconnect() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }

  connect();
  void reconcile();

  return {
    getState: () => state,

    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },

    createProject(input) {
      const taken = new Set(state.projects.map((p) => p.key));
      const project: Project = {
        id: input.id ?? crypto.randomUUID(),
        key: (input.key ?? guessKey(input.name, taken)).toUpperCase(),
        name: input.name,
        repoPath: input.repoPath,
        color: input.color ?? PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
        createdAt: Date.now(),
      };
      setState({ ...state, projects: [...state.projects, project] });
      void send("POST", "/api/projects", { ...input, id: project.id });
      return project;
    },

    createThread(input) {
      const now = Date.now();
      const number =
        state.threads
          .filter((t) => t.projectId === input.projectId)
          .reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const thread: Thread = {
        id: input.id ?? crypto.randomUUID(),
        projectId: input.projectId,
        number,
        title: input.title,
        body: input.body,
        labels: [],
        createdBy: input.createdBy ?? USER,
        createdAt: now,
        updatedAt: now,
      };
      setState({ ...state, threads: [...state.threads, thread] });
      void send("POST", "/api/threads", { ...input, id: thread.id });
      return thread;
    },

    updateThread(id, patch, actor) {
      const now = Date.now();
      setState({
        ...state,
        threads: state.threads.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now } : t)),
      });
      void send("PATCH", `/api/threads/${id}`, { patch, actor });
    },

    deleteThread(id) {
      setState({
        ...state,
        threads: state.threads.filter((t) => t.id !== id),
        posts: state.posts.filter((p) => p.threadId !== id),
        events: state.events.filter((e) => e.threadId !== id),
        sessions: state.sessions.filter((s) => s.threadId !== id),
      });
      void send("DELETE", `/api/threads/${id}`);
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
      void send("DELETE", `/api/projects/${id}`);
    },

    addPost(input) {
      const now = Date.now();
      // One-level-deep flatten, mirroring the rules module — for the
      // optimistic object only. The POST body keeps input.replyTo verbatim
      // so the host flattens against its own (authoritative) state.
      const parent = input.replyTo ? state.posts.find((p) => p.id === input.replyTo) : undefined;
      const post: Post = {
        id: input.id ?? crypto.randomUUID(),
        threadId: input.threadId,
        author: input.author,
        body: input.body,
        createdAt: now,
        replyTo: input.replyTo ? (parent?.replyTo ?? input.replyTo) : undefined,
        kind: input.kind ?? "comment",
        attachments: input.attachments ?? [],
      };
      setState({
        ...state,
        posts: [...state.posts, post],
        threads: state.threads.map((t) => (t.id === input.threadId ? { ...t, updatedAt: now } : t)),
      });
      void send("POST", "/api/posts", { ...input, id: post.id });
      return post;
    },

    addEvent(input) {
      // The host mints its own event id — this one is a local stand-in
      // only, replaced wholesale by the next WS state push.
      const event: BoardEvent = { ...input, id: crypto.randomUUID(), at: Date.now() };
      setState({ ...state, events: [...state.events, event] });
      void send("POST", "/api/events", input);
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
      void send("PUT", "/api/roster", { roster: clean });
    },

    upsertSession(_record) {
      // Host-side bookkeeping (the orchestrator's). The UI never calls
      // this — sessions arrive read-only via the WS state stream.
      console.warn("[host-store] upsertSession called on the UI client; ignoring");
    },

  };
}
