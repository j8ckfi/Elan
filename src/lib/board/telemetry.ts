// Session telemetry — folds a harness process's stdout lines into Mari's
// neutral ChatItems for the thread feed's session blocks (docs/FRONTEND.md
// "Session telemetry", docs/ORCHESTRATION.md "Telemetry streaming").
//
// One translator per stream family turns wire lines into AgentEvents; the
// fold pushes them through the core reducer (src/lib/agent/reducer.ts) so
// the rendering rules are identical to Mari's chat. Two invariants, enforced
// by the fold itself so no translator can get them wrong:
//   1. run-start always precedes content, and finish() emits run-end even
//      when the CLI died before its terminal event.
//   2. A malformed line never throws — it is skipped. Telemetry is narration;
//      losing a line must not lose the timeline.
//
// Harnesses without a parseable stream (devin, mock, unknown) return
// `raw: true` and the caller renders the log tail instead — honest fallback.

import type { AgentEvent, ChatItem } from "@/lib/agent/types";
import { initialState, reduce, type ReducerInput } from "@/lib/agent/reducer";
import { toolStepMeta } from "@/lib/agent/tool-meta";
import { claudeCodeAdapter } from "@/lib/adapters/claude-code";

// ── Public shapes ──────────────────────────────────────────────────────────

/** One captured line of a session's interleaved stdout/stderr. */
export interface SessionLine {
  stream: "out" | "err";
  line: string;
}

export interface TelemetryResult {
  items: ChatItem[];
  /** No stream translator for this harness — render the raw log tail. */
  raw: boolean;
}

/** Incremental fold: push lines as they arrive (live WS stream), snapshot
 *  anytime, finish() once the stream is over. `foldSessionLines` is the
 *  replay-once convenience over the same machinery. */
export interface TelemetryFold {
  readonly raw: boolean;
  push(line: SessionLine): void;
  /** The stream ended — settle the run even if the terminal event never
   *  arrived (crash, kill, truncated log). Idempotent. */
  finish(): void;
  snapshot(): TelemetryResult;
}

// ── Stream families (mirrors the host's harness registry) ─────────────────

type Translator = (line: unknown) => AgentEvent[];

const TRANSLATOR_FACTORIES: Record<string, () => Translator> = {
  "claude-code": claudeStreamTranslator,
  cursor: claudeStreamTranslator, // same -p stream-json family
  pi: piStreamTranslator,
  codex: codexEventsTranslator,
  opencode: opencodeEventsTranslator,
  pool: poolEventsTranslator,
  grok: grokStreamTranslator,
  // devin, mock, anything unknown → raw (no entry).
};

// ── The fold ───────────────────────────────────────────────────────────────

// Event kinds that require an open run (Mari invariant: run-start precedes
// content). Notices/questions/meta stand alone.
const CONTENT_KINDS = new Set<AgentEvent["kind"]>([
  "text",
  "thinking",
  "step-start",
  "step-update",
  "step-end",
  "run-error",
]);

export function createFold(harness: string): TelemetryFold {
  const factory = TRANSLATOR_FACTORIES[harness];
  if (!factory) {
    // Raw family: the caller keeps its own line buffer for the tail.
    return {
      raw: true,
      push() {},
      finish() {},
      snapshot: () => ({ items: [], raw: true }),
    };
  }

  const translate = factory();
  let state = { ...initialState };
  let runOpen = false;
  const dispatch = (e: ReducerInput) => {
    state = reduce(state, e);
  };

  return {
    raw: false,

    push(l: SessionLine) {
      // Stderr is the noise (Durability rule 3) — translators read stdout.
      if (l.stream !== "out") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(l.line);
      } catch {
        return; // non-JSON chatter between events — skip
      }
      if (parsed === null || typeof parsed !== "object") return;
      let events: AgentEvent[];
      try {
        events = translate(parsed);
      } catch {
        return; // a malformed-but-parseable line must not kill the timeline
      }
      for (const e of events) {
        if (e.kind === "run-start") {
          if (!runOpen) {
            dispatch(e);
            runOpen = true;
          }
          continue;
        }
        if (e.kind === "run-end") {
          if (runOpen) {
            dispatch(e);
            runOpen = false;
          }
          continue;
        }
        if (!runOpen && CONTENT_KINDS.has(e.kind)) {
          dispatch({ kind: "run-start" });
          runOpen = true;
        }
        dispatch(e);
      }
    },

    finish() {
      if (!runOpen) return;
      dispatch({ kind: "run-end" });
      runOpen = false;
    },

    snapshot: () => ({ items: state.items, raw: false }),
  };
}

