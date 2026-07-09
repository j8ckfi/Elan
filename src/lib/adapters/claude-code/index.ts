// The Claude Code adapter — drives `claude -p` in bidirectional stream-json
// mode. The second real backend, and the proof that the neutral contract in
// src/lib/agent/types.ts isn't secretly Pi-shaped.
//
// Wire shape (one JSON object per line, both directions):
//   in  → {type:"user", message:{role:"user", content:[…blocks]}}
//   in  → {type:"control_response", response:{…}}          (permission replies)
//   in  → {type:"control_request", request:{subtype:"interrupt"}}   (abort)
//   out ← {type:"system", subtype:"init", cwd, session_id, model, …}
//   out ← {type:"stream_event", event:{…raw Anthropic SSE event…}}
//   out ← {type:"assistant", message:{content:[text|thinking|tool_use]}}
//   out ← {type:"user", message:{content:[tool_result…]}}
//   out ← {type:"control_request", request:{subtype:"can_use_tool", …}}
//   out ← {type:"result", subtype, is_error, result, …}    (run settled)
//
// Capability boundaries (v1): no model picker (the model is fixed at spawn),
// no thinking levels, no steer, no on-disk session store (the sidebar shows
// open tabs only — listing ~/.claude/projects would need a host-side scan).

import type {
  AdapterSession,
  AdapterSessionContext,
  AgentAdapter,
  AgentEvent,
  ImageAttachment,
  SpawnOptions,
  SpawnSpec,
} from "@/lib/agent/types";
import { toolStepMeta } from "@/lib/agent/tool-meta";

// ── wire types (the fields we read; permissive elsewhere) ─────────────────────
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface WireLine {
  type?: string;
  subtype?: string;
  cwd?: string;
  session_id?: string;
  model?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
  event?: {
    type?: string;
    index?: number;
    content_block?: ContentBlock;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: unknown };
  is_error?: boolean;
  result?: string;
  /** Set on events that belong to a subagent's nested run. */
  parent_tool_use_id?: string | null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as ContentBlock).type === "text"
          ? String((c as ContentBlock).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function short(v: unknown, n = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n - 1) + "…" : (s ?? "");
}

