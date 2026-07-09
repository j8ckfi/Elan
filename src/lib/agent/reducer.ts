// Folds the neutral AgentEvent stream into a renderable conversation.
//
// This is the ONE place streaming bookkeeping lives — part interleaving,
// prose/work chunking, step lifecycle, work-chunk timers. Adapters never
// touch it: they translate their wire protocol into AgentEvents and the fold
// is identical for every backend.
//
// Rendering model: an assistant run is an ORDERED list of `parts`. Each part is
// either `prose` (a rendered markdown segment) or `work` (a chunk of the
// thinking/tool timeline). Prose is first-class and positional — text that
// appears between two tool calls stays between them, and text that shares a
// segment with a tool call is NOT swallowed. Interleaving (prose → work →
// prose → work) falls out for free; the "answer" is simply the trailing prose.

import type {
  AgentEvent,
  AssistantItem,
  ChatItem,
  ImageAttachment,
  RunPart,
  Step,
} from "./types";

export interface SessionViewState {
  items: ChatItem[];
  streaming: boolean;
  currentAssistantId: string | null;
  /** The thinking step being streamed into for the current segment, if any. */
  currentThinkingStepId: string | null;
  /** The prose part being streamed into for the current segment, if any. */
  currentProseId: string | null;
  queue: { steering: string[]; followUp: string[] };
  seq: number;
}

export const initialState: SessionViewState = {
  items: [],
  streaming: false,
  currentAssistantId: null,
  currentThinkingStepId: null,
  currentProseId: null,
  queue: { steering: [], followUp: [] },
  seq: 0,
};

/** Engine-local actions (not from the wire). */
export type LocalAction =
  | { type: "@user"; text: string; images?: number }
  | { type: "@reset" }
  | { type: "@resolveQuestion"; id: string };

export type ReducerInput = AgentEvent | LocalAction;

// ── parts helpers ────────────────────────────────────────────────────────────
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
function replaceLast(parts: RunPart[], part: RunPart): RunPart[] {
  return [...parts.slice(0, -1), part];
}

/** Add/update a work step in the trailing work part, opening a fresh one (and
 *  closing nothing) if the trailing part is prose or the run is empty. */
function stepIntoWork(
  parts: RunPart[],
  step: Step,
  workId: string,
  now: number,
): RunPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "work")
    return replaceLast(parts, { ...last, steps: upsertStep(last.steps, step) });
  return [...parts, { kind: "work", id: workId, steps: [step], startedAt: now }];
}

/** Patch a step wherever it lives. */
function patchWorkStep(
  parts: RunPart[],
  id: string,
  patch: Partial<Step>,
): RunPart[] {
  return parts.map((p) =>
    p.kind === "work" && p.steps.some((s) => s.id === id)
      ? { ...p, steps: patchStep(p.steps, id, patch) }
      : p,
  );
}

/** Create or update the trailing prose part. Creating one closes an open
 *  trailing work chunk (stamps its endedAt) so its timer settles. */
function writeProse(
  parts: RunPart[],
  proseId: string,
  text: string,
  streaming: boolean,
  now: number,
): RunPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "prose" && last.id === proseId)
    return replaceLast(parts, { ...last, text, streaming });
  const base =
    last?.kind === "work" && last.endedAt == null
      ? replaceLast(parts, { ...last, endedAt: now })
      : parts;
  return [...base, { kind: "prose", id: proseId, text, streaming }];
}

// ── assistant-item mutation helpers ──────────────────────────────────────────
function updateAssistant(
  state: SessionViewState,
  fn: (a: AssistantItem) => AssistantItem,
): SessionViewState {
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

/** Ensure an assistant run item exists (run-start normally creates it, but be
 *  defensive if a step/text arrives first). Returns [state, assistantId]. */
function ensureAssistant(state: SessionViewState): [SessionViewState, string] {
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
          parts: [],
          streaming: true,
          startedAt: Date.now(),
        },
      ],
    },
    id,
  ];
}

