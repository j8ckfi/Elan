// The 280px properties rail — Linear's right column. Status mutates the
// store; Agents/Project/Labels display. Hidden below ~900px pane width (the
// content column wins), via a container query on ThreadView.

import type { ReactNode } from "react";
import { GradientSpin } from "gradient-spin";
import { boardStore } from "@/lib/board/useBoard";
import {
  USER,
  type AgentSessionRecord,
  type Project,
  type RosterEntry,
  type Thread,
  type ThreadStatus,
} from "@/lib/board/types";
import { AgentAvatar, StatusGlyph, STATUS_META } from "@/components/board/glyphs";
import {
  DropdownMenu,
  DropdownTrigger,
  DropdownContent,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import type { IconComponent } from "@/lib/icon-context";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { ClockGlyph } from "./glyphlets";

const STATUS_ORDER: ThreadStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];

// MenuItem wants IconComponent; the glyphs want their variant prop. Stable
// per-variant wrappers bridge the two.
const STATUS_ICONS = Object.fromEntries(
  STATUS_ORDER.map((s) => [
    s,
    ({ size, className }: { size?: number; className?: string }) => (
      <StatusGlyph status={s} size={size ?? 14} className={className} />
    ),
  ]),
) as Record<ThreadStatus, IconComponent>;

interface PropertiesRailProps {
  thread: Thread;
  project: Project;
  roster: RosterEntry[];
  sessions: AgentSessionRecord[];
}

export function PropertiesRail({ thread, project, roster, sessions }: PropertiesRailProps) {
  // Latest session per handle, first-started order.
  const byHandle = new Map<string, AgentSessionRecord>();
  for (const s of [...sessions]
    .filter((s) => s.threadId === thread.id)
    .sort((a, b) => a.startedAt - b.startedAt)) {
    byHandle.set(s.handle, s);
  }
  const agents = [...byHandle.values()];

  return (
    <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-l border-border px-4 pt-6 pb-6 @min-[900px]:block">
      <div className="flex flex-col gap-3.5">
        <Row label="Status">
          <DropdownMenu>
            <DropdownTrigger render={<button type="button" className={triggerClass} />}>
              <StatusGlyph status={thread.status} size={14} />
              <span>{STATUS_META[thread.status].label}</span>
            </DropdownTrigger>
            <DropdownContent
              className="w-52"
              checkedIndex={STATUS_ORDER.indexOf(thread.status)}
            >
              {STATUS_ORDER.map((s, i) => (
                <MenuItem
                  key={s}
                  index={i}
                  icon={STATUS_ICONS[s]}
                  label={STATUS_META[s].label}
                  checked={s === thread.status}
                  onSelect={() => boardStore().updateThread(thread.id, { status: s }, USER)}
                />
              ))}
            </DropdownContent>
          </DropdownMenu>
        </Row>

        {agents.length > 0 && (
          <Row label="Agents">
            <div className="flex flex-col gap-1.5 pt-0.5">
              {agents.map((session) => (
                <AgentRow key={session.handle} session={session} roster={roster} />
              ))}
            </div>
          </Row>
        )}

        <Row label="Project">
          <div className="flex items-center gap-2 py-0.5 text-[13px] text-foreground">
            <span className="truncate">{project.name}</span>
          </div>
        </Row>

        {thread.labels.length > 0 && (
          <Row label="Labels">
            <div className="flex flex-wrap gap-1 pt-0.5">
              {thread.labels.map((label) => (
                <span
                  key={label}
                  className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          </Row>
        )}

        <div className="mt-2.5 text-[12px] text-muted-foreground">
          Created {relativeTime(thread.createdAt)} · Updated {relativeTime(thread.updatedAt)}
        </div>
      </div>
    </aside>
  );
}

const triggerClass = cn(
  "-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-foreground",
  "transition-colors hover:bg-hover active:scale-[0.97]",
);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-20 shrink-0 pt-1 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ── Agent rows ───────────────────────────────────────────────────────────

function AgentRow({ session, roster }: { session: AgentSessionRecord; roster: RosterEntry[] }) {
  const running = session.state === "running" || session.state === "spawning";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar
        author={session.handle}
        roster={roster}
        size={18}
        // Liveness: ring only, never a pulse.
        className={cn(running && "ring-2 ring-ring")}
      />
      <span className="truncate text-[13px] text-foreground">@{session.handle}</span>
      <SessionChip record={session} />
    </div>
  );
}

function SessionChip({ record }: { record: AgentSessionRecord }) {
  const { state } = record;
  if (state === "running" || state === "spawning") {
    return <GradientSpin className="ml-auto shrink-0" label="Running" title="Running" />;
  }
  if (state === "waiting") {
    return (
      <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <ClockGlyph />
        Waiting
      </span>
    );
  }
  // Queued: same muted-text register as Waiting, but no clock — nothing is
  // running yet, so there's nothing to be "waiting" on.
  if (state === "queued") {
    return (
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Queued</span>
    );
  }
  return (
    <span
      className="ml-auto shrink-0 text-[11px] text-muted-foreground"
      title={state === "error" ? record.reason : undefined}
    >
      {state === "error" ? "Error" : "Done"}
    </span>
  );
}
