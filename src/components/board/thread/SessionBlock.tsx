// The session block — a session-start event line's working timeline
// (docs/FRONTEND.md "Session telemetry"). Live sessions render the agent
// mark + a shimmering current-step label + the gradient-spin (a harness
// process is live right now), with the collapsed ThinkingSteps timeline
// beneath; completed sessions rest as "Worked for 42s ▸" and replay the
// on-disk log lazily on first expand. Harnesses without a stream translator
// get the honest fallback: the raw log tail in a fenced block, same
// affordance. Error sessions keep the host's ⚠︎ post as their headline —
// this block is only the detail beneath the event line.

import { useMemo, useState } from "react";
import { GradientSpin } from "gradient-spin";
import type { ChatItem } from "@/lib/agent/types";
import type { AgentSessionRecord, RosterEntry } from "@/lib/board/types";
import { useBoard, useSessionTelemetry } from "@/lib/board/useBoard";
import type { SessionLine } from "@/lib/board/telemetry";
import { AgentAvatar } from "@/components/board/glyphs";
import {
  ThinkingSteps,
  ThinkingStepsHeader,
  ThinkingStepsContent,
  ThinkingStep,
  ThinkingStepDetails,
} from "@/components/ui/thinking-steps";
import type { IconName } from "@/lib/icon-context";

const RAW_TAIL_LINES = 60;

// ── Timeline rows (flattened from the folded ChatItems) ───────────────────

type Row =
  | {
      key: string;
      kind: "step";
      icon: string;
      label: string;
      active: boolean;
      output?: string;
      thinking: boolean;
    }
  | { key: string; kind: "prose"; text: string }
  | { key: string; kind: "notice"; text: string };

function toRows(items: ChatItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.type === "notice") {
      rows.push({ key: item.id, kind: "notice", text: item.text });
      continue;
    }
    if (item.type !== "assistant") continue;
    for (const part of item.parts) {
      if (part.kind === "prose") {
        if (part.text.trim())
          rows.push({ key: part.id, kind: "prose", text: part.text });
        continue;
      }
      for (const s of part.steps) {
        rows.push({
          key: s.id,
          kind: "step",
          icon: s.icon,
          label: s.label,
          active: s.status === "active",
          output: s.output,
          thinking: s.kind === "thinking",
        });
      }
    }
    if (item.error)
      rows.push({ key: `${item.id}-error`, kind: "notice", text: item.error });
  }
  return rows;
}

// "42s" / "1m 4s" — duration piece of the resting header.
function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// ── The block ──────────────────────────────────────────────────────────────

export function SessionBlock({
  sessionId,
  roster,
}: {
  sessionId: string;
  roster: RosterEntry[];
}) {
  // Session records arrive read-only on the board state (host mode); the
  // block resolves its own record so ActivityFeed's props stay unchanged.
  const board = useBoard();
  const session = board.sessions.find((s) => s.id === sessionId);
  return <SessionBlockInner session={session} roster={roster} />;
}

function SessionBlockInner({
  session,
  roster,
}: {
  session: AgentSessionRecord | undefined;
  roster: RosterEntry[];
}) {
  const telemetry = useSessionTelemetry(session);
  const [open, setOpen] = useState(false);

  const rows = useMemo(
    () => toRows(telemetry?.items ?? []),
    [telemetry?.items],
  );

  // Local mode / unknown session: the event line stands alone.
  if (!session || !telemetry) return null;

  const { live, raw, loaded, loading, error, lines, load } = telemetry;
  const steps = rows.filter((r) => r.kind === "step");

  // Nothing to show for a finished session with no log to replay.
  if (!live && !session.logPath && !loaded) return null;

  const lastStep = steps[steps.length - 1];
  const liveLabel = (lastStep?.active && lastStep.label) || "Working";

  const duration =
    session.endedAt != null ? session.endedAt - session.startedAt : null;
  const restingLabel = `${
    duration != null ? `Worked for ${formatDuration(duration)}` : "Worked"
  }${loaded && !raw && steps.length > 0 ? ` · ${steps.length} step${steps.length === 1 ? "" : "s"}` : ""}`;

  return (
    <div className="ml-[14px] pb-1">
      <ThinkingSteps
        open={open}
        onOpenChange={(next: boolean) => {
          setOpen(next);
          // The lazy replay: completed sessions fetch + fold on first expand.
          if (next) load();
        }}
        className="w-full max-w-[34rem]"
      >
        <ThinkingStepsHeader>
          {live ? (
            <span className="inline-flex items-center gap-2">
              <AgentAvatar author={session.handle} roster={roster} size={14} />
              <span className="shimmer-run">{liveLabel}</span>
              <GradientSpin cellSize={2.5} cellGap={1.25} label="Working" />
            </span>
          ) : (
            restingLabel
          )}
        </ThinkingStepsHeader>
        <ThinkingStepsContent>
          <SessionTimeline
            rows={rows}
            raw={raw}
            lines={lines}
            loading={loading}
            loaded={loaded}
            fetchError={error}
            live={live}
          />
        </ThinkingStepsContent>
      </ThinkingSteps>
    </div>
  );
}

// ── Panel content ──────────────────────────────────────────────────────────

function SessionTimeline({
  rows,
  raw,
  lines,
  loading,
  loaded,
  fetchError,
  live,
}: {
  rows: Row[];
  raw: boolean;
  lines: SessionLine[];
  loading: boolean;
  loaded: boolean;
  fetchError: string | null;
  live: boolean;
}) {
  if (fetchError)
    return <MutedLine>Couldn't load the session log.</MutedLine>;
  if (loading && !loaded) return <MutedLine>Loading the session log…</MutedLine>;

  // No stream translator for this harness — the raw log tail, honestly.
  if (raw) {
    const tail = lines.slice(-RAW_TAIL_LINES);
    if (tail.length === 0)
      return <MutedLine>{live ? "No output yet." : "The log is empty."}</MutedLine>;
    return (
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-accent/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {tail.map((l) => l.line).join("\n")}
      </pre>
    );
  }

  if (rows.length === 0)
    return (
      <MutedLine>
        {live ? "No output yet." : "Nothing parseable in this session's log."}
      </MutedLine>
    );

  return (
    <>
      {rows.map((row, i) => {
        const isLast = i === rows.length - 1;
        if (row.kind === "step") {
          return (
            <ThinkingStep
              key={row.key}
              icon={row.icon as IconName}
              label={row.label}
              status={row.active ? "active" : "complete"}
              isLast={isLast}
            >
              {row.output && row.output.trim() && (
                <ThinkingStepDetails
                  summary={row.thinking ? "Reasoning" : "Output"}
                  details={row.output
                    .replace(/\s+$/g, "")
                    .split("\n")
                    .slice(0, 18)}
                />
              )}
            </ThinkingStep>
          );
        }
        // Prose/notice rows slot into the timeline as icon-less entries so
        // the connector line keeps flowing through them.
        return (
          <ThinkingStep
            key={row.key}
            showIcon={false}
            label=""
            description={row.text}
            isLast={isLast}
          />
        );
      })}
    </>
  );
}

function MutedLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-1 text-[12px] text-muted-foreground">{children}</p>
  );
}
