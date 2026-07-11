// The board sidebar — ours, not Linear's. Inbox / My threads / Projects,
// each project expandable to its threads. See docs/FRONTEND.md "Sidebar".
// Structurally cribbed from SessionSidebar: ui/sidebar shell, drag-resize
// rail, traffic-light inset, footer.

import { useCallback, useMemo, useState } from "react";
import {
  IconChevronRight,
  IconDots,
  IconInbox,
  IconPlus,
  IconSettings,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import { Menu } from "@base-ui/react/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownTrigger, DropdownContent } from "@/components/ui/dropdown";
import { boardStore, useBoard } from "@/lib/board/useBoard";
import type { Project, Thread } from "@/lib/board/types";
import { cn } from "@/lib/utils";
import type { Selection } from "@/App";

const EXPANDED_KEY = "elan.sidebar.expanded";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage disabled */
  }
}

export interface BoardSidebarProps {
  selection: Selection;
  /** The thread open in the active tab, if any — highlights its sidebar row. */
  activeThreadId?: string;
  onSelect: (s: Selection) => void;
  onOpenThread: (threadId: string) => void;
  onNewThread: (projectId?: string) => void;
  onResize: (w: number) => void;
  onOpenSettings: () => void;
}

export function BoardSidebar({
  selection,
  activeThreadId,
  onSelect,
  onOpenThread,
  onNewThread,
  onResize,
  onOpenSettings,
}: BoardSidebarProps) {
  const board = useBoard();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  const toggle = useCallback((projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveExpanded(next);
      return next;
    });
  }, []);

  const runningThreadIds = useMemo(
    () =>
      new Set(
        board.sessions.filter((s) => s.state === "running").map((s) => s.threadId),
      ),
    [board.sessions],
  );

  const threadsByProject = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const t of board.threads) {
      const arr = map.get(t.projectId) ?? [];
      arr.push(t);
      map.set(t.projectId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [board.threads]);

  return (
    <Sidebar
      collapsible="offcanvas"
      className="border-r-0"
      data-tauri-drag-region="deep"
    >
      {/* No wordmark — the user knows what app they're in. The header keeps
          the traffic-light inset only. */}
      <SidebarHeader className="px-2 pt-9 pb-1" />

      <SidebarContent className="gap-0.5 px-1.5 py-1">
        <NavRow
          icon={IconInbox}
          label="Inbox"
          active={selection.view === "inbox"}
          onClick={() => onSelect({ view: "inbox" })}
        />
        <NavRow
          icon={IconUser}
          label="My threads"
          active={selection.view === "mine"}
          onClick={() => onSelect({ view: "mine" })}
        />

        <div className="mt-3 mb-0.5 px-2.5 text-[12px] font-medium text-sidebar-foreground/50">
          Projects
        </div>

        {board.projects.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] leading-relaxed text-sidebar-foreground/45">
            No projects yet.
          </div>
        ) : (
          board.projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              threads={threadsByProject.get(project.id) ?? []}
              expanded={expanded.has(project.id)}
              onToggle={() => toggle(project.id)}
              selection={selection}
              activeThreadId={activeThreadId}
              onSelect={onSelect}
              onOpenThread={onOpenThread}
              onNewThread={onNewThread}
              runningThreadIds={runningThreadIds}
            />
          ))
        )}
      </SidebarContent>

      <SidebarFooter className="gap-0.5 px-1 pb-2">
        <button
          onClick={onOpenSettings}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
            "text-sidebar-foreground/70",
            "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
            "hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <IconSettings size={16} className="shrink-0" />
          Settings
        </button>
      </SidebarFooter>

      <SidebarResizer onResize={onResize} />
    </Sidebar>
  );
}

// ── Nav rows (Inbox / My threads) ───────────────────────────────────────────

