import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconEdit } from "@tabler/icons-react";
import { IconProvider } from "@/lib/icon-context";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { SettingsDialog } from "@/components/chat/SettingsDialog";
import { useSettings } from "@/lib/settings";
import { BoardSidebar } from "@/components/board/BoardSidebar";
import { ConnectionBanner } from "@/components/board/ConnectionBanner";
import { RosterEditor } from "@/components/board/RosterEditor";
import { ThreadList } from "@/components/board/ThreadList";
import { Welcome } from "@/components/board/Welcome";
import { TabStrip, type TabDescriptor } from "@/components/board/TabStrip";
import { ThreadView } from "@/components/board/thread/ThreadView";
import { DraftThread } from "@/components/board/thread/DraftThread";
import { useBoard, boardStore } from "@/lib/board/useBoard";
import { cn } from "@/lib/utils";

// ── Navigation ───────────────────────────────────────────────────────────────
// The sidebar drives the persistent board tab (list views); threads open as
// closable tabs beside it. No router — a desktop app with two view shapes.
export type Selection =
  | { view: "inbox" }
  | { view: "mine" }
  | { view: "project"; projectId: string };

// One open thread tab. Drafts start without a threadId; the first title
// keystroke creates the thread and attaches it (see DraftThread).
interface OpenTab {
  key: string;
  threadId?: string;
  draft: boolean;
  draftProjectId?: string;
}

const nextKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const TABS_KEY = "elan.tabs.v1";

// Reopen last session's thread tabs; drop tabs whose thread is gone and
// never persist uncreated drafts (they were, by definition, empty).
function hydrateTabs(): { tabs: OpenTab[]; activeKey: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as {
      threadIds?: string[];
      activeThreadId?: string | null;
    } | null;
    if (!raw?.threadIds) return { tabs: [], activeKey: "board" };
    const live = new Set(boardStore().getState().threads.map((t) => t.id));
    const tabs = raw.threadIds
      .filter((id) => live.has(id))
      .map((id) => ({ key: nextKey(), threadId: id, draft: false }));
    const active = tabs.find((t) => t.threadId === raw.activeThreadId);
    return { tabs, activeKey: active?.key ?? "board" };
  } catch {
    return { tabs: [], activeKey: "board" };
  }
}

