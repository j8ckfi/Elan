// The content panel's list mode — Linear's issue list, 1:1. Pure function of
// BoardState + a mode; renders fine with zero threads/sessions.
// See docs/FRONTEND.md "Thread list".

import { useMemo } from "react";
import {
  AvatarStack,
  STATUS_META,
  StatusGlyph,
} from "@/components/board/glyphs";
import { useBoard } from "@/lib/board/useBoard";
import { relativeTime } from "@/lib/relative-time";
import type { Author, Project, RosterEntry, Thread, ThreadStatus } from "@/lib/board/types";
import { USER } from "@/lib/board/types";
import { cn } from "@/lib/utils";

// Board-list group order — not the union's declaration order.
const GROUP_ORDER: ThreadStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "done",
  "canceled",
];

export interface ThreadListProps {
  mode: "inbox" | "mine" | "project";
  projectId?: string;
  onOpenThread: (id: string) => void;
  onNewThread: (projectId?: string) => void;
}

export function ThreadList({ mode, projectId, onOpenThread, onNewThread }: ThreadListProps) {
  const board = useBoard();

  const project = projectId ? board.projects.find((p) => p.id === projectId) : undefined;
  const projectsById = useMemo(
    () => new Map(board.projects.map((p) => [p.id, p])),
    [board.projects],
  );

  const threads = useMemo(() => {
    const base =
      mode === "mine"
        ? board.threads.filter((t) => t.createdBy === USER)
        : mode === "project"
          ? board.threads.filter((t) => t.projectId === projectId)
          : board.threads;
    return [...base].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [board.threads, mode, projectId]);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((status) => ({
        status,
        items: threads.filter((t) => t.status === status),
      })).filter((g) => g.items.length > 0),
    [threads],
  );

  const runningThreadIds = useMemo(
    () => new Set(board.sessions.filter((s) => s.state === "running").map((s) => s.threadId)),
    [board.sessions],
  );

  const participantsByThread = useMemo(() => {
    const map = new Map<string, Author[]>();
    for (const p of board.posts) {
      if (p.author === USER) continue;
      const seen = map.get(p.threadId) ?? [];
      if (!seen.includes(p.author)) seen.push(p.author);
      map.set(p.threadId, seen);
    }
    for (const s of board.sessions) {
      const seen = map.get(s.threadId) ?? [];
      if (!seen.includes(s.handle)) seen.push(s.handle);
      map.set(s.threadId, seen);
    }
    return map;
  }, [board.posts, board.sessions]);

  const viewName = mode === "inbox" ? "Inbox" : mode === "mine" ? "My threads" : (project?.name ?? "Project");
  const showProjectChip = mode !== "project";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The tab row above owns the traffic-light inset now — plain padding. */}
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border pl-4 pr-3">
        <div className="flex items-baseline gap-2 select-none">
          <h1 className="text-[13px] font-medium text-foreground">{viewName}</h1>
          <span className="text-[12px] tabular-nums text-muted-foreground">{threads.length}</span>
        </div>
        <button
          onClick={() => onNewThread(mode === "project" ? projectId : undefined)}
          className={cn(
            "rounded-md border border-border px-2.5 py-1 text-[13px] text-foreground/80",
            "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
            "hover:bg-hover hover:text-foreground active:scale-97",
          )}
        >
          New thread
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-muted-foreground">
            <p>No threads yet</p>
            <button
              onClick={() => onNewThread(mode === "project" ? projectId : undefined)}
              className={cn(
                "rounded-md border border-border px-3 py-1.5 text-foreground",
                "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "hover:bg-hover active:scale-97",
              )}
            >
              New thread
            </button>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.status}>
              <div className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-background/95 px-4 backdrop-blur">
                <StatusGlyph status={g.status} size={14} />
                <span className="text-[13px] text-foreground">{STATUS_META[g.status].label}</span>
                <span className="text-[12px] tabular-nums text-muted-foreground">{g.items.length}</span>
              </div>
              {g.items.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  project={projectsById.get(t.projectId)}
                  showProjectChip={showProjectChip}
                  running={runningThreadIds.has(t.id)}
                  participants={participantsByThread.get(t.id) ?? []}
                  roster={board.roster}
                  onOpen={() => onOpenThread(t.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  project,
  showProjectChip,
  running,
  participants,
  roster,
  onOpen,
}: {
  thread: Thread;
  project: Project | undefined;
  showProjectChip: boolean;
  running: boolean;
  participants: Author[];
  roster: RosterEntry[];
  onOpen: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      className="flex h-9 cursor-default items-center gap-2 px-4 transition-colors duration-100 hover:bg-hover"
    >
      <StatusGlyph status={thread.status} size={16} className="shrink-0" />
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {project ? `${project.key}-${thread.number}` : thread.number}
      </span>
      {showProjectChip && project && (
        <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted-foreground">
          {project.key}
        </span>
      )}
      <span className={cn("min-w-0 flex-1 truncate text-[13px] text-foreground", running && "shimmer-run")}>
        {thread.title}
      </span>
      <AvatarStack authors={participants} roster={roster} size={18} max={3} className="shrink-0" />
      <span className="shrink-0 text-right text-[12px] tabular-nums text-muted-foreground" style={{ minWidth: 40 }}>
        {relativeTime(thread.updatedAt)}
      </span>
    </div>
  );
}