function createSession(ctx: AdapterSessionContext): AdapterSession {
  // Cumulative text/thinking of the message currently streaming (reset at each
  // message boundary) — the core reducer wants snapshots, not deltas.
  let text = "";
  let thinking = "";
  // Blocks whose stream deltas we route by index.
  const blockTypes = new Map<number, string>();
  // Pending can_use_tool permission requests, by our question id.
  const pending = new Map<string, { requestId: string; input: unknown }>();
  let reqCounter = 0;

  const resetMessage = () => {
    text = "";
    thinking = "";
    blockTypes.clear();
  };

  return {
    onConnected() {
      // Nothing to fetch — init metadata arrives with the first turn.
    },

    handleLine(line): AgentEvent[] {
      const ev = line as WireLine;
      // Synthetic host line: the spawn cwd (init also carries it, later).
      if (ev.type === "cwd" && (ev as { cwd?: string }).cwd)
        return [{ kind: "meta", identity: { cwd: ev.cwd } }];
      // Subagent traffic renders inside its Task step's output, not the
      // top-level transcript.
      if (ev.parent_tool_use_id) return [];

      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") {
            return [
              {
                kind: "meta",
                identity: { sessionId: ev.session_id, cwd: ev.cwd },
                ...(ev.model
                  ? {
                      model: {
                        id: ev.model,
                        name: ev.model,
                        api: "anthropic",
                        provider: "claude-code",
                      },
                    }
                  : {}),
              },
            ];
          }
          return []; // hook chatter etc.

        case "stream_event": {
          const e = ev.event ?? {};
          switch (e.type) {
            case "content_block_start":
              if (e.index != null && e.content_block?.type)
                blockTypes.set(e.index, e.content_block.type);
              return [];
            case "content_block_delta": {
              const d = e.delta ?? {};
              if (d.type === "text_delta" && d.text) {
                text += d.text;
                return [{ kind: "text", text }];
              }
              if (d.type === "thinking_delta" && d.thinking) {
                thinking += d.thinking;
                return [{ kind: "thinking", thinking }];
              }
              return [];
            }
            default:
              return [];
          }
        }

        // The complete assistant message — the source of truth. Finalizes the
        // streamed text/thinking and opens a step per tool_use block.
        case "assistant": {
          const blocks = Array.isArray(ev.message?.content)
            ? ev.message.content
            : [];
          const events: AgentEvent[] = [];
          const finalThinking =
            blocks
              .filter((b) => b.type === "thinking")
              .map((b) => b.thinking ?? "")
              .join("") || thinking;
          const finalText =
            blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("") || text;
          if (finalThinking)
            events.push({ kind: "thinking", thinking: finalThinking, final: true });
          if (finalText)
            events.push({ kind: "text", text: finalText, final: true });
          for (const b of blocks) {
            if (b.type === "tool_use" && b.id && b.name) {
              const meta = toolStepMeta(b.name, b.input);
              events.push({
                kind: "step-start",
                id: b.id,
                icon: meta.icon,
                label: meta.label,
              });
            }
          }
          events.push({ kind: "segment-break" });
          resetMessage();
          return events;
        }

        // Tool results come back as user messages.
        case "user": {
          const blocks = Array.isArray(ev.message?.content)
            ? ev.message.content
            : [];
          const events: AgentEvent[] = [];
          for (const b of blocks) {
            if (b.type === "tool_result" && b.tool_use_id) {
              events.push({
                kind: "step-end",
                id: b.tool_use_id,
                output: resultText(b.content),
                isError: Boolean(b.is_error),
              });
            }
          }
          return events;
        }

        // Permission prompt (spawned with --permission-prompt-tool stdio).
        case "control_request": {
          if (ev.request?.subtype === "can_use_tool" && ev.request_id) {
            const qid = `perm-${ev.request_id}`;
            pending.set(qid, {
              requestId: ev.request_id,
              input: ev.request.input,
            });
            return [
              {
                kind: "question",
                question: {
                  id: qid,
                  method: "confirm",
                  title: `Allow ${ev.request.tool_name ?? "tool"}?`,
                  message: short(ev.request.input),
                },
              },
            ];
          }
          return [];
        }

        case "result": {
          const events: AgentEvent[] = [];
          if (ev.is_error)
            events.push({
              kind: "run-error",
              message: ev.result || "Claude Code returned an error.",
            });
          events.push({ kind: "run-end" }, { kind: "activity" });
          resetMessage();
          return events;
        }

        default:
          return [];
      }
    },

    prompt(promptText: string, attachments: ImageAttachment[] | undefined) {
      const content: unknown[] = [];
      for (const a of attachments ?? []) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: a.mimeType, data: a.data },
        });
      }
      content.push({ type: "text", text: promptText });
      ctx.send({ type: "user", message: { role: "user", content } });
      ctx.emit([{ kind: "run-start" }]);
    },

    abort() {
      ctx.send({
        type: "control_request",
        request_id: `interrupt-${++reqCounter}`,
        request: { subtype: "interrupt" },
      });
    },

    respond(id, answer) {
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      const allow = "confirmed" in answer && answer.confirmed;
      ctx.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: req.requestId,
          response: allow
            ? { behavior: "allow", updatedInput: req.input }
            : { behavior: "deny", message: "User denied this tool call." },
        },
      });
    },
  };
}

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  name: "Claude Code",
  capabilities: {
    models: false,
    thinkingLevels: false,
    steer: false,
    questions: true,
    fork: false,
    rename: false,
    stats: false,
    attachments: true,
  },
  spawn(opts: SpawnOptions): SpawnSpec {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
    ];
    // Settings' default model may be a Pi-style `provider/id` — only forward
    // ids Claude's CLI understands.
    if (opts.model && !opts.model.includes("/"))
      args.push("--model", opts.model);
    if (opts.sessionPath) args.push("--resume", opts.sessionPath);
    return {
      bin: opts.binPath || "claude",
      args,
      cwd: opts.cwd,
      pathDirs: opts.pathDirs,
    };
  },
  createSession,
};
