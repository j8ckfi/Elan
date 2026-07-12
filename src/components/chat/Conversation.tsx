// Renders the reduced conversation using Fluid Functionalism components.
// The agent's progress (thinking, tool calls, narration) streams into a single
// ThinkingSteps timeline; the final answer renders as a ChatMessage below it.

import { memo, useMemo, useState } from "react";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import type {
  AssistantItem,
  ChatItem,
  NoticeItem,
  QuestionItem,
  RunPart,
  WorkPart,
  UserItem,
} from "@/lib/agent/types";
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
import { copyText } from "@/lib/copy-text";
import type { IconName } from "@/lib/icon-context";

export type AnswerFn = (
  id: string,
  response: { value: string } | { confirmed: boolean } | { cancelled: true },
) => void;

// The ThinkingSteps timeline is for genuine agent work — tool calls (and the
// reasoning around them). Reasoning on its own isn't a "step"; a think→answer
// turn should read as just the answer. So a work chunk renders only when it
// contains at least one tool call; a thinking-only chunk stays invisible at
// rest (the live rose pill covers the reasoning phase).
function workHasTool(part: RunPart): boolean {
  return part.kind === "work" && part.steps.some((s) => s.kind === "tool");
}

export function Conversation({
  items,
  streaming,
  onAnswer,
  onExpandTrace,
}: {
  items: ChatItem[];
  streaming: boolean;
  onAnswer: AnswerFn;
  /** The reader expanded a work-trace to read it — stop following the live edge
   *  so new steps don't drag them down. */
  onExpandTrace?: () => void;
}) {
  const lastAssistant = [...items]
    .reverse()
    .find((i) => i.type === "assistant") as AssistantItem | undefined;
  const hasPendingQuestion = items.some((i) => i.type === "question");
  // The rose pill covers the whole reasoning phase: while streaming, before any
  // visible agent work (a tool chunk) or prose lands. A model that only *thinks*
  // then answers therefore shows just the live pill → answer, never a persistent
  // timeline — matching hidden-reasoning models like GPT-5.5.
  const showThinkingPill =
    streaming &&
    !hasPendingQuestion &&
    !!lastAssistant &&
    !lastAssistant.parts.some(workHasTool) &&
    !lastAssistant.parts.some((p) => p.kind === "prose" && p.text.trim());

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-4 px-6 py-8">
      {items.map((item) => (
        <ItemView
          key={item.id}
          item={item}
          onAnswer={onAnswer}
          onExpandTrace={onExpandTrace}
        />
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
  onExpandTrace,
}: {
  item: ChatItem;
  onAnswer: AnswerFn;
  onExpandTrace?: () => void;
}) {
  switch (item.type) {
    case "user":
      return <UserView item={item} />;
    case "assistant":
      return <AssistantView item={item} onExpandTrace={onExpandTrace} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswer} />;
    case "notice":
      return <NoticeView item={item} />;
  }
});

// "3:45 PM", or "Jul 7, 3:45 PM" when it isn't today.
function formatTime(ms?: number): string | undefined {
  if (!ms) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// Icon-only copy control for the hover meta row; flips to a check briefly.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy message"}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-[color,background-color,transform] duration-100 hover:bg-hover hover:text-foreground active:scale-[0.96]"
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

function UserView({ item }: { item: UserItem }) {
  // data-user-msg marks the anchor the scroll controller uses to seat a new
  // turn near the top of the viewport.
  return (
    <ChatMessage
      from="user"
      data-user-msg=""
      time={formatTime(item.createdAt)}
      actions={<CopyButton text={item.text} />}
    >
      {item.text}
    </ChatMessage>
  );
}

function AssistantView({
  item,
  onExpandTrace,
}: {
  item: AssistantItem;
  onExpandTrace?: () => void;
}) {
  // The settled per-prose timestamp is the run's end (message-granular timing).
  const settledAt = item.endedAt ?? item.startedAt;
  const lastIndex = item.parts.length - 1;
  // Only the final prose segment carries the time/copy meta row. Interleaved
  // narration segments stay chrome-free — a meta row under each one reserves
  // height even when hidden, which reads as arbitrary extra gaps mid-turn.
  const lastProseIndex = item.parts.reduce(
    (acc, p, i) => (p.kind === "prose" && p.text ? i : acc),
    -1,
  );
  return (
    <div className="flex w-full flex-col items-start gap-1.5 self-start">
      {item.parts.map((part, i) => {
        if (part.kind === "prose") {
          if (!part.text) return null;
          const showMeta = i === lastProseIndex && !part.streaming;
          return (
            <ChatMessage
              key={part.id}
              from="assistant"
              // Time + copy appear once the segment has settled (not mid-stream).
              time={showMeta ? formatTime(settledAt) : undefined}
              actions={showMeta ? <CopyButton text={part.text} /> : undefined}
            >
              <Markdown streaming={part.streaming}>{part.text}</Markdown>
            </ChatMessage>
          );
        }
        // Reasoning-only chunks stay invisible at rest (see workHasTool).
        if (!workHasTool(part)) return null;
        return (
          <WorkView
            key={part.id}
            part={part}
            // Only the trailing chunk of a still-streaming run is "live".
            live={item.streaming && i === lastIndex}
            onExpand={onExpandTrace}
          />
        );
      })}
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

// ── Agent progress timeline (one work chunk) ─────────────────────────────
function WorkView({
  part,
  live,
  onExpand,
}: {
  part: WorkPart;
  live: boolean;
  onExpand?: () => void;
}) {
  // Collapsed by default — even while streaming. An open timeline that grows a
  // step at a time drags the reader down on every new trace; keeping it shut
  // (the header shows the live "Working…" label) means nothing pulls them. The
  // reader can expand it to read, and doing so disengages follow (onExpand) so
  // subsequent steps still never yank them.
  const [open, setOpen] = useState(false);
  const { steps, startedAt, endedAt } = part;

  const elapsed =
    startedAt != null && endedAt != null ? endedAt - startedAt : null;

  return (
    <ThinkingSteps
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) onExpand?.();
      }}
      className="w-full max-w-[34rem]"
    >
      <ThinkingStepsHeader>
        {live ? (
          <ThinkingLabel />
        ) : elapsed != null ? (
          formatWorked(elapsed)
        ) : (
          `${steps.length} step${steps.length === 1 ? "" : "s"}`
        )}
      </ThinkingStepsHeader>
      <ThinkingStepsContent>
        {steps.map((s, i) => (
          <ThinkingStep
            key={s.id}
            icon={s.icon as IconName}
            label={s.label}
            status={s.status === "active" ? "active" : "complete"}
            isLast={i === steps.length - 1}
          >
            {s.output && s.output.trim() && (
              <ThinkingStepDetails
                summary={s.kind === "thinking" ? "Reasoning" : "Output"}
                details={s.output
                  .replace(/\s+$/g, "")
                  .split("\n")
                  .slice(0, 18)}
              />
            )}
          </ThinkingStep>
        ))}
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
