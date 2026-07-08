import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconArrowDown, IconEdit } from "@tabler/icons-react";
import { IconProvider } from "@/lib/icon-context";
import { ProjectBreadcrumb } from "@/components/chat/ProjectBreadcrumb";
import { InputMessage } from "@/components/ui/input-message";
import { MariBeam } from "@/components/ui/MariBeam";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Conversation } from "@/components/chat/Conversation";
import { ComposerControls } from "@/components/chat/ComposerControls";
import { SessionSidebar } from "@/components/chat/SessionSidebar";
import { usePiSession, type PiSession } from "@/hooks/usePiSession";
import { useChatScroll } from "@/hooks/useChatScroll";
import { listSessions, onSessionsChanged } from "@/lib/pi/client";
import type { SessionSummary } from "@/lib/pi/sessions";
import { cn } from "@/lib/utils";

// ── Session manager types ────────────────────────────────────────────────────
// One open session = one tab = one mounted SessionEngine = one Pi process.
interface TabSpec {
  cwd?: string;
  sessionPath?: string;
  name?: string;
}
interface Tab {
  key: string;
  spec: TabSpec;
  lastViewed: number;
}
interface EngineStatus {
  sessionFile?: string;
  cwd?: string;
  running: boolean;
  connection: string;
  sessionName?: string;
}
interface EngineActions {
  rename: (name: string) => void;
}

let keyCounter = 0;
const nextKey = () => `s${++keyCounter}`;

// Warm pool: keep the active tab, every running (streaming) tab, and the last
// few recently-viewed idle tabs alive; reap the rest (unmount → kill process).
const WARM_IDLE = 5;

