// The Linear issue view: scrollable content column (title, body, merged
// activity feed) with the composer overlaid at the bottom of the same plane
// + fixed 280px properties rail. Composer reply/resolve mode lives here so
// comment blocks can flip it.

import { useCallback, useMemo, useState } from "react";
import { useBoard } from "@/lib/board/useBoard";
import { Markdown } from "@/components/chat/Markdown";
import { ActivityFeed } from "./ActivityFeed";
import { PropertiesRail } from "./PropertiesRail";
import { ThreadComposer, type ComposerMode } from "./ThreadComposer";
import { emphasizeMentions } from "./mentions";

export function ThreadView({ threadId }: { threadId: string }) {
  const board = useBoard();
  const [mode, setMode] = useState<ComposerMode>({ kind: "comment" });

  const thread = board.threads.find((t) => t.id === threadId);
  const project = thread && board.projects.find((p) => p.id === thread.projectId);

  const posts = useMemo(
    () => board.posts.filter((p) => p.threadId === threadId),
    [board.posts, threadId],
  );
  const events = useMemo(
    () => board.events.filter((e) => e.threadId === threadId),
    [board.events, threadId],
  );

  const onReply = useCallback(
    (rootId: string, author: string, rootAuthor: string) =>
      setMode({ kind: "reply", rootId, author, rootAuthor }),
    [],
  );
  const onResolve = useCallback((rootId: string) => setMode({ kind: "resolve", rootId }), []);

  // A deleted/unknown thread: designed empty state, not a crash. The tab
  // strip above is the way out — no local Back affordance needed.
  if (!thread || !project) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
        <p>This thread no longer exists.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Content + rail. @container so the rail can yield below ~900px pane width. */}
      <div className="flex min-h-0 flex-1 @container">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto w-full max-w-[44rem] px-10 pb-28">
              <h1 className="mt-6 text-[19px] font-semibold leading-[1.15] text-balance text-foreground">
                {thread.title}
              </h1>
              {thread.body.trim().length > 0 && (
                <div className="mt-3 text-pretty [&_.mari-md]:text-[13px] [&_.mari-md]:leading-[1.6] [&_.mari-md]:text-foreground/85">
                  <Markdown>{emphasizeMentions(thread.body, board.roster)}</Markdown>
                </div>
              )}

              <div className="mt-8 flex items-center gap-3">
                <h2 className="text-[13px] font-medium text-foreground">Activity</h2>
                <div className="h-px flex-1 bg-border" aria-hidden />
              </div>

              <div className="mt-3">
                <ActivityFeed
                  posts={posts}
                  events={events}
                  roster={board.roster}
                  onReply={onReply}
                  onResolve={onResolve}
                />
              </div>
            </div>
          </div>

          {/* Same plane as the feed: soft fade + the input card, no dock chrome. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0">
            <div
              aria-hidden
              className="h-14 bg-gradient-to-b from-transparent via-background/80 to-background"
            />
            <div className="bg-background px-10 pb-4">
              <div className="pointer-events-auto mx-auto w-full max-w-[44rem]">
                <ThreadComposer
                  threadId={thread.id}
                  roster={board.roster}
                  mode={mode}
                  onModeChange={setMode}
                />
              </div>
            </div>
          </div>
        </div>

        <PropertiesRail
          thread={thread}
          project={project}
          roster={board.roster}
          sessions={board.sessions}
        />
      </div>
    </div>
  );
}
