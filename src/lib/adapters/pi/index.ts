// The Pi adapter — Mari's reference AgentAdapter (see src/lib/agent/types.ts).
//
// Pi (`pi --mode rpc`) speaks bidirectional JSONL over stdio. This adapter is
// pure translation: wire events → neutral AgentEvents in `handleLine`, UI
// intents → wire commands in the action methods. All streaming bookkeeping
// lives in the core reducer; if you're writing a new adapter, this file plus
// docs/ADAPTERS.md is the template.

import type {
  AdapterSession,
  AdapterSessionContext,
  AgentAdapter,
  AgentEvent,
  ChatItem,
  Model,
  SpawnOptions,
  SpawnSpec,
} from "@/lib/agent/types";
import { TranscriptBuilder } from "@/lib/agent/reducer";
import { toolStepMeta } from "@/lib/agent/tool-meta";
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ExtensionUiRequest,
  GetStateData,
  PiEvent,
  RpcResponse,
  ToolResult,
  ToolResultMessage,
  UserMessage,
} from "./protocol";
import { piSessionStore } from "./sessions";

// Startup model. Overridable via VITE_PI_MODEL; defaults to a fast, available
// codex model (the local Laguna default is often down).
const DEFAULT_MODEL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_PI_MODEL ??
  "openai-codex/gpt-5.5";