function App() {
  const settings = useSettings();
  const board = useBoard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>({ view: "inbox" });
  const [{ tabs, activeKey }, setTabState] = useState(hydrateTabs);

  // Sidebar glass (inherited from Mari): pure CSS attribute toggle.
  useEffect(() => {
    document.documentElement.dataset.glass = settings.glassSidebar
      ? "on"
      : "off";
  }, [settings.glassSidebar]);

  useEffect(() => {
    try {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({
          threadIds: tabs.filter((t) => t.threadId).map((t) => t.threadId),
          activeThreadId:
            tabs.find((t) => t.key === activeKey)?.threadId ?? null,
        }),
      );
    } catch {
      /* storage disabled */
    }
  }, [tabs, activeKey]);

  // Deleting a project cascades away its threads (deleteProject); prune any
  // open tab pointing at a thread that's gone rather than leaving it to show
  // ThreadView's "no longer exists" empty state indefinitely. Draft tabs
  // (threadId unset until the first title keystroke) are untouched. Bails
  // out to the same tab-state reference when nothing's stale, so this is a
  // no-op render on every ordinary board mutation.
  useEffect(() => {
    setTabState((prev) => {
      const live = new Set(board.threads.map((t) => t.id));
      const staleKeys = new Set(
        prev.tabs.filter((t) => t.threadId && !live.has(t.threadId)).map((t) => t.key),
      );
      if (staleKeys.size === 0) return prev;
      const tabs = prev.tabs.filter((t) => !staleKeys.has(t.key));
      const activeKey = staleKeys.has(prev.activeKey) ? "board" : prev.activeKey;
      return { tabs, activeKey };
    });
  }, [board.threads]);

  const openThread = useCallback((threadId: string) => {
    setTabState((prev) => {
      const existing = prev.tabs.find((t) => t.threadId === threadId);
      if (existing) return { ...prev, activeKey: existing.key };
      const tab: OpenTab = { key: nextKey(), threadId, draft: false };
      return { tabs: [...prev.tabs, tab], activeKey: tab.key };
    });
  }, []);

  const requestNewThread = useCallback((projectId?: string) => {
    setTabState((prev) => {
      const tab: OpenTab = { key: nextKey(), draft: true, draftProjectId: projectId };
      return { tabs: [...prev.tabs, tab], activeKey: tab.key };
    });
  }, []);

  // A draft's first keystroke created the thread — attach it to the tab.
  const draftCreated = useCallback((key: string, threadId: string) => {
    setTabState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.key === key ? { ...t, threadId } : t)),
    }));
  }, []);

  const closeTab = useCallback((key: string) => {
    setTabState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.key === key);
      if (idx < 0) return prev;
      const tab = prev.tabs[idx];
      // Draft discard: a created-but-never-titled thread is junk — remove it.
      if (tab.draft && tab.threadId) {
        const t = boardStore()
          .getState()
          .threads.find((x) => x.id === tab.threadId);
        if (!t || !t.title.trim()) boardStore().deleteThread(tab.threadId);
      }
      const tabs = prev.tabs.filter((t) => t.key !== key);
      const activeKey =
        prev.activeKey !== key
          ? prev.activeKey
          : (tabs[idx] ?? tabs[idx - 1])?.key ?? "board";
      return { tabs, activeKey };
    });
  }, []);

  const selectTab = useCallback((key: string) => {
    setTabState((prev) => ({ ...prev, activeKey: key }));
  }, []);

  // Sidebar selection always fronts the board tab.
  const selectView = useCallback((sel: Selection) => {
    setSelection(sel);
    setTabState((prev) => ({ ...prev, activeKey: "board" }));
  }, []);

  // Esc closes the active thread tab (Linear's back, browser's close) —
  // unless focus is in a field, where Esc belongs to it (mention popover,
  // draft editors) and closing would risk losing a half-written message.
  useEffect(() => {
    if (activeKey === "board") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || settingsOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      closeTab(activeKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeKey, settingsOpen, closeTab]);

  const boardLabel =
    selection.view === "inbox"
      ? "Inbox"
      : selection.view === "mine"
        ? "My threads"
        : (board.projects.find((p) => p.id === selection.projectId)?.name ??
          "Project");

  const descriptors: TabDescriptor[] = tabs.map((t) => {
    const thread = board.threads.find((x) => x.id === t.threadId);
    return {
      key: t.key,
      title: thread?.title ?? "",
      running: board.sessions.some(
        (s) => s.threadId === t.threadId && s.state === "running",
      ),
    };
  });

  const activeTab = tabs.find((t) => t.key === activeKey);

  // Onboarding step 2 ("Assemble your team", docs/FRONTEND.md): the first
  // project's empty board shows the roster editor in onboarding dress, once.
  // "Start working" dismisses explicitly; navigating anywhere else while it's
  // up (a draft tab, a filed thread) is the implicit skip — both persist.
  const [rosterOnboarded, setRosterOnboarded] = useState(() => {
    try {
      return localStorage.getItem("elan.onboarding.roster.v1") != null;
    } catch {
      return true;
    }
  });
  const finishRosterOnboarding = useCallback(() => {
    try {
      localStorage.setItem("elan.onboarding.roster.v1", "done");
    } catch {
      /* storage disabled */
    }
    setRosterOnboarded(true);
  }, []);
  const rosterOnboarding =
    !rosterOnboarded &&
    !activeTab &&
    board.projects.length === 1 &&
    board.threads.length === 0;
  const rosterOnboardingSeen = useRef(false);
  useEffect(() => {
    if (rosterOnboarding) rosterOnboardingSeen.current = true;
    else if (rosterOnboardingSeen.current && !rosterOnboarded)
      finishRosterOnboarding();
  }, [rosterOnboarding, rosterOnboarded, finishRosterOnboarding]);

  // Drag-resizable sidebar width, persisted across launches.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem("elan.sidebarWidth"));
      return Number.isFinite(n) && n > 0 ? Math.min(460, Math.max(220, n)) : 244;
    } catch {
      return 244;
    }
  });
  const handleResize = (w: number) => {
    setSidebarWidth(w);
    try {
      localStorage.setItem("elan.sidebarWidth", String(w));
    } catch {
      /* storage disabled */
    }
  };

  return (
    <IconProvider defaultLibrary="tabler">
      <SidebarProvider
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <TitleBar onNewThread={() => requestNewThread()} />
        <BoardSidebar
          selection={selection}
          activeThreadId={activeTab?.threadId}
          onSelect={selectView}
          onOpenThread={openThread}
          onNewThread={requestNewThread}
          onResize={handleResize}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SidebarInset className="flex h-screen min-w-0 flex-col bg-background text-foreground">
          <TabRow
            boardLabel={boardLabel}
            tabs={descriptors}
            activeKey={activeKey}
            onSelect={selectTab}
            onClose={closeTab}
          />
          <ConnectionBanner />
          <BoardBoundary resetKey={activeKey + selectionKey(selection)}>
            {!activeTab ? (
              board.projects.length === 0 ? (
                <Welcome
                  onProjectCreated={(id) =>
                    selectView({ view: "project", projectId: id })
                  }
                />
              ) : rosterOnboarding ? (
                <RosterEditor
                  variant="onboarding"
                  onDone={finishRosterOnboarding}
                />
              ) : (
                <ThreadList
                  mode={selection.view}
                  projectId={
                    selection.view === "project" ? selection.projectId : undefined
                  }
                  onOpenThread={openThread}
                  onNewThread={requestNewThread}
                />
              )
            ) : activeTab.draft ? (
              <DraftThread
                key={activeTab.key}
                projectId={activeTab.draftProjectId}
                threadId={activeTab.threadId}
                onCreated={(threadId) => draftCreated(activeTab.key, threadId)}
              />
            ) : (
              <ThreadView threadId={activeTab.threadId!} />
            )}
          </BoardBoundary>
        </SidebarInset>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </SidebarProvider>
    </IconProvider>
  );
}

