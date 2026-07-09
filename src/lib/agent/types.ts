// The neutral agent contract — everything the UI knows about a backend.
//
// Mari's frontend never touches a CLI's wire protocol. It renders `ChatItem`s,
// sends *intents* (prompt, abort, set model…), and asks the adapter's
// `capabilities` what chrome to show. An adapter translates between this file
// and one concrete agent CLI (see src/lib/adapters/). If you are porting Mari
// to a new agent, this file is the contract you implement — start at
// docs/ADAPTERS.md.

// ─── View model ──────────────────────────────────────────────────────────────
// What the conversation renders. An assistant run is an ORDERED list of
// `parts`: `prose` (markdown segments) and `work` (chunks of the thinking/tool
// timeline). Prose is positional — text between two tool calls stays between
// them. The "answer" is simply the trailing prose.

export type StepKind = "tool" | "thinking";
export type StepStatus = "active" | "complete" | "error";

export interface Step {
  id: string;
  kind: StepKind;
  /** Fluid icon-map name (see src/lib/icon-map.tsx). */
  icon: string;
  label: string;
  /** Collapsible detail: tool output, or the reasoning text. */
  output?: string;
  status: StepStatus;
}

/** A rendered markdown segment of an assistant run. */
export interface ProsePart {
  kind: "prose";
  id: string;
  text: string;
  streaming: boolean;
}
/** A contiguous chunk of the thinking/tool timeline between two prose segments. */
export interface WorkPart {
  kind: "work";
  id: string;
  steps: Step[];
  /** Wall-clock span of this chunk → its own "Worked for Xs" header. */
  startedAt?: number;
  endedAt?: number;
}
export type RunPart = ProsePart | WorkPart;

export interface AssistantItem {
  type: "assistant";
  id: string;
  parts: RunPart[];
  streaming: boolean;
  error?: string;
  /** Wall-clock run timing (live turns only) → per-prose settled timestamp. */
  startedAt?: number;
  endedAt?: number;
}
export interface UserItem {
  type: "user";
  id: string;
  text: string;
  images?: number;
  /** When the message was sent (epoch ms) — the hover "time sent" label. */
  createdAt?: number;
}
/** A blocking question from the agent (pick an option, confirm, free input). */
export interface QuestionItem {
  type: "question";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}
export interface NoticeItem {
  type: "notice";
  id: string;
  variant: "info" | "warning" | "error" | "compaction" | "retry";
  text: string;
}

export type ChatItem = UserItem | AssistantItem | QuestionItem | NoticeItem;

/** The answer payload for a QuestionItem, sent back via the adapter. */
export type QuestionAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

// ─── Model metadata ──────────────────────────────────────────────────────────

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  /** Maps each thinking level to a provider/model-specific wire value. A
   *  missing key uses the provider default (level supported); `null` marks the
   *  level as unsupported. `xhigh` counts only when explicitly present. This is
   *  what makes the thinking picker model-aware — see
   *  {@link ./thinking.supportedThinkingLevels}. */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

/** Identity of the currently-loaded session (adapter-reported). */
export interface SessionIdentity {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  /** Working directory of the active session — the "project" it belongs to. */
  cwd?: string;
}

/** An image attachment on an outgoing prompt. */
export interface ImageAttachment {
  type: "image";
  data: string; // base64
  mimeType: string;
}

// ─── AgentEvent — what adapters emit ─────────────────────────────────────────
// The semantic event vocabulary the core reducer folds into ChatItems. An
// adapter's job is to translate its CLI's wire events into these; ALL streaming
// bookkeeping (part interleaving, prose/work chunking, step lifecycle) lives in
// the core reducer, written once.
//
// Text/thinking events carry CUMULATIVE snapshots (the full text so far), not
// deltas — snapshots are idempotent, so a re-delivered or coalesced event can
// never double-append. Adapters for delta-based protocols accumulate first.

export type AgentEvent =
  /** A run (user turn → final answer) begins. Creates a streaming assistant item. */
  | { kind: "run-start" }
  /** The run settled. Settles timers, completes any active steps. */
  | { kind: "run-end" }
  /** Boundary between assistant messages within one run: the next text/
   *  thinking snapshot starts a fresh prose part / thinking step. */
  | { kind: "segment-break" }
  /** Cumulative prose text of the current segment. `final` settles it. */
  | { kind: "text"; text: string; final?: boolean }
  /** Cumulative reasoning text of the current segment. `final` settles it. */
  | { kind: "thinking"; thinking: string; final?: boolean }
  /** Mark the current run as errored (shown on the assistant item). */
  | { kind: "run-error"; message: string }
  /** A tool step opened. Closes the current prose segment (later text starts a
   *  fresh bubble below this work chunk). */
  | { kind: "step-start"; id: string; icon: string; label: string }
  | { kind: "step-update"; id: string; output?: string }
  | { kind: "step-end"; id: string; output?: string; isError?: boolean }
  /** A blocking question for the user. Answered via AdapterSession.respond. */
  | { kind: "question"; question: Omit<QuestionItem, "type"> }
  /** Remove a pending question (answered elsewhere / timed out). */
  | { kind: "question-resolved"; id: string }
  /** A transient banner. A `sticky` id can later be cleared (progress notices
   *  like "Compacting context…"); without one the notice just accumulates. */
  | {
      kind: "notice";
      variant: NoticeItem["variant"];
      text: string;
      sticky?: string;
    }
  | { kind: "notice-clear"; sticky: string }
  /** Queued steering/follow-up messages (shown under the composer). */
  | { kind: "queue"; steering: string[]; followUp: string[] }
  /** Replace the transcript wholesale (loading a saved session). Build items
   *  with {@link ./reducer.TranscriptBuilder}. */
  | { kind: "hydrate"; items: ChatItem[] }
  /** Out-of-band session metadata — merged into the engine's meta state.
   *  Send only the fields that changed. */
  | {
      kind: "meta";
      model?: Model;
      availableModels?: Model[];
      thinkingLevel?: ThinkingLevel;
      identity?: Partial<SessionIdentity>;
      stats?: SessionStats | null;
    }
  /** The on-disk session store was touched (created/renamed/forked) — the
   *  session manager refreshes the sidebar list. */
  | { kind: "activity" };

