// One exchange: a top-level post and its replies. Resolved exchanges collapse
// to a single summary line (Linear's "N replies" row + the ⚑ text); unresolved
// ones always render expanded. Comment anatomy is shared between roots and
// replies — replies just shrink the avatar and sit behind a 2px thread line.

import { useState } from "react";
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

const authorName = (author: string) => (author === USER ? "You" : author);

interface ExchangeBlockProps {
  exchange: Exchange;
  roster: RosterEntry[];
  onReply: (rootId: string, author: string) => void;
  onResolve: (rootId: string) => void;
}

export function ExchangeBlock({ exchange, roster, onReply, onResolve }: ExchangeBlockProps) {
  const resolved = exchange.resolution != null;
  const [expanded, setExpanded] = useState(!resolved);

  const body = (
    <div className="py-1">
      <CommentBlock
        post={exchange.root}
        roster={roster}
        onReply={() => onReply(exchange.root.id, exchange.root.author)}
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
              onReply={() => onReply(exchange.root.id, reply.author)}
            />
          ))}
        </div>
      )}
    </div>
  );

  // Unresolved: always open, no collapse chrome.
  if (!resolved) return <div className="py-1">{body}</div>;

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

// ── Comment block ────────────────────────────────────────────────────────

interface CommentBlockProps {
  post: Post;
  roster: RosterEntry[];
  /** Avatar diameter — 24 for roots, 20 for replies. */
  size?: number;
  onReply?: () => void;
  onResolve?: () => void;
}

function CommentBlock({ post, roster, size = 24, onReply, onResolve }: CommentBlockProps) {
  const isResolution = post.kind === "resolution";

  // The human speaks in bubbles — no avatar, no name, left-aligned, timestamp
  // outside. The bubble shape alone says "you"; it rhymes with the composer.
  // Agents and the user are different sides of the product (docs/ELAN.md).
  if (post.author === USER) {
    return (
      <div className="group/comment py-1.5">
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
        {post.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
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
        )}
        {(onReply || onResolve) && (
          <div
            className={cn(
              "mt-1 flex gap-3 opacity-0 transition-opacity duration-150",
              "group-hover/comment:opacity-100 focus-within:opacity-100",
            )}
          >
            {onReply && (
              <button
                type="button"
                onClick={onReply}
                className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Reply
              </button>
            )}
            {onResolve && (
              <button
                type="button"
                onClick={onResolve}
                className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <FlagGlyph size={10} />
                Resolve
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Body indent aligns with the name, not the avatar.
  const indent = size + 8;

  return (
    <div
      className={cn(
        "group/comment relative -mx-3 rounded-md border border-transparent px-3 py-2.5",
        "transition-colors hover:border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar author={post.author} roster={roster} size={size} />
        {isResolution && <FlagGlyph className="text-foreground/80" />}
        <span className="truncate text-[13px] font-medium text-foreground">
          {authorName(post.author)}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {relativeTime(post.createdAt)}
        </span>
      </div>
      <div style={{ paddingLeft: indent }}>
        <div
          className={cn(
            "mt-1 [&_.mari-md]:text-[13px] [&_.mari-md]:leading-[1.55]",
            isResolution && "rounded-md bg-accent px-3 py-2",
          )}
        >
          <Markdown>{emphasizeMentions(post.body, roster)}</Markdown>
        </div>
        {post.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
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
        )}
        {(onReply || onResolve) && (
          <div
            className={cn(
              "mt-1 flex gap-3 opacity-0 transition-opacity duration-150",
              "group-hover/comment:opacity-100 focus-within:opacity-100",
            )}
          >
            {onReply && (
              <button
                type="button"
                onClick={onReply}
                className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Reply
              </button>
            )}
            {onResolve && (
              <button
                type="button"
                onClick={onResolve}
                className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <FlagGlyph size={10} />
                Resolve
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