// ── reducer ──────────────────────────────────────────────────────────────────
export function reduce(
  state: SessionViewState,
  ev: ReducerInput,
): SessionViewState {
  if ("type" in ev) {
    switch (ev.type) {
      case "@reset":
        return { ...initialState };

      case "@user":
        return {
          ...state,
          seq: state.seq + 1,
          currentAssistantId: null,
          currentThinkingStepId: null,
          currentProseId: null,
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
        return {
          ...state,
          items: state.items.filter((it) => it.id !== ev.id),
        };
    }
    return state;
  }

  const e = ev;
  switch (e.kind) {
    case "run-start": {
      const id = `a${state.seq}`;
      return {
        ...state,
        seq: state.seq + 1,
        streaming: true,
        currentAssistantId: id,
        currentThinkingStepId: null,
        currentProseId: null,
        items: [
          ...state.items,
          {
            type: "assistant",
            id,
            parts: [],
            streaming: true,
            startedAt: Date.now(),
          },
        ],
      };
    }

    case "run-end": {
      const now = Date.now();
      const s = updateAssistant(state, (a) => ({
        ...a,
        streaming: false,
        endedAt: now,
        parts: a.parts.map((p) =>
          p.kind === "work"
            ? {
                ...p,
                endedAt: p.endedAt ?? now,
                steps: p.steps.map((st) =>
                  st.status === "active" ? { ...st, status: "complete" } : st,
                ),
              }
            : { ...p, streaming: false },
        ),
      }));
      return {
        ...s,
        streaming: false,
        currentThinkingStepId: null,
        currentProseId: null,
      };
    }

    case "segment-break":
      // Next text/thinking snapshot gets a fresh prose part / thinking step.
      return { ...state, currentThinkingStepId: null, currentProseId: null };

    case "thinking": {
      if (!e.thinking) return state;
      let [next, id] = ensureAssistant(state);
      let thinkId = next.currentThinkingStepId;
      let seq = next.seq;
      const now = Date.now();
      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => {
        let parts = a.parts;
        if (!thinkId) {
          thinkId = `t${seq++}`;
          parts = stepIntoWork(
            parts,
            {
              id: thinkId,
              kind: "thinking",
              icon: "brain",
              label: "Thinking",
              output: e.thinking,
              status: e.final ? "complete" : "active",
            },
            `w${seq++}`,
            now,
          );
        } else {
          parts = patchWorkStep(parts, thinkId, {
            output: e.thinking,
            ...(e.final ? { status: "complete" as const } : {}),
          });
        }
        return { ...a, parts };
      });
      return {
        ...next,
        seq,
        currentThinkingStepId: e.final ? null : thinkId,
      };
    }

    case "text": {
      if (!e.text) return state;
      let [next, id] = ensureAssistant(state);
      let proseId = next.currentProseId;
      let seq = next.seq;
      const now = Date.now();
      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => {
        if (!proseId) proseId = `p${seq++}`;
        return {
          ...a,
          parts: writeProse(a.parts, proseId, e.text, !e.final, now),
        };
      });
      return { ...next, seq, currentProseId: e.final ? null : proseId };
    }

    case "run-error":
      return updateAssistant(state, (a) => ({ ...a, error: e.message }));

    case "step-start": {
      let [next, id] = ensureAssistant(state);
      const now = Date.now();
      const workId = `w${next.seq}`;
      next = updateAssistant({ ...next, currentAssistantId: id }, (a) => ({
        ...a,
        parts: stepIntoWork(
          a.parts,
          {
            id: e.id,
            kind: "tool",
            icon: e.icon,
            label: e.label,
            status: "active",
          },
          workId,
          now,
        ),
      }));
      // A work chunk opened → the current prose segment is done; later text
      // starts a fresh prose part (a new bubble below this chunk).
      return { ...next, seq: next.seq + 1, currentProseId: null };
    }

    case "step-update":
      return updateAssistant(state, (a) => ({
        ...a,
        parts: patchWorkStep(a.parts, e.id, { output: e.output }),
      }));

    case "step-end":
      return updateAssistant(state, (a) => ({
        ...a,
        parts: patchWorkStep(a.parts, e.id, {
          status: e.isError ? "error" : "complete",
          ...(e.output !== undefined ? { output: e.output } : {}),
        }),
      }));

    case "question":
      return {
        ...state,
        items: [...state.items, { type: "question", ...e.question }],
      };

    case "question-resolved":
      return {
        ...state,
        items: state.items.filter(
          (it) => !(it.type === "question" && it.id === e.id),
        ),
      };

    case "notice": {
      const id = e.sticky ?? `n${state.seq}`;
      return {
        ...state,
        seq: e.sticky ? state.seq : state.seq + 1,
        items: [
          ...state.items.filter((it) => it.id !== id),
          { type: "notice", id, variant: e.variant, text: e.text },
        ],
      };
    }

    case "notice-clear":
      return {
        ...state,
        items: state.items.filter((it) => it.id !== e.sticky),
      };

    case "queue":
      return {
        ...state,
        queue: { steering: e.steering ?? [], followUp: e.followUp ?? [] },
      };

    case "hydrate":
      return {
        ...initialState,
        items: e.items,
        seq: e.items.length + 1,
      };

    // meta/activity are engine-level (model, identity, stats, sidebar refresh)
    // — handled in useAgentSession, not part of the transcript.
    case "meta":
    case "activity":
      return state;

    default:
      return state;
  }
}

