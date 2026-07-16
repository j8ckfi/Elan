import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconSettings } from "@tabler/icons-react";
import { IconProvider } from "@/lib/icon-context";
import { SettingsDialog } from "@/components/chat/SettingsDialog";
import { ConnectionBanner } from "@/components/board/ConnectionBanner";
import { RosterEditor } from "@/components/board/RosterEditor";
import { Home } from "@/components/board/Home";
import { Welcome } from "@/components/board/Welcome";
import { TabStrip, type TabDescriptor } from "@/components/board/TabStrip";
import { ThreadView } from "@/components/board/thread/ThreadView";
import { DraftThread } from "@/components/board/thread/DraftThread";
import { useBoard, useBoardLoaded, boardStore } from "@/lib/board/useBoard";
import { cn } from "@/lib/utils";

// ── Navigation ───────────────────────────────────────────────────────────────
// Fully tab-based (the sidebar was removed 2026-07-16): the persistent board
// tab is Home — hero + for-you + running + project folders — and threads open
// as closable tabs beside it. No router — a desktop app with two view shapes.

// One open thread tab. Drafts start without a threadId; the first title
// keystroke creates the thread and attaches it (see DraftThread). A draft
// filed from the home hero carries its typed title in draftInitialTitle and
// is created on mount instead.
interface OpenTab {
  key: string;
  threadId?: string;
  draft: boolean;
  draftProjectId?: string;
  draftInitialTitle?: string;
}

const nextKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const TABS_KEY = "elan.tabs.v1";

// Reopen last session's thread tabs. Hydrate the persisted list RAW — the
// board is host-backed and its state hasn't loaded yet at mount, so filtering
// against it here would wrongly prune every tab (and the persist effect would
// write that loss back). Tabs whose thread is really gone are pruned by the
// stale-tab effect below, which waits for the first loaded board state.
// Uncreated drafts are never persisted (they were, by definition, empty).
function hydrateTabs(): { tabs: OpenTab[]; activeKey: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as {
      threadIds?: string[];
      activeThreadId?: string | null;
    } | null;
    if (!raw?.threadIds) return { tabs: [], activeKey: "board" };
    const tabs = raw.threadIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ key: nextKey(), threadId: id, draft: false }));
    const active = tabs.find((t) => t.threadId === raw.activeThreadId);
    return { tabs, activeKey: active?.key ?? "board" };
  } catch {
    return { tabs: [], activeKey: "board" };
  }
}

function App() {
  const board = useBoard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [{ tabs, activeKey }, setTabState] = useState(hydrateTabs);

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
  // no-op render on every ordinary board mutation. GATED on the first loaded
  // board state: pre-load, threads === [] means "unknown", not "deleted" —
  // pruning restored tabs against it would lose them (and the persist effect
  // would write the loss back to elan.tabs.v1).
  const loaded = useBoardLoaded();
  useEffect(() => {
    if (!loaded) return;
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
  }, [board.threads, loaded]);

  const openThread = useCallback((threadId: string) => {
    setTabState((prev) => {
      const existing = prev.tabs.find((t) => t.threadId === threadId);
      if (existing) return { ...prev, activeKey: existing.key };
      const tab: OpenTab = { key: nextKey(), threadId, draft: false };
      return { tabs: [...prev.tabs, tab], activeKey: tab.key };
    });
  }, []);

  const requestNewThread = useCallback(
    (projectId?: string, initialTitle?: string) => {
      setTabState((prev) => {
        const tab: OpenTab = {
          key: nextKey(),
          draft: true,
          draftProjectId: projectId,
          draftInitialTitle: initialTitle,
        };
        return { tabs: [...prev.tabs, tab], activeKey: tab.key };
      });
    },
    [],
  );

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

  // ⌘N fronts Home and focuses the hero — filing is always one chord away.
  // (The hero also autofocuses whenever Home mounts; the nonce covers the
  // "already on Home, focus wandered" case.)
  const [heroFocusNonce, setHeroFocusNonce] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === "n" &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setTabState((prev) => ({ ...prev, activeKey: "board" }));
        setHeroFocusNonce((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  return (
    <IconProvider defaultLibrary="tabler">
      <div className="flex h-screen w-full min-w-0 flex-col bg-background text-foreground">
        <TabRow
          tabs={descriptors}
          activeKey={activeKey}
          onSelect={selectTab}
          onClose={closeTab}
          onNewThread={() => requestNewThread()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <ConnectionBanner />
        <BoardBoundary resetKey={activeKey}>
          {!activeTab ? (
            board.projects.length === 0 ? (
              // Home shows the new project itself (folders default open) —
              // nothing to select anymore.
              <Welcome onProjectCreated={() => {}} />
            ) : rosterOnboarding ? (
              <RosterEditor
                variant="onboarding"
                onDone={finishRosterOnboarding}
              />
            ) : (
              <Home
                onOpenThread={openThread}
                onNewThread={requestNewThread}
                focusHeroNonce={heroFocusNonce}
              />
            )
          ) : activeTab.draft ? (
            <DraftThread
              key={activeTab.key}
              projectId={activeTab.draftProjectId}
              threadId={activeTab.threadId}
              initialTitle={activeTab.draftInitialTitle}
              onCreated={(threadId) => draftCreated(activeTab.key, threadId)}
            />
          ) : (
            <ThreadView threadId={activeTab.threadId!} />
          )}
        </BoardBoundary>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </IconProvider>
  );
}

// The tab row sits where a titlebar would: inline with the traffic lights,
// draggable in its dead space. Its far right carries the settings gear — the
// old sidebar footer's one survivor.
function TabRow({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onNewThread,
  onOpenSettings,
}: {
  tabs: TabDescriptor[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        // h-11: TITLE_BAR_H — the tabs and the traffic lights share one
        // center line.
        "relative z-30 flex h-11 shrink-0 items-center gap-1 pr-3 select-none",
      )}
      style={{ paddingLeft: trafficInset() + 8 }}
    >
      <TabStrip
        tabs={tabs}
        activeKey={activeKey}
        onSelect={onSelect}
        onClose={onClose}
        onNewThread={onNewThread}
      />
      <span className="min-w-0 flex-1" aria-hidden />
      <button
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-[background-color,color,transform]",
          "duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:bg-hover hover:text-foreground active:scale-[0.96]",
        )}
      >
        <IconSettings size={15} />
      </button>
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

// The window's traffic-light inset in px (desktop only) — the room the tab
// strip leaves for the lights. Paired with X_NUDGE in
// src-tauri/src/trafficlights.rs, which shifts the lights right by 5.
function trafficInset(): number {
  const isDesktop =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return isDesktop ? 87 : 10;
}

export default App;