/** Replay-once fold over a full line list (completed-session replay, tests). */
export function foldSessionLines(
  harness: string,
  lines: SessionLine[],
): TelemetryResult {
  const fold = createFold(harness);
  for (const l of lines) fold.push(l);
  fold.finish();
  return fold.snapshot();
}

// ── The on-disk log format ─────────────────────────────────────────────────
// The host writes `.elan/sessions/<id>.log` as
//   2026-07-10T12:34:56.789Z [out] {...one wire line...}
// (dev/elan-host.ts logLine). Continuation lines without a stamp (stderr
// stack traces etc.) belong to the previous entry.

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\S+ \[(out|err)\] (.*)$/;

export function parseSessionLog(text: string): SessionLine[] {
  const out: SessionLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const m = LOG_LINE.exec(raw);
    if (m) out.push({ stream: m[1] as "out" | "err", line: m[2] });
    else if (out.length > 0) out[out.length - 1].line += `\n${raw}`;
    // Unstamped preamble before the first entry: nothing to attach it to.
  }
  return out;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Concatenated `text`-block content of a pi/claude-style block array. */
function blockText(content: unknown, type: string, key: string): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as Record<string, unknown>).type === type
        ? str((b as Record<string, unknown>)[key])
        : "",
    )
    .join("");
}

// ── claude-stream (claude-code, cursor) ────────────────────────────────────
// The `-p --output-format stream-json` family. The claude-code adapter
// already translates this wire protocol (src/lib/adapters/claude-code) — its
// handleLine is pure parse state, so instantiate it directly rather than
// reimplementing. Cursor adds standalone `thinking` delta/completed events
// on top of the shared init → assistant full-message → result shape.

function claudeStreamTranslator(): Translator {
  const session = claudeCodeAdapter.createSession({
    send() {}, // telemetry is read-only — there is no stdin to write to
    emit() {},
  });
  let thinking = "";
  return (line) => {
    const ev = line as { type?: string; subtype?: string } & Record<
      string,
      unknown
    >;
    if (ev.type === "thinking") {
      // Cursor's thinking events: deltas accumulate (the reducer wants
      // cumulative snapshots), "completed"/"end" settles the step.
      if (ev.subtype === "delta") {
        thinking += str(ev.text) || str(ev.thinking) || str(ev.delta);
        return thinking ? [{ kind: "thinking", thinking }] : [];
      }
      if (ev.subtype === "completed" || ev.subtype === "end") {
        const final = str(ev.text) || str(ev.thinking) || thinking;
        thinking = "";
        return final
          ? [{ kind: "thinking", thinking: final, final: true }]
          : [];
      }
      return [];
    }
    if (ev.type === "result") thinking = "";
    return session.handleLine(line);
  };
}

// ── pi-stream ──────────────────────────────────────────────────────────────
// `pi -p` prints the RPC event stream. message_update carries the cumulative
// assistant message so far (snapshots, exactly what the reducer wants);
// turn_end/agent_settled close the run — later turns reopen it (the fold's
// run bookkeeping handles that). Cribbed from src/lib/adapters/pi.

function piToolResultText(result: unknown): string {
  const content = (result as { content?: unknown[] } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" ? str((c as Record<string, unknown>).text) : "",
    )
    .join("");
}