// ── TranscriptBuilder — hydration helper ─────────────────────────────────────
// Rebuilds a conversation from a persisted transcript with the same ordered
// prose/work part routing as the live fold, so a reload is pixel-identical to
// the streamed original. Adapters walk their transcript format in document
// order and call these; ids are assigned internally.
export class TranscriptBuilder {
  private out: ChatItem[] = [];
  private current: AssistantItem | null = null;
  private n = 0;
  private seq = 0;

  private flush() {
    if (this.current) this.out.push(this.current);
    this.current = null;
  }

  private assistant(ts?: number): AssistantItem {
    if (!this.current) {
      this.current = {
        type: "assistant",
        id: `a${this.n++}`,
        parts: [],
        streaming: false,
      };
    }
    const a = this.current;
    // Timestamps span the run: earliest starts it, latest ends it.
    if (ts != null) {
      a.startedAt = a.startedAt ?? ts;
      a.endedAt = ts;
    }
    return a;
  }

  private stampTrailingWork(a: AssistantItem, now: number) {
    const last = a.parts[a.parts.length - 1];
    if (last?.kind === "work") last.endedAt = now;
  }

  /** A user turn — closes the open assistant run. Empty text is skipped. */
  user(text: string, ts?: number, images?: number): this {
    this.flush();
    if (text.trim())
      this.out.push({
        type: "user",
        id: `u${this.n++}`,
        text,
        images,
        createdAt: ts,
      });
    return this;
  }

  /** A prose segment of the current assistant run. */
  prose(text: string, ts?: number): this {
    if (!text.trim()) return this;
    const a = this.assistant(ts);
    const now = ts ?? a.endedAt ?? 0;
    a.parts = writeProse(a.parts, `p${this.seq++}`, text, false, now);
    return this;
  }

  /** A completed thinking segment of the current assistant run. */
  thinking(text: string, ts?: number): this {
    if (!text.trim()) return this;
    const a = this.assistant(ts);
    const now = ts ?? a.endedAt ?? 0;
    a.parts = stepIntoWork(
      a.parts,
      {
        id: `t${this.seq++}`,
        kind: "thinking",
        icon: "brain",
        label: "Thinking",
        output: text,
        status: "complete",
      },
      `w${this.seq++}`,
      now,
    );
    this.stampTrailingWork(a, now);
    return this;
  }

  /** A tool step (assumed complete until stepResult patches it). */
  step(id: string, icon: string, label: string, ts?: number): this {
    const a = this.assistant(ts);
    const now = ts ?? a.endedAt ?? 0;
    a.parts = stepIntoWork(
      a.parts,
      { id, kind: "tool", icon, label, status: "complete" },
      `w${this.seq++}`,
      now,
    );
    this.stampTrailingWork(a, now);
    return this;
  }

  /** Attach a result to an earlier step (matched by id, wherever it lives). */
  stepResult(id: string, output?: string, isError?: boolean, ts?: number): this {
    const a = this.current;
    if (!a) return this;
    a.parts = a.parts.map((p) =>
      p.kind === "work" && p.steps.some((s) => s.id === id)
        ? {
            ...p,
            endedAt: ts ?? p.endedAt,
            steps: patchStep(p.steps, id, {
              status: isError ? "error" : "complete",
              output: output ?? p.steps.find((s) => s.id === id)?.output,
            }),
          }
        : p,
    );
    return this;
  }

  /** Mark the current assistant run as errored. */
  error(message: string): this {
    const a = this.assistant();
    a.error = message;
    return this;
  }

  items(): ChatItem[] {
    this.flush();
    return this.out;
  }
}

/** Attachments → base64 image payloads (shared by the engine and adapters). */
export async function filesToImageAttachments(
  files: File[],
): Promise<ImageAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      return {
        type: "image" as const,
        data: btoa(binary),
        mimeType: file.type || "application/octet-stream",
      };
    }),
  );
}
