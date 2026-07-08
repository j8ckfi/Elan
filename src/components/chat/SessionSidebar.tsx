// The session sidebar, organised the way Codex / Claude Code do it: every chat
// belongs to a PROJECT (the directory it runs in). Projects are collapsible and
// drag-to-reorder, with both the order and the collapsed set persisted locally.
// Built on the base-nova (Base UI) Sidebar shell; session data is the disk-read
// listing from usePiSession, and rename targets the active session.

import { useCallback, useMemo, useState } from "react";
import {
  IconPlus,
  IconEdit,
  IconPencil,
  IconTrash,
  IconCheck,
  IconX,
  IconChevronRight,
} from "@tabler/icons-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { SessionSummary } from "@/lib/pi/sessions";
import { cn } from "@/lib/utils";

interface Project {
  cwd: string;
  name: string;
  sessions: SessionSummary[];
  latest: number;
}

function basename(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || cwd || "untitled";
}

function relativeTime(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return "today";
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

// Tiny localStorage-backed state — order and collapsed-set survive reloads.
function usePersisted<T>(key: string, initial: T) {
  const [val, setVal] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (updater: (prev: T) => T) =>
      setVal((prev) => {
        const next = updater(prev);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore quota / disabled storage */
        }
        return next;
      }),
    [key],
  );
  return [val, set] as const;
}

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  activePath?: string;
  /** Disk paths of sessions with an in-flight run — shown with a live dot. */
  runningPaths?: Set<string>;
  onNew: () => void;
  /** New session preset to a specific workspace (the hovered project's cwd). */
  onNewInProject: (cwd: string) => void;
  onSwitch: (path: string) => void;
  /** Rename a session by disk path (works for any session, open or not). */
  onRename: (path: string, name: string) => void;
  /** Delete a session by disk path. */
  onDelete: (path: string) => void;
  /** Drag-to-resize: report the new sidebar width (px) during a drag. */
  onResize: (width: number) => void;
}

export function SessionSidebar({
  sessions,
  activePath,
  runningPaths,
  onNew,
  onNewInProject,
  onSwitch,
  onRename,
  onDelete,
  onResize,
}: SessionSidebarProps) {
  const projects = useMemo<Project[]>(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const arr = map.get(s.cwd) ?? [];
      arr.push(s);
      map.set(s.cwd, arr);
    }
    return [...map.entries()].map(([cwd, ss]) => ({
      cwd,
      name: basename(cwd),
      sessions: ss.sort((a, b) => b.updatedAt - a.updatedAt),
      latest: Math.max(...ss.map((s) => s.updatedAt)),
    }));
  }, [sessions]);

  const [order, setOrder] = usePersisted<string[]>("mari.projectOrder", []);
  const [collapsed, setCollapsed] = usePersisted<string[]>(
    "mari.collapsedProjects",
    [],
  );

  // Stored order first (dropping gone projects), then any new project by recency.
  const orderedProjects = useMemo(() => {
    const byCwd = new Map(projects.map((p) => [p.cwd, p]));
    const seen = new Set<string>();
    const out: Project[] = [];
    for (const cwd of order) {
      const p = byCwd.get(cwd);
      if (p) {
        out.push(p);
        seen.add(cwd);
      }
    }
    const rest = projects
      .filter((p) => !seen.has(p.cwd))
      .sort((a, b) => b.latest - a.latest);
    return [...out, ...rest];
  }, [projects, order]);

  // Collapse is the user's call — a project stays collapsed even while it holds
  // the active session (its row simply isn't shown until they expand it again).
  const isCollapsed = useCallback(
    (cwd: string) => collapsed.includes(cwd),
    [collapsed],
  );
  const toggle = useCallback(
    (cwd: string) =>
      setCollapsed((prev) =>
        prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd],
      ),
    [setCollapsed],
  );

  // ── drag-to-reorder ───────────────────────────────────────────────────
  const [dragCwd, setDragCwd] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ cwd: string; pos: "before" | "after" } | null>(
    null,
  );

  const onDragOver = useCallback(
    (e: React.DragEvent, cwd: string) => {
      if (!dragCwd || dragCwd === cwd) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY < r.top + r.height / 2 ? "before" : "after";
      setDrop((d) => (d?.cwd === cwd && d.pos === pos ? d : { cwd, pos }));
    },
    [dragCwd],
  );

  const commitDrop = useCallback(() => {
    if (!dragCwd || !drop) {
      setDragCwd(null);
      setDrop(null);
      return;
    }
    const cur = orderedProjects.map((p) => p.cwd);
    const from = cur.indexOf(dragCwd);
    if (from >= 0) cur.splice(from, 1);
    let to = cur.indexOf(drop.cwd);
    if (to < 0) to = cur.length;
    else if (drop.pos === "after") to += 1;
    cur.splice(to, 0, dragCwd);
    setOrder(() => cur);
    setDragCwd(null);
    setDrop(null);
  }, [dragCwd, drop, orderedProjects, setOrder]);

  return (
    <Sidebar collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="px-1 pt-9">
        <button
          onClick={onNew}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium",
            "text-sidebar-foreground/80",
            "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
            "hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <IconEdit size={16} className="shrink-0" />
          New session
        </button>
      </SidebarHeader>

      <SidebarContent className="py-1 pr-2.5 pl-1">
        {sessions.length === 0 ? (
          <div className="px-4 py-6 text-[12px] leading-relaxed text-sidebar-foreground/45">
            No saved sessions yet. Start a conversation and it'll appear here.
          </div>
        ) : (
          orderedProjects.map((project) => (
            <ProjectGroup
              key={project.cwd}
              project={project}
              collapsed={isCollapsed(project.cwd)}
              onToggle={() => toggle(project.cwd)}
              activePath={activePath}
              runningPaths={runningPaths}
              onSwitch={onSwitch}
              onRename={onRename}
              onDelete={onDelete}
              onNewInProject={onNewInProject}
              dragging={dragCwd === project.cwd}
              dropPos={drop?.cwd === project.cwd ? drop.pos : null}
              onDragStart={() => setDragCwd(project.cwd)}
              onDragOver={(e) => onDragOver(e, project.cwd)}
              onDrop={commitDrop}
              onDragEnd={() => {
                setDragCwd(null);
                setDrop(null);
              }}
            />
          ))
        )}
      </SidebarContent>
      <SidebarResizer onResize={onResize} />
    </Sidebar>
  );
}