// ─── Adapter contract ────────────────────────────────────────────────────────

/** What the backend supports; the UI hides chrome for missing capabilities
 *  (no `models` → no model picker, no `questions` → no question cards, …). */
export interface AgentCapabilities {
  /** Model listing + switching (model picker). */
  models: boolean;
  /** Thinking/reasoning level selection (thinking picker). */
  thinkingLevels: boolean;
  /** Steering: sending while a run streams redirects the agent mid-run. */
  steer: boolean;
  /** Blocking questions (select/confirm/input/editor) via `respond`. */
  questions: boolean;
  /** Fork the conversation from an earlier entry. */
  fork: boolean;
  /** Rename the live session. */
  rename: boolean;
  /** Token/cost/context stats (the context ring). */
  stats: boolean;
  /** Image attachments on prompts. */
  attachments: boolean;
}

/** How to launch the CLI for one session. Consumed by the hosts (Rust core /
 *  dev bridge), which spawn `bin args…` in `cwd` with an augmented PATH. */
export interface SpawnSpec {
  bin: string;
  args: string[];
  cwd?: string;
  /** Extra dirs prepended to the child's PATH (Settings "extra PATH dirs"). */
  pathDirs?: string[];
}

/** Session-scoped inputs an adapter turns into a SpawnSpec. */
export interface SpawnOptions {
  cwd?: string;
  /** Existing session file/id to boot into; omit for a fresh session. */
  sessionPath?: string;
  /** Display name for a freshly-created session. */
  name?: string;
  /** Model to start with (Settings default). */
  model?: string;
  /** Explicit binary path (Settings override; empty → adapter default). */
  binPath?: string;
  pathDirs?: string[];
}

/** What the engine hands a live adapter session. */
export interface AdapterSessionContext {
  /** Write one command object to the CLI's stdin (serialized as one JSON line). */
  send(line: unknown): void;
  /** Push events outside handleLine (timers, async work). Events returned from
   *  handleLine are emitted automatically — use this only for out-of-band. */
  emit(events: AgentEvent[]): void;
}

/**
 * A live translation session — one per mounted engine/process. May hold
 * internal parse state. All methods are fire-and-forget; results come back
 * through the event stream.
 */
export interface AdapterSession {
  /** Translate one wire line (parsed JSON) into zero or more AgentEvents.
   *  May also ctx.send() follow-up commands (e.g. refresh state on run end). */
  handleLine(line: unknown): AgentEvent[];
  /** The transport connected — kick off init choreography (fetch state,
   *  models, the saved transcript when resuming, apply defaults…). */
  onConnected(opts: {
    /** Set when the session was booted from a saved transcript. */
    resumed: boolean;
    /** Settings default to apply to fresh sessions (capability: thinkingLevels). */
    defaultThinkingLevel?: ThinkingLevel;
  }): void;
  /** Send a user prompt. `streaming` is true when a run is in flight (steer
   *  or queue per the backend's semantics). */
  prompt(
    text: string,
    attachments: ImageAttachment[] | undefined,
    opts: { streaming: boolean },
  ): void;
  abort(): void;
  /** Answer a QuestionItem (capability: questions). */
  respond?(id: string, answer: QuestionAnswer): void;
  setModel?(provider: string, modelId: string): void;
  setThinkingLevel?(level: ThinkingLevel): void;
  fork?(entryId: string): void;
  rename?(name: string): void;
}

/** One row in the session sidebar. */
export interface SessionSummary {
  /** Opaque handle the adapter can reopen the session from (e.g. a file path). */
  path: string;
  id: string;
  cwd: string;
  /** User-set display name, if any. */
  name?: string;
  /** Best label: name → first user message → "Untitled". */
  title: string;
  createdAt: number;
  /** Epoch ms of last activity (drives sidebar ordering). */
  updatedAt: number;
  messages: number;
}

/** Optional on-disk session store: powers the sidebar (list/rename/delete of
 *  sessions with no live process, and change-driven refresh). */
export interface SessionStore {
  list(cwd?: string): Promise<SessionSummary[]>;
  /** Subscribe to store changes (fs watch on desktop, poll in the browser).
   *  Returns an unsubscribe fn. */
  watch(cb: () => void): () => void;
  delete(path: string): Promise<void>;
  /** Rename a session that has NO live process (live ones rename over RPC). */
  rename(path: string, name: string): Promise<void>;
}

import type { Transport } from "./transport";

/** A backend adapter: everything Mari needs to drive one agent CLI. */
export interface AgentAdapter {
  id: string;
  /** Human name for the agent ("Pi", "Claude Code", …) — used in copy like
   *  the composer placeholder and the disconnected banner. */
  name: string;
  capabilities: AgentCapabilities;
  /** Model id to start sessions with when Settings has no default. */
  defaultModel?: string;
  /** Build the launch command for a session. */
  spawn(opts: SpawnOptions): SpawnSpec;
  /** Create the per-session translation state. */
  createSession(ctx: AdapterSessionContext): AdapterSession;
  /** On-disk session store, if the CLI persists sessions (sidebar listing). */
  sessions?: SessionStore;
  /** Override the process transport. Default: Tauri IPC on desktop, the WS
   *  dev bridge in the browser. The mock adapter supplies an in-memory one. */
  createTransport?(key: string): Transport;
}
