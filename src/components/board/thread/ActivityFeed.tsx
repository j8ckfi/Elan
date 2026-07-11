// The merged activity feed: BoardEvents and top-level exchanges in one
// time-ordered list. Events are 28px system lines; exchanges are comment
// blocks (ExchangeBlock). Ties sort events first — "created the thread"
// belongs above a post filed the same instant.

import { Fragment, useMemo, type ReactNode } from "react";
import {
  toExchanges,
  USER,
  type Attachment,
  type BoardEvent,
  type Exchange,
  type Post,
  type RosterEntry,
} from "@/lib/board/types";
import { AgentAvatar } from "@/components/board/glyphs";
import { relativeTime } from "@/lib/relative-time";
import { ExchangeBlock } from "./ExchangeBlock";
import { SessionBlock } from "./SessionBlock";

type FeedItem =
  | { key: string; at: number; kind: "event"; event: BoardEvent }
  | { key: string; at: number; kind: "exchange"; exchange: Exchange };

interface ActivityFeedProps {
  posts: Post[];
  events: BoardEvent[];
  roster: RosterEntry[];
  onReply: (rootId: string, author: string) => void;
  onResolve: (rootId: string) => void;
}

export function ActivityFeed({ posts, events, roster, onReply, onResolve }: ActivityFeedProps) {
  const items = useMemo<FeedItem[]>(() => {
    const sorted = [...posts].sort((a, b) => a.createdAt - b.createdAt);
    const merged: FeedItem[] = [
      ...events.map((event) => ({
        key: `e-${event.id}`,
        at: event.at,
        kind: "event" as const,
        event,
      })),
      ...toExchanges(sorted).map((exchange) => ({
        key: `x-${exchange.root.id}`,
        at: exchange.root.createdAt,
        kind: "exchange" as const,
        exchange,
      })),
    ];
    return merged.sort(
      (a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1),
    );
  }, [posts, events]);

  return (
    <div className="flex flex-col">
      {items.map((item) =>
        item.kind === "event" ? (
          <Fragment key={item.key}>
            <EventLine event={item.event} roster={roster} />
            {/* A session-start line grows a session block beneath it when
                telemetry exists (docs/FRONTEND.md "Session telemetry"); the
                block resolves its own record + stream, so the line above
                renders exactly as before. */}
            {item.event.type === "session-start" &&
              typeof item.event.payload.sessionId === "string" && (
                <SessionBlock
                  sessionId={item.event.payload.sessionId}
                  roster={roster}
                />
              )}
          </Fragment>
        ) : (
          <ExchangeBlock
            key={item.key}
            exchange={item.exchange}
            roster={roster}
            onReply={onReply}
            onResolve={onResolve}
          />
        ),
      )}
    </div>
  );
}

// ── Event lines ──────────────────────────────────────────────────────────

function EventLine({ event, roster }: { event: BoardEvent; roster: RosterEntry[] }) {
  // The user has no avatar and no name anywhere in the feed — their event
  // lines read in the agentless voice ("Created the thread"), since the
  // human is the board's implicit narrator.
  if (event.actor === USER) {
    return (
      <div className="flex h-7 min-w-0 items-center text-[12.5px] text-muted-foreground">
        <span className="min-w-0 truncate first-letter:uppercase">
          {describe(event)}
          <span> · {relativeTime(event.at)}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-7 min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
      <AgentAvatar author={event.actor} roster={roster} size={14} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/90">{event.actor}</span>{" "}
        {describe(event)}
        <span> · {relativeTime(event.at)}</span>
      </span>
    </div>
  );
}

// A validated payload field, or a safe fallback — seed data should never
// miss, but a bad event line must not crash the feed.
function field<T extends string>(payload: Record<string, unknown>, key: string): T | undefined {
  const v = payload[key];
  return typeof v === "string" ? (v as T) : undefined;
}

function describe(event: BoardEvent): ReactNode {
  const p = event.payload;
  switch (event.type) {
    case "created":
      return "created the thread";
    case "tagged": {
      const handle = field(p, "handle");
      return (
        <>
          tagged <span className="font-medium text-foreground/90">@{handle ?? "?"}</span>
        </>
      );
    }
    case "session-start":
      return "started a session";
    case "session-end": {
      const outcome = field(p, "outcome");
      return outcome === "error"
        ? "session ended with an error"
        : outcome === "waiting"
          ? "session paused, waiting"
          : "session ended";
    }
    case "artifact": {
      const attachment = p.attachment as Attachment | undefined;
      return (
        <>
          attached{" "}
          {/* Faux-link: reads like Linear's artifact link, no-op in v1. */}
          <span className="cursor-pointer text-foreground hover:underline">
            {attachment?.name ?? "a file"}
          </span>
        </>
      );
    }
    case "label": {
      const added = field(p, "added");
      const removed = field(p, "removed");
      return added ? (
        <>
          added label <span className="text-foreground/90">{added}</span>
        </>
      ) : (
        <>
          removed label <span className="text-foreground/90">{removed ?? "?"}</span>
        </>
      );
    }
    // Stale storage can hold event types this build no longer knows
    // (e.g. the deleted "priority" events) — degrade, don't vanish or crash.
    default:
      return "updated the thread";
  }
}
