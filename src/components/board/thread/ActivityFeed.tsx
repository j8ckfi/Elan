// The merged activity feed — the turn ledger (docs/FRONTEND.md). BoardEvents
// and top-level exchanges in one time-ordered list, then three rhythm passes:
// consecutive caught-up events fold into one quiet line, a same-author
// exchange inside the grouping window tucks under the previous byline
// (compact), and day dividers land where the calendar turns. Events are 28px
// system lines; exchanges are comment blocks (ExchangeBlock); session-start
// lines ARE the turn block when telemetry exists (SessionBlock renders the
// byline + worked chip; the plain event line is its fallback). Ties sort
// events first — "created the thread" belongs above a post filed the same
// instant.

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

// Same-author exchanges this close (and with a bare predecessor) share one
// byline — Slack's compact rhythm without Slack's ambiguity.
const GROUP_WINDOW_MS = 3 * 60_000;

type FeedItem =
  | { key: string; at: number; kind: "event"; event: BoardEvent }
  | { key: string; at: number; kind: "quiet"; actors: string[] }
  | { key: string; at: number; kind: "exchange"; exchange: Exchange; compact: boolean }
  | { key: string; at: number; kind: "day"; label: string };

interface ActivityFeedProps {
  posts: Post[];
  events: BoardEvent[];
  roster: RosterEntry[];
  onReply: (rootId: string, author: string, rootAuthor: string) => void;
  onResolve: (rootId: string) => void;
}

function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** An exchange rides compact when the previous ledger item is a bare (no
 *  replies, unresolved) exchange by the same agent within the window. */
function chains(prev: FeedItem | undefined, exchange: Exchange): boolean {
  if (!prev || prev.kind !== "exchange") return false;
  const a = prev.exchange;
  return (
    a.root.author === exchange.root.author &&
    a.root.author !== USER &&
    a.replies.length === 0 &&
    a.resolution == null &&
    exchange.root.createdAt - a.root.createdAt < GROUP_WINDOW_MS
  );
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
        compact: false,
      })),
    ];
    merged.sort(
      (a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1),
    );

    // Rhythm passes: fold quiet runs, chain same-author exchanges, cut days.
    const out: FeedItem[] = [];
    for (const item of merged) {
      const prev = out[out.length - 1];
      if (item.kind === "event" && item.event.type === "caught-up") {
        if (prev?.kind === "quiet") {
          if (!prev.actors.includes(item.event.actor)) prev.actors.push(item.event.actor);
          prev.at = item.at;
          continue;
        }
        out.push({ key: item.key, at: item.at, kind: "quiet", actors: [item.event.actor] });
        continue;
      }
      if (item.kind === "exchange" && chains(prev, item.exchange)) {
        out.push({ ...item, compact: true });
        continue;
      }
      out.push(item);
    }

    const now = Date.now();
    const withDays: FeedItem[] = [];
    let lastDay = "";
    for (const item of out) {
      const day = new Date(item.at).toDateString();
      if (day !== lastDay) {
        // The opening divider is noise — the feed starts where the thread does.
        if (lastDay !== "")
          withDays.push({ key: `d-${day}`, at: item.at, kind: "day", label: dayLabel(item.at, now) });
        lastDay = day;
      }
      withDays.push(item);
    }
    return withDays;
  }, [posts, events]);

  return (
    <div className="flex flex-col">
      {items.map((item) => {
        switch (item.kind) {
          case "day":
            return <DayDivider key={item.key} label={item.label} />;
          case "quiet":
            return <QuietLine key={item.key} actors={item.actors} at={item.at} />;
          case "exchange":
            return (
              <ExchangeBlock
                key={item.key}
                exchange={item.exchange}
                roster={roster}
                compact={item.compact}
                onReply={onReply}
                onResolve={onResolve}
              />
            );
          case "event": {
            const { event } = item;
            // A session-start line IS the turn block when telemetry exists
            // (byline + worked chip, timeline beneath); the plain event line
            // is the fallback for local mode / logless sessions.
            if (event.type === "session-start" && typeof event.payload.sessionId === "string") {
              return (
                <Fragment key={item.key}>
                  <SessionBlock
                    sessionId={event.payload.sessionId}
                    roster={roster}
                    fallback={<EventLine event={event} roster={roster} />}
                  />
                </Fragment>
              );
            }
            return <EventLine key={item.key} event={event} roster={roster} />;
          }
        }
      })}
    </div>
  );
}

// ── Rhythm lines ─────────────────────────────────────────────────────────

function DayDivider({ label }: { label: string }) {
  return (
    <div
      className="my-2 flex items-center gap-2.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/70 select-none"
      aria-hidden
    >
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Silence is an answer — a turn that (correctly) posted nothing still shows
 *  the ping was heard. Consecutive quiet turns merge into one line. */
function QuietLine({ actors, at }: { actors: string[]; at: number }) {
  const names =
    actors.length === 1
      ? actors[0]
      : `${actors.slice(0, -1).join(", ")} and ${actors[actors.length - 1]}`;
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 text-[12px] text-muted-foreground/70">
      <span aria-hidden className="w-3.5 text-center">✓</span>
      <span className="min-w-0 truncate">
        <span className="text-muted-foreground">{names}</span> caught up — nothing needed
        <span> · {relativeTime(at)}</span>
      </span>
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
    case "caught-up":
      // Normally folded into a QuietLine; this is the lone-event fallback.
      return "caught up — nothing needed";
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
    // (e.g. the deleted "priority"/"status" events) — degrade, don't crash.
    default:
      return "updated the thread";
  }
}