function App() {
  // Global on-disk session list (drives the sidebar; grouped by project).
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const refreshNow = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch(() => {});
  }, []);
  // Coalesce bursts (a turn writes the session file several times) into one
  // scan, so the watcher can fire freely without hammering the disk.
  const refreshTimer = useRef<number | undefined>(undefined);
  const refreshSessions = useCallback(() => {
    if (refreshTimer.current != null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      refreshNow();
    }, 120);
  }, [refreshNow]);

  useEffect(() => {
    refreshNow();
    // Filesystem watch (desktop) / poll (browser): sessions written by ANY
    // process — including a terminal `pi` — sync into the sidebar immediately.
    const off = onSessionsChanged(refreshSessions);
    const onFocus = () => refreshNow();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshNow, refreshSessions]);

  // Tabs, the active one, and the status each engine reports up.
  const firstKeyRef = useRef<string>(undefined);
  if (!firstKeyRef.current) firstKeyRef.current = nextKey();
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { key: firstKeyRef.current!, spec: {}, lastViewed: Date.now() },
  ]);
  const [activeKey, setActiveKey] = useState<string>(firstKeyRef.current!);
  const [statuses, setStatuses] = useState<Record<string, EngineStatus>>({});
  const actionsRef = useRef<Map<string, EngineActions>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const reportStatus = useCallback((key: string, status: EngineStatus) => {
    setStatuses((prev) => {
      const cur = prev[key];
      if (
        cur &&
        cur.sessionFile === status.sessionFile &&
        cur.cwd === status.cwd &&
        cur.running === status.running &&
        cur.connection === status.connection &&
        cur.sessionName === status.sessionName
      )
        return prev;
      return { ...prev, [key]: status };
    });
  }, []);

  const registerActions = useCallback((key: string, actions: EngineActions) => {
    actionsRef.current.set(key, actions);
  }, []);

  // ── tab operations ─────────────────────────────────────────────────────
  const newTab = useCallback((cwd?: string) => {
    const key = nextKey();
    setTabs((prev) => [...prev, { key, spec: { cwd }, lastViewed: Date.now() }]);
    setActiveKey(key);
  }, []);

  const openSession = useCallback((session: SessionSummary) => {
    const existing = tabsRef.current.find(
      (t) =>
        t.spec.sessionPath === session.path ||
        statusesRef.current[t.key]?.sessionFile === session.path,
    );
    if (existing) {
      setActiveKey(existing.key);
      setTabs((prev) =>
        prev.map((t) =>
          t.key === existing.key ? { ...t, lastViewed: Date.now() } : t,
        ),
      );
      return;
    }
    const key = nextKey();
    setTabs((prev) => [
      ...prev,
      {
        key,
        spec: { cwd: session.cwd, sessionPath: session.path, name: session.name },
        lastViewed: Date.now(),
      },
    ]);
    setActiveKey(key);
  }, []);

  // Sidebar switch passes a disk path — resolve it to the session record.
  const switchSession = useCallback(
    (sessionPath: string) => {
      const s = sessions.find((x) => x.path === sessionPath);
      if (s) openSession(s);
    },
    [sessions, openSession],
  );

  const activeCwd =
    tabs.find((t) => t.key === activeKey)?.spec.cwd ??
    statuses[activeKey]?.cwd;

  const newSession = useCallback(
    () => newTab(statusesRef.current[activeKey]?.cwd),
    [newTab, activeKey],
  );
  const newSessionIn = useCallback((cwd: string) => newTab(cwd), [newTab]);

  const renameActive = useCallback(
    (name: string) => actionsRef.current.get(activeKey)?.rename(name),
    [activeKey],
  );

  // ── warm-pool reaping ──────────────────────────────────────────────────
  useEffect(() => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const keep = new Set<string>([activeKey]);
      for (const t of prev) if (statuses[t.key]?.running) keep.add(t.key);
      const rest = prev
        .filter((t) => !keep.has(t.key))
        .sort((a, b) => b.lastViewed - a.lastViewed);
      for (const t of rest.slice(0, WARM_IDLE)) keep.add(t.key);
      const next = prev.filter((t) => keep.has(t.key));
      return next.length === prev.length ? prev : next;
    });
  }, [activeKey, statuses]);

  // Drop stale status/action entries for reaped tabs.
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.key));
    for (const k of actionsRef.current.keys())
      if (!live.has(k)) actionsRef.current.delete(k);
    setStatuses((prev) => {
      const next: Record<string, EngineStatus> = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (live.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  // Sessions with an in-flight run, by disk path — the sidebar's live dots.
  const runningPaths = useMemo(() => {
    const s = new Set<string>();
    for (const st of Object.values(statuses))
      if (st.running && st.sessionFile) s.add(st.sessionFile);
    return s;
  }, [statuses]);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activePath =
    activeTab?.spec.sessionPath ?? statuses[activeKey]?.sessionFile;

  // Recent project directories (unique cwds, recency-ordered), active pinned —
  // the folder dropdown's list.
  const recents = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    if (activeCwd) {
      seen.add(activeCwd);
      out.push(activeCwd);
    }
    for (const s of sessions) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.add(s.cwd);
        out.push(s.cwd);
      }
    }
    return out;
  }, [sessions, activeCwd]);

  // Disk title fallback for the breadcrumb thread (before the engine reports).
  const fallbackThread = useMemo(() => {
    if (!activePath) return undefined;
    return sessions.find((s) => s.path === activePath)?.title;
  }, [sessions, activePath]);

  // Drag-resizable sidebar width, persisted across launches.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem("mari.sidebarWidth"));
      return Number.isFinite(n) && n > 0 ? Math.min(460, Math.max(220, n)) : 256;
    } catch {
      return 256;
    }
  });
  const handleResize = (w: number) => {
    setSidebarWidth(w);
    try {
      localStorage.setItem("mari.sidebarWidth", String(w));
    } catch {
      /* storage disabled */
    }
  };

  return (
    <IconProvider defaultLibrary="tabler">
      <SidebarProvider
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        {/* Sidebar toggle (+ new chat) pinned top-left, always beside the
            traffic lights, over whichever pane is on the left. */}
        <TitleBar onNewChat={newSession} />
        <SessionSidebar
          sessions={sessions}
          activePath={activePath}
          runningPaths={runningPaths}
          onNew={newSession}
          onNewInProject={newSessionIn}
          onSwitch={switchSession}
          onRename={renameActive}
          onResize={handleResize}
        />
        <SidebarInset className="flex h-screen min-w-0 flex-col bg-background text-foreground">
          {tabs.map((t) => (
            <SessionEngine
              key={t.key}
              procKey={t.key}
              spec={t.spec}
              active={t.key === activeKey}
              recents={recents}
              fallbackThread={t.key === activeKey ? fallbackThread : undefined}
              onReport={reportStatus}
              registerActions={registerActions}
              onActivity={refreshSessions}
              onSelectProject={newSessionIn}
            />
          ))}
        </SidebarInset>
      </SidebarProvider>
    </IconProvider>
  );
}