function piStreamTranslator(): Translator {
  return (line) => {
    const ev = line as {
      type?: string;
      message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
    };
    switch (ev.type) {
      case "agent_start":
        return [{ kind: "run-start" }];
      case "turn_end":
      case "agent_end":
      case "agent_settled":
        return [{ kind: "run-end" }];
      case "message_start":
        return ev.message?.role === "assistant"
          ? [{ kind: "segment-break" }]
          : [];
      case "message_update": {
        const content = ev.message?.content;
        const events: AgentEvent[] = [];
        const thinking = blockText(content, "thinking", "thinking");
        const text = blockText(content, "text", "text");
        if (thinking) events.push({ kind: "thinking", thinking });
        if (text) events.push({ kind: "text", text });
        return events;
      }
      case "message_end": {
        const msg = ev.message;
        if (msg?.role !== "assistant") return [];
        const events: AgentEvent[] = [];
        const thinking = blockText(msg.content, "thinking", "thinking");
        const text = blockText(msg.content, "text", "text");
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
        if (typeof ev.toolCallId !== "string") return [];
        const meta = toolStepMeta(str(ev.toolName) || "tool", ev.args);
        return [
          { kind: "step-start", id: ev.toolCallId, icon: meta.icon, label: meta.label },
        ];
      }
      case "tool_execution_update":
        return typeof ev.toolCallId === "string"
          ? [
              {
                kind: "step-update",
                id: ev.toolCallId,
                output: piToolResultText(ev.partialResult),
              },
            ]
          : [];
      case "tool_execution_end":
        return typeof ev.toolCallId === "string"
          ? [
              {
                kind: "step-end",
                id: ev.toolCallId,
                output: piToolResultText(ev.result),
                isError: ev.isError,
              },
            ]
          : [];
      default:
        return [];
    }
  };
}

// ── codex-events ───────────────────────────────────────────────────────────
// `codex exec --json`: turn.started/completed/failed bound the run;
// item.completed carries the payloads (agent_message → prose, reasoning →
// thinking, error → advisory notice, command/tool items → steps). Verified
// against the cx captures (turn.failed's error.message is the authoritative
// failure text — Durability rule 3).

interface CodexItem extends Record<string, unknown> {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
}

function codexItemStepMeta(item: CodexItem): { icon: string; label: string } | null {
  switch (item.type) {
    case "command_execution":
      return toolStepMeta("bash", { command: item.command });
    case "web_search":
      return toolStepMeta("websearch", { query: item.query });
    case "file_change":
      return { icon: "pencil", label: "Edited files" };
    case "mcp_tool_call":
      return {
        icon: "dot",
        label: `Used ${[str(item.server), str(item.tool)].filter(Boolean).join(".") || "a tool"}`,
      };
    default:
      return null;
  }
}

function codexEventsTranslator(): Translator {
  const started = new Set<string>();
  let anon = 0;
  return (line) => {
    const ev = line as {
      type?: string;
      item?: CodexItem;
      error?: { message?: string };
      message?: string;
    };
    switch (ev.type) {
      case "turn.started":
        return [{ kind: "run-start" }];
      case "turn.completed":
        return [{ kind: "run-end" }];
      case "turn.failed":
        return [
          {
            kind: "run-error",
            message: str(ev.error?.message) || "The turn failed.",
          },
          { kind: "run-end" },
        ];
      case "error":
        return [
          {
            kind: "run-error",
            message: str(ev.message) || "Codex returned an error.",
          },
        ];
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = ev.item;
        if (!item || typeof item !== "object") return [];
        const completed = ev.type === "item.completed";
        if (item.type === "agent_message") {
          const text = str(item.text);
          if (!text) return [];
          return completed
            ? [{ kind: "text", text, final: true }, { kind: "segment-break" }]
            : [{ kind: "text", text }];
        }
        if (item.type === "reasoning") {
          const text = str(item.text);
          if (!text) return [];
          return completed
            ? [
                { kind: "thinking", thinking: text, final: true },
                { kind: "segment-break" },
              ]
            : [{ kind: "thinking", thinking: text }];
        }
        if (item.type === "error") {
          // Advisory (deprecations, budget warnings) — the authoritative
          // failure arrives as turn.failed.
          const text = str(item.message) || str(item.text);
          return text ? [{ kind: "notice", variant: "warning", text }] : [];
        }
        const meta = codexItemStepMeta(item);
        if (!meta) return [];
        const id = str(item.id) || `cx-${anon++}`;
        const events: AgentEvent[] = [];
        if (!started.has(id)) {
          started.add(id);
          events.push({ kind: "step-start", id, icon: meta.icon, label: meta.label });
        }
        if (completed) {
          const output = str(item.aggregated_output) || str(item.output);
          const exit = item.exit_code;
          events.push({
            kind: "step-end",
            id,
            output: output || undefined,
            isError: typeof exit === "number" && exit !== 0,
          });
        }
        return events;
      }
      default:
        return [];
    }
  };
}

// ── opencode-events ────────────────────────────────────────────────────────
// `opencode run --print-logs --format json` style part stream: step_start/
// step_finish bound the run, tool_use parts arrive already-settled (state
// carries input/output/status), text parts are complete segments.

