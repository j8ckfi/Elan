// One exchange: a top-level post and its replies. Resolved exchanges collapse
// to a single summary line (Linear's "N replies" row + the ⚑ text); unresolved
// ones always render expanded. Comment anatomy is shared between roots and
// replies — replies just shrink the avatar and sit behind a 2px thread line.
// The turn-ledger rhythm (2026-07-11, docs/FRONTEND.md "The turn ledger"):
// long agent posts fold at ~6 lines, timestamps surface on hover, `compact`
// stacks a consecutive same-author post under the previous byline, and a
// post addressed to @user carries the ledger's only emphasis — the hairline
// rail + "→ you" chip.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Markdown } from "@/components/chat/Markdown";
import { AgentAvatar } from "@/components/board/glyphs";
import { USER, type Exchange, type Post, type RosterEntry } from "@/lib/board/types";
import { exchangeParticipants } from "@/lib/board/types";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { emphasizeMentions } from "./mentions";
import { ChevronGlyph, FlagGlyph, PaperclipGlyph } from "./glyphlets";

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

// ~6 lines of 13px/1.55 text; posts under FOLD_MAX + FOLD_SLACK never fold
// (a fold that hides two lines is worse than the two lines).
const FOLD_MAX = 132;
const FOLD_SLACK = 40;

const authorName = (author: string) => (author === USER ? "You" : author);

/** An agent post that @mentions the user — the feed's one emphasis device. */
const addressesUser = (post: Post) =>
  post.author !== USER && /(^|[^a-z0-9._-])@user\b/i.test(post.body);

interface ExchangeBlockProps {
  exchange: Exchange;
  roster: RosterEntry[];
  /** Consecutive same-author follow-up: no byline, tucked under the previous
   *  exchange's header (ActivityFeed decides — see its grouping rule). */
  compact?: boolean;
  onReply: (rootId: string, author: string, rootAuthor: string) => void;
  onResolve: (rootId: string) => void;
}

