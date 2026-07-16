// The board tab's content — home (docs/FRONTEND.md "Home"). The sidebar is
// gone (2026-07-16): home carries everything the rail did. Four zones, top to
// bottom: the hero (a perpetual draft title — typing is filing), "For you"
// (agent posts addressed to @user you haven't answered), "Running now" (the
// fleet at a glance), and Projects (collapsible folders of thread rows, plus
// the new-project affordance). The middle two zones are CONDITIONAL — they
// render only when non-empty, so a quiet board is just hero + folders, not a
// screen of empty headers. Pure function of BoardState; renders fine with
// zero sessions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  IconChevronRight,
  IconDots,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { Menu } from "@base-ui/react/menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownTrigger, DropdownContent } from "@/components/ui/dropdown";
import { AgentAvatar, AvatarStack } from "@/components/board/glyphs";
import { addressesUser } from "@/components/board/thread/ExchangeBlock";
import { boardStore, useBoard } from "@/lib/board/useBoard";
import { relativeTime } from "@/lib/relative-time";
import type { Author, Post, Project, RosterEntry, Thread } from "@/lib/board/types";
import { USER } from "@/lib/board/types";
import { cn } from "@/lib/utils";

// Collapsed (not expanded) is what persists: a fresh board and every new
// project default to open — home should show the work, not a row of shut
// doors.
const COLLAPSED_KEY = "elan.home.collapsed.v1";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage disabled */
  }
}

const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

// The conditional zones (For you / Running now) appear and vanish on LIVE
// host pushes — a session starting while you're reading home would otherwise
// yank Projects down a row-height with no warning. Height+fade, exit faster
// than enter; `initial={false}` on the AnimatePresence keeps tab switches
// (the frequent path) from replaying the entrance. The -mx-2/px-2 on the
// section matches the hover pills' overhang so overflow-hidden never clips
// them mid-animation.
const zoneMotion = {
  className: "-mx-2 overflow-hidden px-2",
  initial: { height: 0, opacity: 0 },
  animate: {
    height: "auto" as const,
    opacity: 1,
    transition: { duration: 0.24, ease: EASE_OUT },
  },
  exit: {
    height: 0,
    opacity: 0,
    transition: { duration: 0.16, ease: EASE_OUT },
  },
};

/** Last non-empty path segment: "/Users/me/repo/" → "repo". */
function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/** Desktop only — mirrors Welcome's pickDirectory. */
async function pickDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

export interface HomeProps {
  onOpenThread: (threadId: string) => void;
  onNewThread: (projectId?: string, initialTitle?: string) => void;
  /** Bumped by App on ⌘N — refocuses the hero without remounting. */
  focusHeroNonce?: number;
}