function opencodeEventsTranslator(): Translator {
  let anon = 0;
  return (line) => {
    const ev = line as {
      type?: string;
      part?: Record<string, unknown>;
      error?: { name?: string; data?: { message?: string } };
    };
    const part = ev.part;
    switch (ev.type) {
      case "step_start":
        return [{ kind: "run-start" }];
      case "step_finish":
        return [{ kind: "run-end" }];
      case "error":
        return [
          {
            kind: "run-error",
            message:
              str(ev.error?.data?.message) ||
              str(ev.error?.name) ||
              "opencode returned an error.",
          },
        ];
      case "text": {
        const text = str(part?.text);
        return text
          ? [{ kind: "text", text, final: true }, { kind: "segment-break" }]
          : [];
      }
      case "reasoning": {
        const thinking = str(part?.text);
        return thinking
          ? [
              { kind: "thinking", thinking, final: true },
              { kind: "segment-break" },
            ]
          : [];
      }
      case "tool_use": {
        if (!part) return [];
        const state = (part.state ?? {}) as Record<string, unknown>;
        const id = str(part.callID) || str(part.id) || `oc-${anon++}`;
        const meta = toolStepMeta(str(part.tool) || "tool", state.input);
        return [
          { kind: "step-start", id, icon: meta.icon, label: meta.label },
          {
            kind: "step-end",
            id,
            output: str(state.output) || undefined,
            isError: state.status === "error",
          },
        ];
      }
      default:
        return [];
    }
  };
}

// ── pool-events ────────────────────────────────────────────────────────────
// pool's NDJSON: `reasoning` chunks accumulate into the thinking step,
// `thought` chunks into prose, toolCall/toolCallResult are FIFO steps, and
// the `exit` tool call is the run's end. Buffers reset at each tool call so
// a new segment starts clean after a step.

function poolEventsTranslator(): Translator {
  let thinking = "";
  let text = "";
  let n = 0;
  const openSteps: string[] = [];
  return (line) => {
    const ev = line as {
      type?: string;
      reasoning?: unknown;
      thought?: unknown;
      name?: unknown;
      args?: unknown;
      result?: unknown;
    };
    switch (ev.type) {
      case "reasoning": {
        const chunk = str(ev.reasoning);
        if (!chunk) return [];
        thinking += chunk;
        return [{ kind: "thinking", thinking }];
      }
      case "thought": {
        const chunk = str(ev.thought);
        if (!chunk) return [];
        text += chunk;
        return [{ kind: "text", text }];
      }
      case "toolCall": {
        if (ev.name === "exit") return [{ kind: "run-end" }];
        const id = `pool-${n++}`;
        openSteps.push(id);
        // pool's shell tool takes `cmd`, not `command` — route it onto the
        // shared bash meta so the label reads "Ran …".
        const meta = toolStepMeta(str(ev.name) || "tool", ev.args, {
          shell: (a) => toolStepMeta("bash", { command: a.cmd ?? a.command }),
        });
        thinking = "";
        text = "";
        return [
          { kind: "segment-break" },
          { kind: "step-start", id, icon: meta.icon, label: meta.label },
        ];
      }
      case "toolCallResult": {
        const id = openSteps.shift();
        if (!id) return []; // exit's result, or a result with no open call
        return [{ kind: "step-end", id, output: str(ev.result) || undefined }];
      }
      default:
        return [];
    }
  };
}

// ── grok-stream ────────────────────────────────────────────────────────────
// grok's NDJSON: thought/text data chunks accumulate, `end` settles the run,
// `error` carries the failure message (the only shape in the live capture —
// a 403 straight from the API).

function grokStreamTranslator(): Translator {
  let thinking = "";
  let text = "";
  return (line) => {
    const ev = line as {
      type?: string;
      data?: unknown;
      text?: unknown;
      thought?: unknown;
      message?: unknown;
    };
    switch (ev.type) {
      case "thought": {
        thinking += str(ev.data) || str(ev.thought);
        return thinking ? [{ kind: "thinking", thinking }] : [];
      }
      case "text": {
        text += str(ev.data) || str(ev.text);
        return text ? [{ kind: "text", text }] : [];
      }
      case "end":
        return [{ kind: "run-end" }];
      case "error":
        return [
          {
            kind: "run-error",
            message: str(ev.message) || "The agent returned an error.",
          },
        ];
      default:
        return [];
    }
  };
}
