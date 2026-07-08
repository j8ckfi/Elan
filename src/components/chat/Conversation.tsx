// Renders the reduced conversation using Fluid Functionalism components.
// The agent's progress (thinking, tool calls, narration) streams into a single
// ThinkingSteps timeline; the final answer renders as a ChatMessage below it.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantItem,
  ChatItem,
  NoticeItem,
  QuestionItem,
  Step,
  UserItem,
} from "@/lib/pi/reducer";
import { ChatMessage } from "@/components/ui/chat-message";
import {
  ThinkingSteps,
  ThinkingStepsHeader,
  ThinkingStepsContent,
  ThinkingStep,
  ThinkingStepDetails,
} from "@/components/ui/thinking-steps";
import {
  ThinkingIndicator,
  ThinkingLabel,
} from "@/components/ui/thinking-indicator";
import {
  AskUserQuestions,
  type AskUserQuestion,
  type AskUserAnswer,
} from "@/components/ui/ask-user-questions";
import { Markdown } from "@/components/chat/Markdown";
import type { IconName } from "@/lib/icon-context";

export type AnswerFn = (
  id: string,
  response: { value: string } | { confirmed: boolean } | { cancelled: true },
) => void;

// The ThinkingSteps timeline is for genuine agent work — tool calls and the
// narration between them. Reasoning on its own isn't a "step"; a think→answer
// turn should read as just the answer. So the timeline renders only when at
// least one non-thinking step exists.
function hasTimelineSteps(steps: Step[]): boolean {
  return steps.some((s) => s.kind !== "thinking");
}

export function Conversation({
  items,
  streaming,
  onAnswer,
}: {
  items: ChatItem[];
  streaming: boolean;
  onAnswer: AnswerFn;
}) {
  const lastAssistant = [...items]
    .reverse()
    .find((i) => i.type === "assistant") as AssistantItem | undefined;
  const hasPendingQuestion = items.some((i) => i.type === "question");
  // The rose pill covers the whole reasoning phase: while streaming, before any
  // real agent work (a tool/narration step) or answer lands. A model that only
  // *thinks* then answers therefore shows just the live pill → answer, never a
  // persistent timeline — matching hidden-reasoning models like GPT-5.5.
  const showThinkingPill =
    streaming &&
    !hasPendingQuestion &&
    !!lastAssistant &&
    !hasTimelineSteps(lastAssistant.steps) &&
    !lastAssistant.answer;

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-4 px-6 py-8">
      {items.map((item) => (
        <ItemView key={item.id} item={item} onAnswer={onAnswer} />
      ))}
      {showThinkingPill && <ThinkingIndicator className="self-start" />}
    </div>
  );
}

// Memoized so only the streaming turn re-renders — the reducer preserves the
// identity of unchanged items, so React.memo skips the rest (P14).
const ItemView = memo(function ItemView({
  item,
  onAnswer,
}: {
  item: ChatItem;
  onAnswer: AnswerFn;
}) {
  switch (item.type) {
    case "user":
      return <UserView item={item} />;
    case "assistant":
      return <AssistantView item={item} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswer} />;
    case "notice":
      return <NoticeView item={item} />;
  }
});

function UserView({ item }: { item: UserItem }) {
  // data-user-msg marks the anchor the scroll controller uses to seat a new
  // turn near the top of the viewport.
  return (
    <ChatMessage from="user" data-user-msg="">
      {item.text}
    </ChatMessage>
  );
}

function AssistantView({ item }: { item: AssistantItem }) {
  return (
    <div className="flex w-full flex-col items-start gap-1.5 self-start">
      {hasTimelineSteps(item.steps) && (
        <AgentSteps
          steps={item.steps}
          streaming={item.streaming}
          hasAnswer={!!item.answer}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
        />
      )}
      {item.answer && (
        <ChatMessage from="assistant">
          <Markdown streaming={item.streaming}>{item.answer}</Markdown>
        </ChatMessage>
      )}
      {item.error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {item.error}
        </div>
      )}
    </div>
  );
}