// Drag handle on the sidebar's right edge. The sidebar is anchored at window
// x=0, so the pointer's clientX is the new width; clamp it and report up.
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

function ProjectGroup({
  project,
  collapsed,
  onToggle,
  activePath,
  runningPaths,
  onSwitch,
  onRename,
  onDelete,
  onNewInProject,
  dragging,
  dropPos,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  activePath?: string;
  runningPaths?: Set<string>;
  onSwitch: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  onNewInProject: (cwd: string) => void;
  dragging: boolean;
  dropPos: "before" | "after" | null;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  // Show only the recent handful per project; a long history stays scannable.
  const CAP = 6;
  const [showAll, setShowAll] = useState(false);
  const activeIdx = project.sessions.findIndex((s) => s.path === activePath);
  const forceAll = activeIdx >= CAP; // keep the active row reachable
  const visible =
    showAll || forceAll ? project.sessions : project.sessions.slice(0, CAP);
  const hiddenCount = project.sessions.length - visible.length;
  // Any child running → the collapsed header carries a live dot so you can see
  // activity without expanding.
  const hasRunning =
    !!runningPaths && project.sessions.some((s) => runningPaths.has(s.path));

  return (
    <div
      className="relative py-0.5"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Drop indicator */}
      {dropPos && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary",
            dropPos === "before" ? "top-0" : "bottom-0",
          )}
        />
      )}

      {/* Project header — click to collapse, drag to reorder. The right slot
          shows the session count, swapped for a "new session here" plus on
          hover. Outer is a div so the plus can be its own button (no nesting). */}
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className={cn(
          "group/head relative flex w-full items-center rounded-md pr-1",
          "cursor-grab select-none active:cursor-grabbing",
          dragging && "opacity-40",
        )}
      >
        <button
          onClick={onToggle}
          title={project.cwd}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5",
            "text-[12px] font-medium text-sidebar-foreground/60",
            "transition-colors duration-100 hover:text-sidebar-foreground",
          )}
        >
          <IconChevronRight
            size={13}
            className={cn(
              "shrink-0 text-sidebar-foreground/40 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              !collapsed && "rotate-90",
            )}
          />
          {/* Collapsed folder with a live child → the name shimmers so activity
              is visible without expanding. */}
          <span
            className={cn("truncate", collapsed && hasRunning && "shimmer-run")}
          >
            {project.name}
          </span>
        </button>
        <span className="pointer-events-none pl-1 pr-1 text-[11px] tabular-nums text-sidebar-foreground/30 transition-opacity duration-100 group-hover/head:opacity-0">
          {project.sessions.length}
        </span>
        <button
          aria-label={`New session in ${project.name}`}
          title={`New session in ${project.name}`}
          onClick={() => onNewInProject(project.cwd)}
          className={cn(
            "absolute right-1 flex size-5 items-center justify-center rounded",
            "text-sidebar-foreground/55 opacity-0 transition-opacity duration-100",
            "hover:bg-sidebar-accent hover:text-sidebar-foreground",
            "group-hover/head:opacity-100 focus-visible:opacity-100",
          )}
        >
          <IconPlus size={14} />
        </button>
      </div>

      {/* Sessions — hidden when collapsed, capped to the recent few. */}
      {!collapsed && (
        <SidebarMenu className="mt-0.5 gap-0 pl-3">
          {visible.map((s) => (
            <SessionRow
              key={s.path}
              session={s}
              active={s.path === activePath}
              running={!!runningPaths?.has(s.path)}
              onSwitch={onSwitch}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
          {project.sessions.length > CAP && !forceAll && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mx-2 mt-0.5 rounded-md px-2 py-1 text-left text-[12px] text-sidebar-foreground/45 transition-colors hover:text-sidebar-foreground/70"
            >
              {showAll ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </SidebarMenu>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  running,
  onSwitch,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  onSwitch: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name ?? session.title);

  const startRename = () => {
    setDraft(session.name ?? session.title);
    setEditing(true);
  };

  const commit = () => {
    const v = draft.trim();
    if (v && v !== (session.name ?? session.title)) onRename(session.path, v);
    setEditing(false);
  };

  if (editing) {
    return (
      <SidebarMenuItem>
        <div className="flex items-center gap-1 rounded-md bg-sidebar-accent/70 px-1.5 py-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none"
          />
          <button
            aria-label="Save name"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
            className="rounded p-0.5 text-sidebar-foreground/60 hover:text-sidebar-foreground"
          >
            <IconCheck size={14} />
          </button>
          <button
            aria-label="Cancel rename"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="rounded p-0.5 text-sidebar-foreground/60 hover:text-sidebar-foreground"
          >
            <IconX size={14} />
          </button>
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <ContextMenu.Root>
      {/* Trigger renders the <li> itself so ul>li stays valid and the
          group/menu-item selectors the button + action rely on still work. */}
      <ContextMenu.Trigger
        render={
          <li
            className="group/menu-item relative"
            data-slot="sidebar-menu-item"
            data-sidebar="menu-item"
          />
        }
      >
        <SidebarMenuButton
          isActive={active}
          onClick={() => onSwitch(session.path)}
          title={session.title}
          // The active row renders the (hover-only) rename pencil, which makes
          // the menu-button reserve pr-8 and truncate the title early even while
          // the pencil is hidden. Cancel that reserve — the pencil just overlays
          // the title's end on hover (where it's already truncated).
          className={cn("h-7", active && "pr-2!")}
        >
          {/* While its agent runs, the title itself shimmers — no extra glyph. */}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              running && "shimmer-run",
            )}
          >
            {session.title}
          </span>
          {/* Recency label — hidden on the active row so the rename pencil
              (which occupies the same corner on hover) has room. */}
          {!active && (
            <span className="shrink-0 text-[11px] tabular-nums text-sidebar-foreground/30">
              {relativeTime(session.updatedAt)}
            </span>
          )}
        </SidebarMenuButton>
        {/* Quick rename affordance on the active row (right-click has it too). */}
        {active && (
          <SidebarMenuAction
            showOnHover
            aria-label="Rename session"
            onClick={startRename}
          >
            <IconPencil size={14} />
          </SidebarMenuAction>
        )}
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup
            className={cn(
              "z-50 min-w-[9rem] origin-[var(--transform-origin)] overflow-hidden p-1",
              "rounded-xl border border-border bg-popover text-[13px] text-popover-foreground shadow-lg",
              "dark:border-transparent dark:shadow-surface-2",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-100",
            )}
          >
            <ContextMenu.Item
              onClick={startRename}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-hover"
            >
              <IconPencil size={14} className="text-muted-foreground" />
              Rename
            </ContextMenu.Item>
            {/* Light divider between the safe and destructive action. */}
            <div role="separator" className="mx-1 my-1 h-px bg-border" />
            <ContextMenu.Item
              onClick={() => onDelete(session.path)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-destructive outline-none select-none data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
            >
              <IconTrash size={14} />
              Delete
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