// ── content helpers ───────────────────────────────────────────────────────────
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
    .filter(
      (c): c is Extract<AssistantContent, { type: "text" }> =>
        c.type === "text",
    )
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
function textFromResult(result: ToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
    .join("");
}
function userText(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// ── hydration ─────────────────────────────────────────────────────────────────
// Rebuild the conversation from a persisted `get_messages` dump (used when
// resuming a saved session). Blocks are routed in document order so prose ↔
// tool ordering survives, identically to the live path.
export function buildItemsFromMessages(messages: AgentMessage[]): ChatItem[] {
  const b = new TranscriptBuilder();
  for (const msg of messages) {
    const role = (msg as { role?: string }).role;

    if (role === "user") {
      b.user(userText(msg as UserMessage), (msg as UserMessage).timestamp);
      continue;
    }

    if (role === "assistant") {
      const am = msg as AssistantMessage;
      const ts = am.timestamp;
      if (am.stopReason === "error")
        b.error(am.errorMessage ?? "The model returned an error.");
      for (const block of normContent(am.content)) {
        if (block.type === "thinking") {
          b.thinking(block.thinking, ts);
        } else if (block.type === "toolCall") {
          const meta = toolStepMeta(block.name, block.arguments);
          b.step(block.id, meta.icon, meta.label, ts);
        } else if (block.type === "text") {
          b.prose(block.text, ts);
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const tr = msg as ToolResultMessage;
      const output = tr.content?.map((c) => c.text ?? "").join("") || undefined;
      b.stepResult(tr.toolCallId, output, tr.isError, tr.timestamp);
    }
  }
  return b.items();
}

// ── extension-UI requests → questions/notices ─────────────────────────────────
function uiRequestEvents(ev: ExtensionUiRequest): AgentEvent[] {
  switch (ev.method) {
    case "select":
      return [
        {
          kind: "question",
          question: {
            id: ev.id,
            method: "select",
            title: ev.title,
            options: ev.options,
            timeout: ev.timeout,
          },
        },
      ];
    case "confirm":
      return [
        {
          kind: "question",
          question: {
            id: ev.id,
            method: "confirm",
            title: ev.title,
            message: ev.message,
            timeout: ev.timeout,
          },
        },
      ];
    case "input":
      return [
        {
          kind: "question",
          question: {
            id: ev.id,
            method: "input",
            title: ev.title,
            placeholder: ev.placeholder,
            timeout: ev.timeout,
          },
        },
      ];
    case "editor":
      return [
        {
          kind: "question",
          question: {
            id: ev.id,
            method: "editor",
            title: ev.title,
            prefill: ev.prefill,
            timeout: ev.timeout,
          },
        },
      ];
    case "notify":
      return [
        {
          kind: "notice",
          variant: ev.notifyType ?? "info",
          text: ev.message,
          sticky: ev.id,
        },
      ];
    default:
      // Fire-and-forget chrome (setStatus/setWidget/setTitle/…) — no-op.
      return [];
  }
}

// ── the per-session translation state ─────────────────────────────────────────
function createSession(ctx: AdapterSessionContext): AdapterSession {
  const send = ctx.send;
  const refreshStats = () => send({ type: "get_session_stats" });

  function responseEvents(res: RpcResponse): AgentEvent[] {
    if (!res.success) return [];
    const data = res.data as Record<string, unknown> | undefined;
    switch (res.command) {
      case "get_state": {
        const d = (data ?? {}) as GetStateData;
        return [
          {
            kind: "meta",
            ...(d.model ? { model: d.model } : {}),
            ...(d.thinkingLevel ? { thinkingLevel: d.thinkingLevel } : {}),
            identity: {
              sessionFile: d.sessionFile,
              sessionId: d.sessionId,
              sessionName: d.sessionName,
              // get_state omits cwd; keep whatever the host reported (the
              // synthetic "cwd" line) so the breadcrumb path survives.
              ...(d.cwd ? { cwd: d.cwd } : {}),
            },
          },
        ];
      }
      case "set_model":
        return data ? [{ kind: "meta", model: data as unknown as Model }] : [];
      case "get_available_models":
        return Array.isArray(data?.models)
          ? [
              {
                kind: "meta",
                availableModels: data.models as unknown as Model[],
              },
            ]
          : [];
      case "get_messages":
        return Array.isArray(data?.messages)
          ? [
              {
                kind: "hydrate",
                items: buildItemsFromMessages(data.messages as AgentMessage[]),
              },
            ]
          : [];
      case "get_session_stats":
        return [{ kind: "meta", stats: (data ?? null) as never }];
      case "set_session_name":
        send({ type: "get_state" });
        return [{ kind: "activity" }];
      case "fork":
        // A fork created a fresh session file → reload transcript + identity.
        if (data && data.cancelled) return [];
        send({ type: "get_messages" });
        send({ type: "get_state" });
        refreshStats();
        return [{ kind: "activity" }];
      default:
        return [];
    }
  }

  return {
    onConnected({ resumed, defaultThinkingLevel }) {
      send({ type: "get_state" });
      send({ type: "get_available_models" });
      if (resumed) {
        // An existing session boots with --session; pull its transcript and
        // keep its own saved thinking level.
        send({ type: "get_messages" });
      } else if (defaultThinkingLevel) {
        send({ type: "set_thinking_level", level: defaultThinkingLevel });
      }
      refreshStats();
    },

    handleLine(line): AgentEvent[] {
      const ev = line as PiEvent;
      switch (ev.type) {
        case "cwd":
          return ev.cwd ? [{ kind: "meta", identity: { cwd: ev.cwd } }] : [];

        case "response":
          return responseEvents(ev);

        case "agent_start":
          // A fresh run creates/writes the session file → get_state so the
          // brand-new chat's identity (file path) lands immediately.
          send({ type: "get_state" });
          return [{ kind: "run-start" }];

        case "agent_end":
          // A completed turn changes token/cost totals — refresh the stats
          // meter and identity.
          refreshStats();
          send({ type: "get_state" });
          return [{ kind: "run-end" }];

        case "message_start":
          // New message in the run → fresh thinking step / prose segment.
          return (ev.message as { role?: string }).role === "assistant"
            ? [{ kind: "segment-break" }]
            : [];

        case "message_update": {
          const content = ev.message?.content ?? [];
          const events: AgentEvent[] = [];
          const thinking = extractThinking(content);
          const text = extractText(content);
          if (thinking) events.push({ kind: "thinking", thinking });
          if (text) events.push({ kind: "text", text });
          return events;
        }

        case "message_end": {
          const msg = ev.message as AssistantMessage;
          if ((msg as { role?: string }).role !== "assistant") return [];
          const events: AgentEvent[] = [];
          const thinking = extractThinking(msg.content);
          const text = extractText(msg.content);
          if (thinking) events.push({ kind: "thinking", thinking, final: true });
          if (text) events.push({ kind: "text", text, final: true });
          if (msg.stopReason === "error")
            events.push({
              kind: "run-error",
              message: msg.errorMessage ?? "The model returned an error.",
            });
          events.push({ kind: "segment-break" });
          return events;
        }

        case "tool_execution_start": {
          const meta = toolStepMeta(ev.toolName, ev.args);
          return [
            {
              kind: "step-start",
              id: ev.toolCallId,
              icon: meta.icon,
              label: meta.label,
            },
          ];
        }

        case "tool_execution_update":
          return [
            {
              kind: "step-update",
              id: ev.toolCallId,
              output: textFromResult(ev.partialResult),
            },
          ];

        case "tool_execution_end":
          return [
            {
              kind: "step-end",
              id: ev.toolCallId,
              output: textFromResult(ev.result),
              isError: ev.isError,
            },
          ];

        case "queue_update":
          return [
            {
              kind: "queue",
              steering: ev.steering ?? [],
              followUp: ev.followUp ?? [],
            },
          ];

        case "compaction_start":
          return [
            {
              kind: "notice",
              sticky: "compaction",
              variant: "compaction",
              text: "Compacting context…",
            },
          ];
        case "compaction_end":
          return [{ kind: "notice-clear", sticky: "compaction" }];

        case "auto_retry_start":
          return [
            {
              kind: "notice",
              sticky: "retry",
              variant: "retry",
              text: `Retrying (${ev.attempt}/${ev.maxAttempts})…`,
            },
          ];
        case "auto_retry_end":
          return [{ kind: "notice-clear", sticky: "retry" }];

        case "extension_error":
          return [{ kind: "notice", variant: "error", text: ev.error }];

        case "extension_ui_request":
          return uiRequestEvents(ev);

        default:
          return [];
      }
    },

    prompt(text, attachments, { streaming }) {
      send({
        type: "prompt",
        message: text,
        images: attachments,
        // Sending mid-run steers the agent (pi's streamingBehavior).
        streamingBehavior: streaming ? "steer" : undefined,
      });
    },

    abort: () => send({ type: "abort" }),

    respond: (id, answer) =>
      send({ type: "extension_ui_response", id, ...answer }),

    setModel(provider, modelId) {
      send({ type: "set_model", provider, modelId });
      // A new model may support a different thinking level — refresh state.
      send({ type: "get_state" });
    },

    setThinkingLevel: (level) => send({ type: "set_thinking_level", level }),

    fork: (entryId) => send({ type: "fork", entryId }),

    rename: (name) => send({ type: "set_session_name", name }),
  };
}

export const piAdapter: AgentAdapter = {
  id: "pi",
  name: "Pi",
  capabilities: {
    models: true,
    thinkingLevels: true,
    steer: true,
    questions: true,
    fork: true,
    rename: true,
    stats: true,
    attachments: true,
  },
  defaultModel: DEFAULT_MODEL,
  spawn(opts: SpawnOptions): SpawnSpec {
    const args = ["--mode", "rpc"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.name) args.push("--name", opts.name);
    if (opts.sessionPath) args.push("--session", opts.sessionPath);
    return {
      bin: opts.binPath || "pi",
      args,
      cwd: opts.cwd,
      pathDirs: opts.pathDirs,
    };
  },
  createSession,
  sessions: piSessionStore,
};