export function Home({ onOpenThread, onNewThread, focusHeroNonce }: HomeProps) {
  const board = useBoard();

  // ── Derivations (all pure) ────────────────────────────────────────────

  const runningSessions = useMemo(
    () => board.sessions.filter((s) => s.state === "running"),
    [board.sessions],
  );
  const runningThreadIds = useMemo(
    () => new Set(runningSessions.map((s) => s.threadId)),
    [runningSessions],
  );

  // For you: per thread, the latest agent post addressing @user with no user
  // post after it — replying (or resolving) is what clears the item, so the
  // zone empties itself as you work it. Newest first, capped.
  const forYou = useMemo(() => {
    const byThread = new Map<string, Post>();
    const lastUserPostAt = new Map<string, number>();
    for (const p of board.posts) {
      if (p.author === USER) {
        const prev = lastUserPostAt.get(p.threadId) ?? 0;
        if (p.createdAt > prev) lastUserPostAt.set(p.threadId, p.createdAt);
      }
    }
    for (const p of board.posts) {
      if (!addressesUser(p)) continue;
      if ((lastUserPostAt.get(p.threadId) ?? 0) > p.createdAt) continue;
      const prev = byThread.get(p.threadId);
      if (!prev || p.createdAt > prev.createdAt) byThread.set(p.threadId, p);
    }
    return [...byThread.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
  }, [board.posts]);

  const threadsById = useMemo(
    () => new Map(board.threads.map((t) => [t.id, t])),
    [board.threads],
  );
  const projectsById = useMemo(
    () => new Map(board.projects.map((p) => [p.id, p])),
    [board.projects],
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

  // The busy project floats up: order by latest thread activity, threadless
  // projects last by recency of creation.
  const orderedProjects = useMemo(() => {
    const latest = (p: Project) => threadsByProject.get(p.id)?.[0]?.updatedAt ?? 0;
    return [...board.projects].sort(
      (a, b) => latest(b) - latest(a) || b.createdAt - a.createdAt,
    );
  }, [board.projects, threadsByProject]);

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

  // Agents live inside each project right now — the folder row's cluster.
  const runningHandlesByProject = useMemo(() => {
    const map = new Map<string, Author[]>();
    for (const s of runningSessions) {
      const projectId = threadsById.get(s.threadId)?.projectId;
      if (!projectId) continue;
      const arr = map.get(projectId) ?? [];
      if (!arr.includes(s.handle)) arr.push(s.handle);
      map.set(projectId, arr);
    }
    return map;
  }, [runningSessions, threadsById]);

  // ── Folders ───────────────────────────────────────────────────────────

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = useCallback((projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  // ── Hero ──────────────────────────────────────────────────────────────

  const heroRef = useRef<HTMLInputElement>(null);
  const [heroTitle, setHeroTitle] = useState("");
  useEffect(() => {
    heroRef.current?.focus();
  }, [focusHeroNonce]);

  const fileHero = () => {
    const title = heroTitle.trim();
    if (!title) return;
    setHeroTitle("");
    onNewThread(undefined, title);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* ONE centered column for every zone — the screen has exactly two left
          edges: the column edge (hero, zone labels) and +26px inside it
          (folder names, thread keys). Rows hover as -mx-2 pills so their
          text stays on the column edge. */}
      <div className="mx-auto w-full max-w-[52rem] px-6 pt-10 pb-12">
        <input
          ref={heroRef}
          value={heroTitle}
          onChange={(e) => setHeroTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              fileHero();
            }
          }}
          placeholder="What needs doing?"
          aria-label="New thread title"
          className={cn(
            "w-full bg-transparent outline-none",
            "text-[21px] font-semibold leading-[1.15] text-foreground",
            "placeholder:text-muted-foreground/40",
          )}
        />
        <p className="mt-1.5 text-[12px] text-muted-foreground/70 select-none">
          Type to draft a thread · Enter opens it as a tab
        </p>

        <AnimatePresence initial={false}>
          {forYou.length > 0 && (
            <motion.section key="for-you" aria-label="For you" {...zoneMotion}>
              <ZoneLabel>For you</ZoneLabel>
              {forYou.map((post) => (
                <ForYouRow
                  key={post.id}
                  post={post}
                  thread={threadsById.get(post.threadId)}
                  project={projectsById.get(threadsById.get(post.threadId)?.projectId ?? "")}
                  roster={board.roster}
                  onOpen={() => onOpenThread(post.threadId)}
                />
              ))}
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {runningSessions.length > 0 && (
            <motion.section key="running" aria-label="Running now" {...zoneMotion}>
              <ZoneLabel>Running now</ZoneLabel>
              <div className="flex flex-wrap gap-2 pt-0.5">
                {runningSessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onOpenThread(s.threadId)}
                    className={cn(
                      "flex h-[34px] items-center gap-2 rounded-lg border border-border px-3",
                      "transition-[background-color,transform] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                      "hover:bg-hover active:scale-[0.96]",
                    )}
                  >
                    <AgentAvatar author={s.handle} roster={board.roster} size={14} />
                    <span className="shimmer-run max-w-64 truncate text-[13px]">
                      {threadsById.get(s.threadId)?.title || "Untitled"}
                    </span>
                    <span className="text-[12px] text-muted-foreground">{s.handle}</span>
                  </button>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <section aria-label="Projects">
          <ZoneLabel>Projects</ZoneLabel>
          {orderedProjects.map((project) => (
            <ProjectFolder
              key={project.id}
              project={project}
              threads={threadsByProject.get(project.id) ?? []}
              open={!collapsed.has(project.id)}
              onToggle={() => toggle(project.id)}
              runningThreadIds={runningThreadIds}
              runningHandles={runningHandlesByProject.get(project.id) ?? []}
              participantsByThread={participantsByThread}
              onOpenThread={onOpenThread}
              onNewThread={onNewThread}
            />
          ))}
          <NewProjectRow />
        </section>
      </div>
    </div>
  );
}

function ZoneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8 mb-1 flex h-5 items-center text-[12px] font-medium text-muted-foreground/80 select-none">
      {children}
    </div>
  );
}

// ── For you ────────────────────────────────────────────────────────────────

function ForYouRow({
  post,
  thread,
  project,
  roster,
  onOpen,
}: {
  post: Post;
  thread: Thread | undefined;
  project: Project | undefined;
  roster: RosterEntry[];
  onOpen: () => void;
}) {
  const snippet = post.body.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div
      onClick={onOpen}
      className="-mx-2 flex h-10 cursor-default items-center gap-2.5 rounded-md px-2 transition-colors duration-100 hover:bg-hover"
    >
      {/* The ledger's one emphasis device, carried over: the foreground rail. */}
      <span aria-hidden className="h-5 w-[2px] shrink-0 rounded-full bg-foreground" />
      <AgentAvatar author={post.author} roster={roster} size={14} />
      <span className="shrink-0 text-[13px] font-medium text-foreground">{post.author}</span>
      <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">
        → you
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        {snippet}
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {project && thread ? `${project.key}-${thread.number} · ` : ""}
        {relativeTime(post.createdAt)}
      </span>
    </div>
  );
}

// ── Projects ───────────────────────────────────────────────────────────────

function ProjectFolder({
  project,
  threads,
  open,
  onToggle,
  runningThreadIds,
  runningHandles,
  participantsByThread,
  onOpenThread,
  onNewThread,
}: {
  project: Project;
  threads: Thread[];
  open: boolean;
  onToggle: () => void;
  runningThreadIds: Set<string>;
  runningHandles: Author[];
  participantsByThread: Map<string, Author[]>;
  onOpenThread: (threadId: string) => void;
  onNewThread: (projectId?: string, initialTitle?: string) => void;
}) {
  const board = useBoard();
  const [hovering, setHovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const showControls = hovering || menuOpen;
  const latest = threads[0]?.updatedAt;
  // A closed folder still tells you work is alive inside it.
  const runningInside = threads.some((t) => runningThreadIds.has(t.id));

  return (
    // mt-2 keeps folder groups from butting against the previous group's
    // last row; the geometry inside puts the name at the +26px edge
    // (chevron 20 + gap 6), where thread keys align below it.
    <div data-slot="home-folder" className="mt-2">
      <div
        className="group/folder relative -mx-2 flex h-[34px] items-center rounded-md px-2 transition-colors duration-100 hover:bg-hover"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <button
          onClick={onToggle}
          aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`}
          className="mr-1.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <IconChevronRight
            size={13}
            className={cn(
              "shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              open && "rotate-90",
            )}
          />
        </button>
        {/* items-baseline WITHOUT h-full: the row centers the button, the
            button baseline-aligns name and count. (h-full + baseline pinned
            the text to the row's top — the folder rows sat visibly high.) */}
        <button
          onClick={onToggle}
          className="flex min-w-0 items-baseline gap-2 text-left"
        >
          <span
            className={cn(
              "truncate text-[13px] font-medium text-foreground",
              !open && runningInside && "shimmer-run",
            )}
          >
            {project.name}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {threads.length}
          </span>
        </button>
        <span className="flex-1" />
        <div
          className={cn(
            "flex items-center gap-2 transition-opacity duration-100",
            showControls && "opacity-0",
          )}
        >
          {runningHandles.length > 0 && (
            <span className="flex items-center gap-1">
              {runningHandles.slice(0, 3).map((h) => (
                <AgentAvatar
                  key={h}
                  author={h}
                  roster={board.roster}
                  size={13}
                  className="text-muted-foreground"
                />
              ))}
            </span>
          )}
          {latest && (
            <span className="text-[12px] tabular-nums text-muted-foreground" style={{ minWidth: 40, textAlign: "right" }}>
              {relativeTime(latest)}
            </span>
          )}
        </div>
        <div
          className={cn(
            "absolute right-2 flex items-center gap-1 transition-opacity duration-100",
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
                  className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-active hover:text-foreground"
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
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-active hover:text-foreground"
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
              onClick={() => {
                setConfirmOpen(false);
                // Open tabs pointing at the cascaded threads are pruned by
                // App's stale-tab effect.
                boardStore().deleteProject(project.id);
              }}
              className="rounded-md bg-destructive px-3 py-1.5 text-[13px] font-medium text-destructive-foreground transition-colors hover:opacity-90"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {open &&
        (threads.length === 0 ? (
          <div className="py-1.5 pl-[26px] text-[12px] text-muted-foreground/60">
            No threads yet
          </div>
        ) : (
          threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              project={project}
              running={runningThreadIds.has(t.id)}
              participants={participantsByThread.get(t.id) ?? []}
              onOpen={() => onOpenThread(t.id)}
            />
          ))
        ))}
    </div>
  );
}

// The row anatomy is the old thread list's, unchanged (docs/FRONTEND.md):
// KEY-N · title · avatar stack · updated-at. Indented under its folder.
function ThreadRow({
  thread,
  project,
  running,
  participants,
  onOpen,
}: {
  thread: Thread;
  project: Project;
  running: boolean;
  participants: Author[];
  onOpen: () => void;
}) {
  const board = useBoard();
  return (
    // pl 34 = the pill's 8px base + the 26px content edge: keys sit flush
    // under their folder's name.
    <div
      onClick={onOpen}
      className="-mx-2 flex h-9 cursor-default items-center gap-2 rounded-md pr-2 pl-[34px] transition-colors duration-100 hover:bg-hover"
    >
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {project.key}-{thread.number}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px] text-foreground", running && "shimmer-run")}>
        {thread.title}
      </span>
      <AvatarStack authors={participants} roster={board.roster} size={18} max={3} className="shrink-0" />
      <span className="shrink-0 text-right text-[12px] tabular-nums text-muted-foreground" style={{ minWidth: 40 }}>
        {relativeTime(thread.updatedAt)}
      </span>
    </div>
  );
}

// ── New project ────────────────────────────────────────────────────────────
// The sidebar's project-add, rehomed as the list's last row. Desktop: the
// native folder picker; browser dev: the row swaps to an inline path input
// (Welcome's fallback grammar).

function NewProjectRow() {
  const [addingPath, setAddingPath] = useState(false);
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingPath) inputRef.current?.focus();
  }, [addingPath]);

  const create = (repoPath: string) => {
    const trimmed = repoPath.trim();
    if (!trimmed) return;
    boardStore().createProject({ name: basename(trimmed), repoPath: trimmed });
    setAddingPath(false);
    setPath("");
  };

  const start = async () => {
    if (isDesktop()) {
      const dir = await pickDirectory();
      if (dir) create(dir);
      return;
    }
    setAddingPath(true);
  };

  if (addingPath) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create(path);
        }}
        className="mt-3 flex items-center gap-2 pl-[26px]"
      >
        <input
          ref={inputRef}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setAddingPath(false);
              setPath("");
            }
          }}
          placeholder="/path/to/repo"
          className={cn(
            "w-64 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none",
            "placeholder:text-muted-foreground/50 focus:border-foreground/25",
          )}
        />
        <button
          type="submit"
          disabled={!path.trim()}
          className={cn(
            "rounded-md border border-border px-3 py-1.5 text-[13px] text-foreground",
            "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
            "hover:bg-hover active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          Add
        </button>
      </form>
    );
  }

  return (
    // Mirrors the folder-row geometry: the + rides the chevron slot, the
    // label lands on the folder-name edge.
    <button
      onClick={start}
      className={cn(
        "-mx-2 mt-3 flex h-9 items-center rounded-md px-2 text-[13px] text-muted-foreground/80",
        "transition-[background-color,color,transform] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "hover:bg-hover hover:text-muted-foreground active:scale-[0.96]",
      )}
    >
      <span className="mr-1.5 flex size-5 shrink-0 items-center justify-center">
        <IconPlus size={14} />
      </span>
      New project…
    </button>
  );
}