const selectionKey = (s: Selection) =>
  s.view === "project" ? `p:${s.projectId}` : s.view;

// The tab row sits where a titlebar would: inline with the traffic lights,
// draggable in its dead space, padded past the fixed toggle cluster when the
// sidebar is collapsed.
function TabRow({
  boardLabel,
  tabs,
  activeKey,
  onSelect,
  onClose,
}: {
  boardLabel: string;
  tabs: TabDescriptor[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pl = collapsed ? trafficInset() + 66 : 12;

  return (
    <header
      data-tauri-drag-region="deep"
      className="relative z-30 flex h-9 shrink-0 items-center pr-3 select-none"
      style={{ paddingLeft: pl }}
    >
      <TabStrip
        boardLabel={boardLabel}
        tabs={tabs}
        activeKey={activeKey}
        onSelect={onSelect}
        onClose={onClose}
      />
    </header>
  );
}

// One bad thread render must not white-screen the board; remounts on nav.
class BoardBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: false });
  }
  componentDidCatch(error: unknown) {
    console.error("[Board] crashed:", error);
  }
  render() {
    if (this.state.error)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-[13px] text-muted-foreground">
          <p>This view hit an error and couldn't be shown.</p>
          <button
            onClick={() => this.setState({ error: false })}
            className="rounded-md border border-border px-3 py-1.5 text-foreground transition-colors hover:bg-hover"
          >
            Try again
          </button>
        </div>
      );
    return this.props.children;
  }
}

// The window's traffic-light inset in px (desktop only).
function trafficInset(): number {
  const isDesktop =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return isDesktop ? 82 : 10;
}

// Fixed toggle cluster pinned beside the traffic lights (inherited from Mari):
// sidebar toggle + new-thread, the latter fading in when the sidebar is closed.
function TitleBar({ onNewThread }: { onNewThread: () => void }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <div
      data-tauri-drag-region="deep"
      className="fixed left-0 top-0 z-50 flex h-8 items-center gap-0.5 pr-2 select-none"
      style={{ paddingLeft: trafficInset() }}
    >
      <SidebarTrigger className="size-7 shrink-0 rounded-md text-foreground/65 hover:bg-hover hover:text-foreground [&_svg]:size-[16px]" />
      <button
        onClick={onNewThread}
        aria-label="New thread"
        aria-hidden={!collapsed}
        tabIndex={collapsed ? 0 : -1}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/65",
          "transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:bg-hover hover:text-foreground active:scale-95",
          collapsed
            ? "translate-x-0 opacity-100"
            : "pointer-events-none -translate-x-1 opacity-0",
        )}
      >
        <IconEdit size={16} />
      </button>
    </div>
  );
}

export default App;