export function ExchangeBlock({
  exchange,
  roster,
  compact = false,
  onReply,
  onResolve,
}: ExchangeBlockProps) {
  const resolved = exchange.resolution != null;
  const [expanded, setExpanded] = useState(!resolved);
  const rootAuthor = exchange.root.author;

  const body = (
    <div className={compact ? undefined : "py-1"}>
      <CommentBlock
        post={exchange.root}
        roster={roster}
        compact={compact}
        onReply={() => onReply(exchange.root.id, rootAuthor, rootAuthor)}
        onResolve={resolved ? undefined : () => onResolve(exchange.root.id)}
      />
      {exchange.replies.length > 0 && (
        <div className="ml-[11px] flex flex-col border-l-2 border-border pl-4">
          {exchange.replies.map((reply) => (
            <CommentBlock
              key={reply.id}
              post={reply}
              roster={roster}
              size={20}
              onReply={() => onReply(exchange.root.id, reply.author, rootAuthor)}
            />
          ))}
        </div>
      )}
    </div>
  );

  // Unresolved: always open, no collapse chrome.
  if (!resolved) return <div className={compact ? "-mt-1" : "py-1"}>{body}</div>;

  const participants = exchangeParticipants(exchange).map(authorName);
  const summary = exchange.resolution!.body;

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 -mx-1 text-left",
          "transition-colors hover:bg-hover",
        )}
      >
        <ChevronGlyph open={expanded} className="text-muted-foreground" />
        {expanded ? (
          <span className="text-[12px] text-muted-foreground transition-colors group-hover:text-foreground">
            Collapse
          </span>
        ) : (
          <>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {exchange.replies.length} {exchange.replies.length === 1 ? "reply" : "replies"} ·{" "}
              {participants.join(" ⇄ ")}
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground">{summary}</span>
          </>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── The fold ─────────────────────────────────────────────────────────────
// Agents write essays; the ledger shows the lede. Measured, not guessed: the
// fold only appears when the rendered body genuinely overflows (ResizeObserver
// keeps late-loading markdown images honest). User bubbles never fold.

function FoldableBody({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > FOLD_MAX + FOLD_SLACK);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const folded = overflows && !open;

  return (
    <div>
      <div
        className={cn("relative", folded && "overflow-hidden")}
        style={folded ? { maxHeight: FOLD_MAX } : undefined}
      >
        <div ref={innerRef}>{children}</div>
        {folded && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-background"
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── Comment block ────────────────────────────────────────────────────────

interface CommentBlockProps {
  post: Post;
  roster: RosterEntry[];
  /** Avatar diameter — 24 for roots, 20 for replies. */
  size?: number;
  /** Same-author follow-up: byline hidden, body aligned under the previous. */
  compact?: boolean;
  onReply?: () => void;
  onResolve?: () => void;
}

function CommentBlock({
  post,
  roster,
  size = 24,
  compact = false,
  onReply,
  onResolve,
}: CommentBlockProps) {
  const isResolution = post.kind === "resolution";

  // The human speaks in bubbles — no avatar, no name, left-aligned, timestamp
  // outside. The bubble shape alone says "you"; it rhymes with the composer.
  // Agents and the user are different sides of the product (docs/ELAN.md).
  if (post.author === USER) {
    return (
      <div className="group/comment relative py-1.5">
        <HoverActions onReply={onReply} onResolve={onResolve} />
        <div className="flex items-end gap-2">
          <div
            className={cn(
              "min-w-0 max-w-[85%] rounded-[10px] px-3.5 py-2",
              "[&_.mari-md]:text-[13px] [&_.mari-md]:leading-[1.55]",
              isResolution ? "bg-accent" : "bg-secondary",
            )}
          >
            {isResolution && (
              <div className="mb-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <FlagGlyph className="text-foreground/80" />
                Resolved
              </div>
            )}
            <Markdown>{emphasizeMentions(post.body, roster)}</Markdown>
          </div>
          <span className="shrink-0 pb-0.5 text-[12px] text-muted-foreground">
            {relativeTime(post.createdAt)}
          </span>
        </div>
        <Attachments post={post} className="mt-1.5" />
      </div>
    );
  }

  const forYou = addressesUser(post);
  // Body indent aligns with the name, not the avatar.
  const indent = size + 8;

  const markdown = (
    <div
      className={cn(
        "[&_.mari-md]:text-[13px] [&_.mari-md]:leading-[1.55]",
        isResolution && "rounded-md bg-accent px-3 py-2",
      )}
    >
      <Markdown>{emphasizeMentions(post.body, roster)}</Markdown>
    </div>
  );

  return (
    <div
      className={cn(
        "group/comment relative -mx-3 rounded-md border border-transparent px-3",
        compact ? "py-1" : "py-2.5",
        "transition-colors hover:border-border",
        // Addressed to you: the hairline rail, the ledger's only emphasis.
        forYou && "border-l-2 border-l-foreground hover:border-l-foreground",
      )}
    >
      {!compact && (
        <div className="flex items-center gap-2">
          <AgentAvatar author={post.author} roster={roster} size={size} />
          {isResolution && <FlagGlyph className="text-foreground/80" />}
          <span className="truncate text-[13px] font-medium text-foreground">
            {authorName(post.author)}
          </span>
          {forYou && (
            <span className="rounded border border-border bg-accent px-1.5 text-[10.5px] leading-[16px] text-foreground">
              → you
            </span>
          )}
          {/* Timestamps ride the hover — the ledger reads by rhythm, not clock. */}
          <span className="shrink-0 text-[12px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/comment:opacity-100">
            {relativeTime(post.createdAt)}
          </span>
        </div>
      )}
      <div style={{ paddingLeft: indent }}>
        <div className={compact ? undefined : "mt-1"}>
          {/* Resolutions keep their accent card unfolded — they ARE the summary. */}
          {isResolution ? markdown : <FoldableBody>{markdown}</FoldableBody>}
        </div>
        <Attachments post={post} className="mt-2" />
      </div>
      <HoverActions onReply={onReply} onResolve={onResolve} />
    </div>
  );
}

function Attachments({ post, className }: { post: Post; className?: string }) {
  if (post.attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {post.attachments.map((a) => (
        <span
          key={a.path}
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[12px] text-muted-foreground"
        >
          <PaperclipGlyph />
          {a.name}
        </span>
      ))}
    </div>
  );
}

// Floated into the card's top-right on hover (Linear's pattern) — an
// in-flow row would reserve height under every post and bloat the ledger's
// rhythm, compact stacks especially. Keyboard focus reveals it too.
function HoverActions({ onReply, onResolve }: { onReply?: () => void; onResolve?: () => void }) {
  if (!onReply && !onResolve) return null;
  return (
    <div
      className={cn(
        "absolute right-2 top-1.5 z-10 flex gap-1",
        "pointer-events-none opacity-0 transition-opacity duration-150",
        "group-hover/comment:pointer-events-auto group-hover/comment:opacity-100",
        "focus-within:pointer-events-auto focus-within:opacity-100",
      )}
    >
      {onReply && (
        <button
          type="button"
          onClick={onReply}
          className={cn(
            "rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-muted-foreground",
            "transition-colors hover:bg-hover hover:text-foreground",
          )}
        >
          Reply
        </button>
      )}
      {onResolve && (
        <button
          type="button"
          onClick={onResolve}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-muted-foreground",
            "transition-colors hover:bg-hover hover:text-foreground",
          )}
        >
          <FlagGlyph size={10} />
          Resolve
        </button>
      )}
    </div>
  );
}