function NavRow({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof IconInbox;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-[30px] items-center gap-2 rounded-[5px] px-2.5 text-[13px]",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active
          ? "bg-sidebar-accent text-sidebar-foreground font-medium"
          : "text-sidebar-foreground/75 hover:bg-hover hover:text-sidebar-foreground",
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── Projects ─────────────────────────────────────────────────────────────

function ProjectGroup({
  project,
  threads,
  expanded,
  onToggle,
  selection,
  activeThreadId,
  onSelect,
  onOpenThread,
  onNewThread,
  runningThreadIds,
}: {
  project: Project;
  threads: Thread[];
  expanded: boolean;
  onToggle: () => void;
  selection: Selection;
  activeThreadId?: string;
  onSelect: (s: Selection) => void;
  onOpenThread: (threadId: string) => void;
  onNewThread: (projectId?: string) => void;
  runningThreadIds: Set<string>;
}) {
  const active = selection.view === "project" && selection.projectId === project.id;
  const [hovering, setHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const showControls = hovering || menuOpen;

  const confirmDelete = () => {
    setConfirmOpen(false);
    // The escape hatch back to Inbox when the sidebar's own selection was
    // pointed at the project being removed; a lingering thread tab for it
    // closes separately (App reconciles tabs against board.threads).
    if (selection.view === "project" && selection.projectId === project.id) {
      onSelect({ view: "inbox" });
    }
    boardStore().deleteProject(project.id);
  };

  return (
    <div className="py-0.5">
      <div
        className="group/proj relative flex items-center rounded-[5px] pr-1"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <button
          onClick={onToggle}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/40 transition-colors hover:text-sidebar-foreground"
        >
          <IconChevronRight
            size={13}
            className={cn(
              "shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              expanded && "rotate-90",
            )}
          />
        </button>
        <button
          onClick={() => onSelect({ view: "project", projectId: project.id })}
          className={cn(
            "flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[5px] pr-1 text-[13px]",
            "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
            active
              ? "bg-sidebar-accent text-sidebar-foreground font-medium"
              : "text-sidebar-foreground/85 hover:bg-hover",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
          <span
            className={cn(
              "shrink-0 pr-1 text-[11px] tabular-nums text-sidebar-foreground/35 transition-opacity duration-100",
              showControls && "opacity-0",
            )}
          >
            {threads.length}
          </span>
        </button>
        <div
          className={cn(
            "absolute right-1 flex items-center gap-0.5 transition-opacity duration-100",
            showControls ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownTrigger
              render={
                <button
                  type="button"
                  aria-label={`${project.name} actions`}
                  title={`${project.name} actions`}
                  aria-hidden={!showControls}
                  tabIndex={showControls ? 0 : -1}
                  className="flex size-5 items-center justify-center rounded text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                />
              }
            >
              <IconDots size={13} />
            </DropdownTrigger>
            <DropdownContent align="start" className="w-44">
              <Menu.Item
                onClick={() => setConfirmOpen(true)}
                className={cn(
                  "flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-destructive",
                  "outline-none select-none data-[highlighted]:bg-destructive/10",
                )}
              >
                <IconTrash size={14} />
                Delete project…
              </Menu.Item>
            </DropdownContent>
          </DropdownMenu>
          <button
            aria-label={`New thread in ${project.name}`}
            title={`New thread in ${project.name}`}
            aria-hidden={!showControls}
            tabIndex={showControls ? 0 : -1}
            onClick={() => onNewThread(project.id)}
            className="flex size-5 items-center justify-center rounded text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {project.name}?</DialogTitle>
            <DialogDescription>
              Removes the project and all its threads. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              className="rounded-md bg-destructive px-3 py-1.5 text-[13px] font-medium text-destructive-foreground transition-colors hover:opacity-90"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {expanded && (
        <div className="mt-0.5 flex flex-col gap-0 pl-[22px]">
          {threads.length === 0 ? (
            <div className="px-2.5 py-1 text-[12px] text-sidebar-foreground/40">
              No threads yet
            </div>
          ) : (
            threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                active={t.id === activeThreadId}
                running={runningThreadIds.has(t.id)}
                onClick={() => onOpenThread(t.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  running,
  onClick,
}: {
  thread: Thread;
  active: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-[30px] min-w-0 items-center gap-2 rounded-[5px] px-2 text-[13px]",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/70 hover:bg-hover hover:text-sidebar-foreground",
      )}
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left",
          running && "shimmer-run",
        )}
      >
        {thread.title}
      </span>
    </button>
  );
}

// ── Drag-resize rail — cribbed from SessionSidebar's SidebarResizer. ───────

function SidebarResizer({ onResize }: { onResize: (width: number) => void }) {
  const { state } = useSidebar();
  const [dragging, setDragging] = useState(false);
  if (state === "collapsed") return null;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) =>
      onResize(Math.min(460, Math.max(220, ev.clientX)));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      data-tauri-drag-region="false"
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize",
        "after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors",
        "hover:after:bg-sidebar-border",
        dragging ? "after:bg-primary/60" : "after:bg-transparent",
      )}
    />
  );
}
