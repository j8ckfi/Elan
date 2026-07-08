// Folds the Pi event stream into a renderable conversation.
//
// Rendering model (matches Fluid's ThinkingSteps "agent progress" pattern):
// an assistant run is ONE item with an ordered `steps[]` timeline — every
// thinking pass, tool call, and intermediate narration becomes a step — plus
// the final `answer` text shown below the timeline. Extension dialogs and
// compaction/retry notices are separate items.

import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ExtensionUiRequest,
  PiEvent,
  ToolResult,
  ToolResultMessage,
  UserMessage,
} from "./types";

// ── View model ──────────────────────────────────────────────────────────────
export type StepKind = "tool" | "thinking" | "text";
export type StepStatus = "active" | "complete" | "error";

export interface Step {
  id: string;
  kind: StepKind;
  /** Fluid icon-map name. */
  icon: string;
  label: string;
  /** Collapsible detail: tool output, or the reasoning text. */
  output?: string;
  status: StepStatus;
}

export interface AssistantItem {
  type: "assistant";
  id: string;
  steps: Step[];
  answer: string;
  streaming: boolean;
  error?: string;
  /** Wall-clock run timing (live turns only) → the "Worked for Xs" header. */
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

export interface SessionState {
  items: ChatItem[];
  streaming: boolean;
  currentAssistantId: string | null;
  /** The thinking step being streamed into for the current message, if any. */
  currentThinkingStepId: string | null;
  queue: { steering: string[]; followUp: string[] };
  seq: number;
}

export const initialState: SessionState = {
  items: [],
  streaming: false,
  currentAssistantId: null,
  currentThinkingStepId: null,
  queue: { steering: [], followUp: [] },
  seq: 0,
};

export type LocalAction =
  | { type: "@user"; text: string; images?: number }
  | { type: "@reset" }
  | { type: "@resolveQuestion"; id: string }
  | { type: "@hydrate"; messages: AgentMessage[] };

export type ReducerInput = PiEvent | LocalAction;

// ── content helpers ──────────────────────────────────────────────────────
// Message content may arrive as an array of blocks, a bare string (older/other
// tools, hand-written session files), or be missing entirely. Normalize to a
// block array so nothing downstream crashes on an unexpectedly-shaped session
// file — durability: one malformed file must never white-screen the app.
function normContent(content: unknown): AssistantContent[] {
  if (Array.isArray(content)) return content as AssistantContent[];
  if (typeof content === "string")
    return content ? [{ type: "text", text: content } as AssistantContent] : [];
  return [];
}
function extractText(content: unknown): string {
  return normContent(content)
    .filter((c): c is Extract<AssistantContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}
function extractThinking(content: unknown): string {
  return normContent(content)
    .filter(
      (c): c is Extract<AssistantContent, { type: "thinking" }> =>
        c.type === "thinking",
    )
    .map((c) => c.thinking)
    .join("");
}
function hasToolCalls(content: unknown): boolean {
  return normContent(content).some((c) => c.type === "toolCall");
}
function textFromResult(result: ToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
    .join("");
}

function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function short(s: unknown, n = 48): string {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Human label + Fluid icon for a tool call. */
function toolStepMeta(name: string, args: unknown): { icon: string; label: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "bash":
      return { icon: "monitor", label: `Ran ${short(a.command, 40)}` };
    case "read":
      return { icon: "square-library", label: `Read ${basename(a.file_path ?? a.path)}` };
    case "edit":
      return { icon: "pencil", label: `Edited ${basename(a.file_path ?? a.path)}` };
    case "write":
      return { icon: "pencil", label: `Wrote ${basename(a.file_path ?? a.path)}` };
    case "grep":
      return { icon: "search", label: `Searched for ${short(a.pattern, 32)}` };
    case "find":
      return { icon: "search", label: `Found files ${short(a.pattern ?? a.query, 28)}` };
    case "ls":
      return { icon: "square-library", label: `Listed ${basename(a.path) || "directory"}` };
    default:
      return { icon: "dot", label: `Used ${name}` };
  }
}

// ── assistant-item mutation helper ─────────────────────────────────────────
function updateAssistant(
  state: SessionState,
  fn: (a: AssistantItem) => AssistantItem,
): SessionState {
  if (!state.currentAssistantId) return state;
  return {
    ...state,
    items: state.items.map((it) =>
      it.id === state.currentAssistantId && it.type === "assistant"
        ? fn(it)
        : it,
    ),
  };
}

/** Ensure an assistant run item exists (agent_start normally creates it, but be
 *  defensive if a tool/message arrives first). Returns [state, assistantId]. */
function ensureAssistant(state: SessionState): [SessionState, string] {
  if (state.currentAssistantId) return [state, state.currentAssistantId];
  const id = `a${state.seq}`;
  return [
    {
      ...state,
      seq: state.seq + 1,
      currentAssistantId: id,
      items: [
        ...state.items,
        {
          type: "assistant",
          id,
          steps: [],
          answer: "",
          streaming: true,
          startedAt: Date.now(),
        },
      ],
    },
    id,
  ];
}

function upsertStep(steps: Step[], step: Step): Step[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i === -1) return [...steps, step];
  const next = [...steps];
  next[i] = { ...next[i], ...step };
  return next;
}
function patchStep(steps: Step[], id: string, patch: Partial<Step>): Step[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

// ── hydration ──────────────────────────────────────────────────────────────
// Rebuild the conversation from a persisted `get_messages` dump (used when
// switching to a saved session). A flat AgentMessage[] becomes the same
// user/assistant-run item model the live reducer produces: consecutive
// assistant + toolResult messages between two user turns collapse into ONE
// AssistantItem with an ordered steps[] timeline + final answer.
function userText(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function buildItemsFromMessages(messages: AgentMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let current: AssistantItem | null = null;
  let n = 0;

  for (const msg of messages) {
    const role = (msg as { role?: string }).role;

    if (role === "user") {
      if (current) items.push(current);
      current = null;
      const text = userText(msg as UserMessage);
      if (text.trim())
        items.push({
          type: "user",
          id: `u${n++}`,
          text,
          createdAt: (msg as UserMessage).timestamp,
        });
      continue;
    }

    if (role === "assistant") {
      if (!current)
        current = { type: "assistant", id: `a${n++}`, steps: [], answer: "", streaming: false };
      const a = current;
      // Timestamps span the run: earliest starts it, latest ends it.
      const ts = (msg as AssistantMessage).timestamp;
      if (ts != null) {
        a.startedAt = a.startedAt ?? ts;
        a.endedAt = ts;
      }
      const content = normContent((msg as AssistantMessage).content);
      const calls = hasToolCalls(content);
      if ((msg as AssistantMessage).stopReason === "error")
        a.error = (msg as AssistantMessage).errorMessage ?? "The model returned an error.";
      for (const block of content) {
        if (block.type === "thinking" && block.thinking.trim()) {
          a.steps.push({
            id: `${a.id}-s${a.steps.length}`,
            kind: "thinking",
            icon: "brain",
            label: "Thinking",
            output: block.thinking,
            status: "complete",
          });
        } else if (block.type === "toolCall") {
          const meta = toolStepMeta(block.name, block.arguments);
          a.steps.push({
            id: block.id,
            kind: "tool",
            icon: meta.icon,
            label: meta.label,
            status: "complete",
          });
        } else if (block.type === "text" && block.text.trim()) {
          if (calls) {
            a.steps.push({
              id: `${a.id}-s${a.steps.length}`,
              kind: "text",
              icon: "dot",
              label: short(block.text, 72),
              output: block.text,
              status: "complete",
            });
          } else {
            a.answer = block.text;
          }
        }
      }
      continue;
    }

    if (role === "toolResult" && current) {
      const tr = msg as ToolResultMessage;
      const a = current;
      const i = a.steps.findIndex((s) => s.id === tr.toolCallId);
      if (i !== -1) {
        a.steps[i] = {
          ...a.steps[i],
          status: tr.isError ? "error" : "complete",
          output: tr.content?.map((c) => c.text ?? "").join("") || a.steps[i].output,
        };
      }
    }
  }

  if (current) items.push(current);
  return items;
}

// ── reducer ──────────────────────────────────────────────────────────────
export function reduce(state: SessionState, ev: ReducerInput): SessionState {
  switch (ev.type) {
    case "@reset":
      return { ...initialState };

    case "@hydrate": {
      const items = buildItemsFromMessages(ev.messages);
      return {
        ...initialState,
        items,
        seq: items.length + 1,
      };
    }

    case "@user":
      return {
        ...state,
        seq: state.seq + 1,
        currentAssistantId: null,
        currentThinkingStepId: null,
        items: [
          ...state.items,
          {
            type: "user",
            id: `u${state.seq}`,
            text: ev.text,
            images: ev.images,
            createdAt: Date.now(),
          },
        ],
      };

    case "@resolveQuestion":
      return { ...state, items: state.items.filter((it) => it.id !== ev.id) };

    case "agent_start": {
      const id = `a${state.seq}`;
      return {
        ...state,
        seq: state.seq + 1,
        streaming: true,
        currentAssistantId: id,
        currentThinkingStepId: null,
        items: [
          ...state.items,
          {
            type: "assistant",
            id,
            steps: [],
            answer: "",
            streaming: true,
            startedAt: Date.now(),
          },
        ],
      };
    }

    case "agent_end": {
      const s = updateAssistant(state, (a) => ({
        ...a,
        streaming: false,
        endedAt: Date.now(),
        steps: a.steps.map((st) =>
          st.status === "active" ? { ...st, status: "complete" } : st,
        ),
      }));
      return { ...s, streaming: false, currentThinkingStepId: null };
    }

    case "message_start": {
      const msg = ev.message as { role?: string };
      if (msg.role !== "assistant") return state;
      // New message in the run → start a fresh thinking step next time.
      return { ...state, currentThinkingStepId: null };
    }

    case "message_update": {
      const content = ev.message?.content ?? [];
      const text = extractText(content);
      const thinking = extractThinking(content);
      let [next, id] = ensureAssistant(state);
      let thinkingStepId = next.currentThinkingStepId;

      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => {
        let steps = a.steps;
        if (thinking) {
          if (!thinkingStepId) {
            thinkingStepId = `s${next.seq}`;
            steps = upsertStep(steps, {
              id: thinkingStepId,
              kind: "thinking",
              icon: "brain",
              label: "Thinking",
              output: thinking,
              status: "active",
            });
          } else {
            steps = patchStep(steps, thinkingStepId, { output: thinking });
          }
        }
        // Tentatively show streaming text as the answer; message_end demotes it
        // to a narration step if this message turns out to call tools.
        return { ...a, steps, answer: text };
      });

      return {
        ...next,
        seq: thinking && thinkingStepId && !state.currentThinkingStepId
          ? next.seq + 1
          : next.seq,
        currentThinkingStepId: thinkingStepId,
      };
    }

    case "message_end": {
      const msg = ev.message as {
        role?: string;
        content?: AssistantContent[];
        stopReason?: string;
        errorMessage?: string;
      };
      if (msg.role !== "assistant") return state;
      const content = msg.content ?? [];
      const text = extractText(content);
      const thinking = extractThinking(content);
      const calls = hasToolCalls(content);
      const error =
        msg.stopReason === "error"
          ? (msg.errorMessage ?? "The model returned an error.")
          : undefined;

      let [next, id] = ensureAssistant(state);
      const thinkingStepId = next.currentThinkingStepId;

      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => {
        let steps = a.steps;
        // Finalize the thinking step for this message.
        if (thinkingStepId && thinking) {
          steps = patchStep(steps, thinkingStepId, {
            output: thinking,
            status: "complete",
          });
        }
        if (calls) {
          // This message's text is narration before a tool call → a step.
          if (text.trim()) {
            steps = upsertStep(steps, {
              id: `s${next.seq}`,
              kind: "text",
              icon: "dot",
              label: short(text, 72),
              output: text,
              status: "complete",
            });
          }
          return { ...a, steps, answer: "", error: error ?? a.error };
        }
        // Final message of the run → its text is the answer.
        return { ...a, steps, answer: text || a.answer, error: error ?? a.error };
      });

      return {
        ...next,
        seq: calls && text.trim() ? next.seq + 1 : next.seq,
        currentThinkingStepId: null,
      };
    }

    case "tool_execution_start": {
      let [next, id] = ensureAssistant(state);
      const meta = toolStepMeta(ev.toolName, ev.args);
      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => ({
        ...a,
        steps: upsertStep(a.steps, {
          id: ev.toolCallId,
          kind: "tool",
          icon: meta.icon,
          label: meta.label,
          status: "active",
        }),
      }));
      return next;
    }

    case "tool_execution_update":
      return updateAssistant(state, (a) => ({
        ...a,
        steps: patchStep(a.steps, ev.toolCallId, {
          output: textFromResult(ev.partialResult),
        }),
      }));

    case "tool_execution_end":
      return updateAssistant(state, (a) => ({
        ...a,
        steps: patchStep(a.steps, ev.toolCallId, {
          status: ev.isError ? "error" : "complete",
          output: textFromResult(ev.result),
        }),
      }));

    // ── queue / compaction / retry ───────────────────────────────────
    case "queue_update":
      return {
        ...state,
        queue: { steering: ev.steering ?? [], followUp: ev.followUp ?? [] },
      };

    case "compaction_start":
      return {
        ...state,
        items: [
          ...state.items.filter((it) => it.id !== "compaction"),
          {
            type: "notice",
            id: "compaction",
            variant: "compaction",
            text: "Compacting context…",
          },
        ],
      };

    case "compaction_end":
      return {
        ...state,
        items: state.items.filter((it) => it.id !== "compaction"),
      };

    case "auto_retry_start":
      return {
        ...state,
        items: [
          ...state.items.filter((it) => it.id !== "retry"),
          {
            type: "notice",
            id: "retry",
            variant: "retry",
            text: `Retrying (${ev.attempt}/${ev.maxAttempts})…`,
          },
        ],
      };

    case "auto_retry_end":
      return { ...state, items: state.items.filter((it) => it.id !== "retry") };

    case "extension_error":
      return {
        ...state,
        seq: state.seq + 1,
        items: [
          ...state.items,
          { type: "notice", id: `err${state.seq}`, variant: "error", text: ev.error },
        ],
      };

    case "extension_ui_request":
      return reduceUiRequest(state, ev);

    default:
      return state;
  }
}

function reduceUiRequest(
  state: SessionState,
  ev: ExtensionUiRequest,
): SessionState {
  const push = (item: ChatItem): SessionState => ({
    ...state,
    items: [...state.items, item],
  });
  switch (ev.method) {
    case "select":
      return push({
        type: "question",
        id: ev.id,
        method: "select",
        title: ev.title,
        options: ev.options,
        timeout: ev.timeout,
      });
    case "confirm":
      return push({
        type: "question",
        id: ev.id,
        method: "confirm",
        title: ev.title,
        message: ev.message,
        timeout: ev.timeout,
      });
    case "input":
      return push({
        type: "question",
        id: ev.id,
        method: "input",
        title: ev.title,
        placeholder: ev.placeholder,
        timeout: ev.timeout,
      });
    case "editor":
      return push({
        type: "question",
        id: ev.id,
        method: "editor",
        title: ev.title,
        prefill: ev.prefill,
        timeout: ev.timeout,
      });
    case "notify":
      return push({
        type: "notice",
        id: ev.id,
        variant: ev.notifyType ?? "info",
        text: ev.message,
      });
    default:
      // Fire-and-forget chrome (setStatus/setWidget/setTitle/…) — no-op.
      return state;
  }
}
