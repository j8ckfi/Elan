// Notion-style draft surface: ghost title + description in a fresh tab. The
// thread is created in the store on the first title keystroke and live-synced
// after; closing the tab with an empty title discards it (App owns that).
// Once the thread exists, Activity + composer fade in below and this surface
// is a normal thread you happen to still be titling.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "framer-motion";
import { useBoard, boardStore } from "@/lib/board/useBoard";
import {
  DropdownMenu,
  DropdownTrigger,
  DropdownContent,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { cn } from "@/lib/utils";
import { ActivityFeed } from "./ActivityFeed";
import { ThreadComposer, type ComposerMode } from "./ThreadComposer";

export function DraftThread({
  projectId,
  threadId,
  onCreated,
}: {
  /** Project preselected at invocation (sidebar "+"); default: first project. */
  projectId?: string;
  /** Set once the first keystroke created the thread. */
  threadId?: string;
  onCreated: (threadId: string) => void;
}) {
  const board = useBoard();
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => projectId ?? board.projects[0]?.id,
  );
  const thread = board.threads.find((t) => t.id === threadId);
  const project = board.projects.find(
    (p) => p.id === (thread?.projectId ?? selectedProjectId),
  );

  const [title, setTitle] = useState(thread?.title ?? "");
  const [body, setBody] = useState(thread?.body ?? "");
  const [mode, setMode] = useState<ComposerMode>({ kind: "comment" });

  // threadId lives in the tab model upstream; mirror it in a ref so the
  // debounced sync below never captures a stale undefined.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  // Create on first non-empty title keystroke; sync (debounced) after.
  const syncTimer = useRef<number | undefined>(undefined);
  const scheduleSync = useCallback((patch: { title?: string; body?: string }) => {
    if (syncTimer.current != null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = undefined;
      const id = threadIdRef.current;
      if (id) boardStore().updateThread(id, patch, "user");
    }, 300);
  }, []);
  useEffect(
    () => () => {
      // Flush, don't drop, a pending sync when the tab unmounts.
      if (syncTimer.current != null) window.clearTimeout(syncTimer.current);
    },
    [],
  );

  const onTitleChange = (next: string) => {
    setTitle(next);
    if (!threadIdRef.current) {
      if (!next.trim() || !selectedProjectId) return;
      const created = boardStore().createThread({
        projectId: selectedProjectId,
        title: next,
        body,
      });
      threadIdRef.current = created.id;
      onCreated(created.id);
      return;
    }
    scheduleSync({ title: next });
  };

  const onBodyChange = (next: string) => {
    setBody(next);
    if (threadIdRef.current) scheduleSync({ body: next });
  };

  const posts = useMemo(
    () => (threadId ? board.posts.filter((p) => p.threadId === threadId) : []),
    [board.posts, threadId],
  );
  const events = useMemo(
    () => (threadId ? board.events.filter((e) => e.threadId === threadId) : []),
    [board.events, threadId],
  );

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => titleRef.current?.focus(), []);

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    autoGrow(titleRef.current);
    autoGrow(bodyRef.current);
  }, [title, body]);

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[44rem] px-10 pb-16">
        {/* Project picker — locked once the thread exists (no moves in v1). */}
        <div className="mt-4">
          {thread ? (
            <span className="text-[12px] text-muted-foreground">
              {project?.name} › {project?.key}-{thread.number}
            </span>
          ) : (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "-mx-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground",
                      "transition-colors hover:bg-hover hover:text-foreground",
                    )}
                  />
                }
              >
                {project?.name ?? "Choose project"} ▾
              </DropdownTrigger>
              <DropdownContent>
                {board.projects.map((p, i) => (
                  <MenuItem
                    key={p.id}
                    index={i}
                    label={p.name}
                    checked={p.id === selectedProjectId}
                    onSelect={() => setSelectedProjectId(p.id)}
                  />
                ))}
              </DropdownContent>
            </DropdownMenu>
          )}
        </div>

        <textarea
          ref={titleRef}
          rows={1}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              bodyRef.current?.focus();
            }
          }}
          placeholder="New thread"
          className={cn(
            "mt-3 w-full resize-none overflow-hidden bg-transparent outline-none",
            "text-[21px] font-semibold leading-snug text-foreground",
            "placeholder:text-muted-foreground/40",
          )}
        />
        <textarea
          ref={bodyRef}
          rows={1}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          placeholder="Description…"
          className={cn(
            "mt-1 min-h-[60px] w-full resize-none overflow-hidden bg-transparent outline-none",
            "text-[13px] leading-[1.6] text-foreground/85",
            "placeholder:text-muted-foreground/40",
          )}
        />

        {/* Activity fades in once the thread is real. */}
        {thread && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="mt-8 flex items-center gap-3">
              <h2 className="text-[13px] font-medium text-foreground">Activity</h2>
              <div className="h-px flex-1 bg-border" aria-hidden />
            </div>
            <div className="mt-3">
              <ActivityFeed
                posts={posts}
                events={events}
                roster={board.roster}
                onReply={(rootId, author, rootAuthor) =>
                  setMode({ kind: "reply", rootId, author, rootAuthor })
                }
                onResolve={(rootId) => setMode({ kind: "resolve", rootId })}
              />
              <ThreadComposer
                threadId={thread.id}
                roster={board.roster}
                mode={mode}
                onModeChange={setMode}
              />
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