// ── Session engine ───────────────────────────────────────────────────────────
// Runs one Pi session's hook. Reports status up and (only when it's the active
// tab) renders the chat surface. Background engines render nothing but keep
// reducing their event stream, so their agent keeps running off screen.
function SessionEngine({
  procKey,
  spec,
  active,
  recents,
  fallbackThread,
  onReport,
  registerActions,
  onActivity,
  onSelectProject,
}: {
  procKey: string;
  spec: TabSpec;
  active: boolean;
  recents: string[];
  fallbackThread?: string;
  onReport: (key: string, status: EngineStatus) => void;
  registerActions: (key: string, actions: EngineActions) => void;
  onActivity: () => void;
  onSelectProject: (cwd: string) => void;
}) {
  const pi = usePiSession({
    procKey,
    cwd: spec.cwd,
    sessionPath: spec.sessionPath,
    name: spec.name,
    onActivity,
  });

  const { identity, streaming, connection, renameSession } = pi;
  useEffect(() => {
    onReport(procKey, {
      sessionFile: identity.sessionFile,
      cwd: identity.cwd,
      running: streaming,
      connection,
      sessionName: identity.sessionName,
    });
  }, [
    procKey,
    identity.sessionFile,
    identity.cwd,
    identity.sessionName,
    streaming,
    connection,
    onReport,
  ]);

  useEffect(() => {
    registerActions(procKey, { rename: renameSession });
  }, [procKey, renameSession, registerActions]);

  if (!active) return null;
  return (
    <ChatSurface
      pi={pi}
      spec={spec}
      recents={recents}
      fallbackThread={fallbackThread}
      onSelectProject={onSelectProject}
    />
  );
}