// "Worked for 12s" / "1m 4s" — the resting header once a run has finished.
function formatWorked(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "Worked for <1s";
  if (s < 60) return `Worked for ${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `Worked for ${m}m ${rem}s` : `Worked for ${m}m`;
}

// ── Agent progress timeline ──────────────────────────────────────────────
function AgentSteps({
  steps,
  streaming,
  hasAnswer,
  startedAt,
  endedAt,
}: {
  steps: Step[];
  streaming: boolean;
  hasAnswer: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  // Collapsed at rest by default — a live run opens itself so progress is
  // visible, then re-collapses when it finishes; hydrated history stays shut.
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    // Auto-collapse once the run finishes and an answer has landed.
    if (wasStreaming.current && !streaming && hasAnswer) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming, hasAnswer]);

  const elapsed =
    startedAt != null && endedAt != null ? endedAt - startedAt : null;

  return (
    <ThinkingSteps open={open} onOpenChange={setOpen} className="w-full max-w-[34rem]">
      <ThinkingStepsHeader>
        {streaming ? (
          <ThinkingLabel />
        ) : elapsed != null ? (
          formatWorked(elapsed)
        ) : (
          `${steps.length} step${steps.length === 1 ? "" : "s"}`
        )}
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        {steps.map((s, i) => {
          // Free-form narration ("text") renders its full body inline as a
          // muted description (never truncated). Tool/thinking steps keep a
          // bold label with their output tucked into a nested collapsible.
          const isText = s.kind === "text";
          return (
            <ThinkingStep
              key={s.id}
              icon={s.icon as IconName}
              label={isText ? "" : s.label}
              description={isText ? s.output ?? s.label : undefined}
              status={s.status === "active" ? "active" : "complete"}
              isLast={i === steps.length - 1}
            >
              {!isText && s.output && s.output.trim() && (
                <ThinkingStepDetails
                  summary={s.kind === "thinking" ? "Reasoning" : "Output"}
                  details={s.output
                    .replace(/\s+$/g, "")
                    .split("\n")
                    .slice(0, 18)}
                />
              )}
            </ThinkingStep>
          );
        })}
      </ThinkingStepsContent>
    </ThinkingSteps>
  );
}

function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: AnswerFn;
}) {
  const questions = useMemo<AskUserQuestion[]>(() => {
    if (item.method === "confirm") {
      return [
        {
          id: item.id,
          title: item.title,
          options: [
            { id: "yes", title: "Yes" },
            { id: "no", title: "No" },
          ],
        },
      ];
    }
    if (item.method === "select") {
      return [
        {
          id: item.id,
          title: item.title,
          options: (item.options ?? []).map((o, i) => ({
            id: String(i),
            title: o,
          })),
        },
      ];
    }
    return [
      {
        id: item.id,
        title: item.title,
        freeText: true,
        freeTextMultiline: item.method === "editor",
        freeTextPlaceholder: item.placeholder ?? "Type your answer…",
      },
    ];
  }, [item]);

  const handleComplete = (answers: Record<string, AskUserAnswer>) => {
    const a = answers[item.id];
    if (!a) return;
    if (item.method === "confirm") {
      onAnswer(item.id, { confirmed: a.selectedIds[0] === "yes" });
    } else if (item.method === "select") {
      const idx = Number(a.selectedIds[0]);
      onAnswer(item.id, { value: (item.options ?? [])[idx] ?? "" });
    } else {
      onAnswer(item.id, { value: a.otherText ?? "" });
    }
  };

  return (
    <div className="w-full max-w-[85%] self-start">
      {item.message && (
        <p className="mb-2 px-1 text-[13px] text-muted-foreground">
          {item.message}
        </p>
      )}
      <AskUserQuestions questions={questions} onComplete={handleComplete} />
    </div>
  );
}

function NoticeView({ item }: { item: NoticeItem }) {
  return (
    <div className="self-center text-[12px] text-muted-foreground">
      {item.text}
    </div>
  );
}