// ── Chat surface ─────────────────────────────────────────────────────────────
// The visible pane for the active session: breadcrumb header, the transcript
// (or Cursor-style home), and the composer.
function ChatSurface({
  pi,
  spec,
  recents,
  fallbackThread,
  onSelectProject,
}: {
  pi: PiSession;
  spec: TabSpec;
  recents: string[];
  fallbackThread?: string;
  onSelectProject: (cwd: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // pi.items is a fresh array each streamed update — the revision the scroll
  // controller re-anchors on.
  const scroll = useChatScroll(pi.streaming, pi.items);

  const isHome = pi.items.length === 0;
  const projectCwd = pi.identity.cwd ?? spec.cwd;
  const threadName =
    pi.identity.sessionName ??
    fallbackThread ??
    (pi.items.length > 0 ? "Untitled" : "New chat");

  // Home: an interactive folder switcher. Conversation header: display-only.
  const homeBreadcrumb = (
    <ProjectBreadcrumb
      cwd={projectCwd}
      recents={recents}
      onSelectProject={onSelectProject}
    />
  );
  const headerBreadcrumb = (
    <ProjectBreadcrumb
      cwd={projectCwd}
      thread={threadName}
      recents={recents}
      onSelectProject={onSelectProject}
      readonly
    />
  );

  const disconnectedBanner = pi.connection === "disconnected" && (
    <div className="mb-2 flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
      <span>Pi disconnected.</span>
      <button
        onClick={() => void pi.restart()}
        className="rounded-md px-2 py-1 font-medium hover:bg-destructive/15"
      >
        Reconnect
      </button>
    </div>
  );

  const composer = (
    <MariBeam model={pi.model} active={pi.streaming}>
      <InputMessage
        className="border border-border shadow-lg dark:border-transparent dark:shadow-surface-2"
        value={draft}
        onValueChange={setDraft}
        files={files}
        onFilesChange={setFiles}
        status={pi.streaming ? "streaming" : "idle"}
        onStop={pi.abort}
        placeholder={isHome ? "Do anything" : "Message Pi…"}
        leftSlot={
          <ComposerControls
            model={pi.model}
            availableModels={pi.availableModels}
            thinkingLevel={pi.thinkingLevel}
            stats={pi.stats}
            onSelectModel={pi.setModelById}
            onSelectThinking={pi.setThinking}
          />
        }
        onSend={(text, sentFiles) => {
          void pi.sendPrompt(text, sentFiles);
          setDraft("");
          setFiles([]);
          scroll.onUserSend();
        }}
      />
    </MariBeam>
  );

  return (
    <>
      {/* Top row, inline with the traffic lights: breadcrumb (display-only) +
          status. */}
      <ContentHeader
        breadcrumb={!isHome ? headerBreadcrumb : null}
        connection={pi.connection}
      />

      {isHome ? (
        // Cursor-style home: breadcrumb directly above the centered chat box.
        <div className="-mt-8 flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16">
          <div className="w-full max-w-[46rem]">
            <div className="mb-2 px-1">{homeBreadcrumb}</div>
            {disconnectedBanner}
            {composer}
          </div>
        </div>
      ) : (
        <>
          {/* Conversation */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroll.scrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              style={{ overflowAnchor: "none" }}
              tabIndex={0}
            >
              {/* Bottom-align so short transcripts sit above the composer, and
                  the reserved spacer sums with content to one viewport — a fresh
                  turn's whitespace is eaten by the streaming answer rather than
                  becoming dead, scrollable space below it. */}
              <div className="flex min-h-full flex-col justify-end">
                <div ref={scroll.contentRef}>
                  <Conversation
                    items={pi.items}
                    streaming={pi.streaming}
                    onAnswer={pi.answer}
                  />
                </div>
                <div
                  aria-hidden
                  style={{
                    height: scroll.spacerHeight,
                    overflowAnchor: "none",
                  }}
                />
              </div>
            </div>

            {/* Jump to latest — fades/scales in when scrolled away. */}
            <JumpToLatest
              visible={!scroll.atBottom}
              onClick={scroll.scrollToLatest}
            />

            {/* Polite status at message boundaries (not per token). */}
            <span className="sr-only" role="status" aria-live="polite">
              {pi.streaming ? "Assistant is responding" : ""}
            </span>
          </div>

          {/* Composer — docked at the bottom during a conversation. */}
          <div className="shrink-0 px-6 pb-6 pt-2">
            <div className="mx-auto w-full max-w-[46rem]">
              {disconnectedBanner}
              {composer}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// The window's traffic-light inset in px (desktop only).
function trafficInset(): number {
  const isDesktop =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return isDesktop ? 82 : 10;
}

// Fixed toggle cluster: sidebar toggle (+ new-chat) pinned to the window's
// top-left, right beside the traffic lights, no matter the sidebar state. Small
// and inline with the lights (matches Claude Code / Codex). Draggable.
function TitleBar({ onNewChat }: { onNewChat: () => void }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <div
      data-tauri-drag-region
      className="fixed left-0 top-0 z-50 flex h-8 items-center gap-0.5 pr-2 select-none"
      style={{ paddingLeft: trafficInset() }}
    >
      <SidebarTrigger className="size-7 shrink-0 rounded-md text-foreground/65 hover:bg-hover hover:text-foreground [&_svg]:size-[16px]" />
      {/* New chat — fades in when the sidebar is closed. */}
      <button
        onClick={onNewChat}
        aria-label="New chat"
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

// The content pane's top row — inline with the traffic lights (h-8). Holds the
// breadcrumb (project ▸ thread) and the connection dot. When the sidebar is
// closed the fixed toggle cluster overlays this pane's top-left, so pad past it.
function ContentHeader({
  breadcrumb,
  connection,
}: {
  breadcrumb: ReactNode;
  connection: string;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pl = collapsed ? trafficInset() + 66 : 20;

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 items-center gap-2 pr-3 select-none"
      style={{ paddingLeft: pl }}
    >
      <div className="min-w-0 flex-1">{breadcrumb}</div>
      <ConnectionDot status={connection} />
    </header>
  );
}

function JumpToLatest({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label="Jump to latest"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 -translate-x-1/2",
        "flex h-8 w-8 items-center justify-center rounded-full",
        "bg-popover text-foreground/80 shadow-lg border border-border",
        "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:text-foreground",
        // Enter from just below with a slight scale; exit reverses. Non-
        // interactive while hidden so it never steals focus or clicks.
        visible
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-2 scale-90 opacity-0",
      )}
      style={{ overflowAnchor: "none" }}
    >
      <IconArrowDown size={16} />
    </button>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-destructive";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

export default App;
