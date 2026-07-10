// The docked comment box — last item of the activity feed, Linear's look:
// 1px border, 6px radius, no glow. Owns the draft, the auto-grow, and the
// "@" mention popover; reply/resolve mode is lifted to ThreadView so comment
// blocks can switch it.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { boardStore } from "@/lib/board/useBoard";
import { USER, type Author, type RosterEntry } from "@/lib/board/types";
import { MentionPopover } from "./MentionPopover";
import { FlagGlyph } from "./glyphlets";
import { cn } from "@/lib/utils";

export type ComposerMode =
  | { kind: "comment" }
  | { kind: "reply"; rootId: string; author: Author }
  | { kind: "resolve"; rootId: string };

const MAX_HEIGHT = 160; // ~8 lines of 13px text

// The live "@query" token ending at the caret, if any.
function mentionToken(value: string, caret: number): { start: number; query: string } | null {
  const upToCaret = value.slice(0, caret);
  const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(upToCaret);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2].toLowerCase() };
}

interface ThreadComposerProps {
  threadId: string;
  roster: RosterEntry[];
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
}

export function ThreadComposer({ threadId, roster, mode, onModeChange }: ThreadComposerProps) {
  const [value, setValue] = useState("");
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(
    () => (token ? roster.filter((r) => r.handle.toLowerCase().startsWith(token.query)) : []),
    [token, roster],
  );
  const popoverOpen = token != null && matches.length > 0;

  // Entering reply/resolve mode pulls focus into the box.
  useEffect(() => {
    if (mode.kind !== "comment") textareaRef.current?.focus();
  }, [mode]);

  const grow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  };

  const syncToken = () => {
    const el = textareaRef.current;
    if (!el) return;
    const next = mentionToken(el.value, el.selectionStart ?? el.value.length);
    setToken(next);
    if (next?.query !== token?.query) setActiveIndex(0);
  };

  const insertMention = (entry: RosterEntry) => {
    const el = textareaRef.current;
    if (!el || !token) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, token.start)}@${entry.handle} ${value.slice(caret)}`;
    const newCaret = token.start + entry.handle.length + 2;
    setValue(next);
    setToken(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      grow();
    });
  };

  const submit = () => {
    const body = value.trim();
    if (!body) return;
    boardStore().addPost({
      threadId,
      author: USER,
      body,
      replyTo: mode.kind === "comment" ? undefined : mode.rootId,
      kind: mode.kind === "resolve" ? "resolution" : "comment",
    });
    setValue("");
    setToken(null);
    onModeChange({ kind: "comment" });
    requestAnimationFrame(grow);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popoverOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => (i + delta + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(matches[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        // Closes the popover only — never backs out of the thread.
        e.preventDefault();
        e.stopPropagation();
        setToken(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && mode.kind !== "comment") {
      e.preventDefault();
      e.stopPropagation();
      onModeChange({ kind: "comment" });
    }
  };

  const empty = value.trim().length === 0;

  return (
    <div className="relative mt-4">
      <MentionPopover
        open={popoverOpen}
        entries={matches}
        roster={roster}
        activeIndex={activeIndex}
        onSelect={insertMention}
        onHover={setActiveIndex}
      />
      <div className="rounded-md border border-border">
        <div className="flex gap-2.5 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            {mode.kind !== "comment" && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                {mode.kind === "resolve" ? (
                  <>
                    <FlagGlyph className="text-foreground/80" />
                    <span>Resolving</span>
                  </>
                ) : (
                  <span>
                    Replying to{" "}
                    <span className="font-medium text-foreground/90">
                      {mode.author === USER ? "yourself" : mode.author}
                    </span>
                  </span>
                )}
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => onModeChange({ kind: "comment" })}
                  className="rounded transition-colors hover:text-foreground"
                >
                  cancel
                </button>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              placeholder="Send a message…"
              onChange={(e) => {
                setValue(e.target.value);
                grow();
                syncToken();
              }}
              onKeyDown={onKeyDown}
              onClick={syncToken}
              onBlur={() => setToken(null)}
              className={cn(
                "block w-full resize-none bg-transparent text-[13px] leading-[1.5] text-foreground",
                "placeholder:text-muted-foreground focus:outline-none",
                "max-h-[160px] overflow-y-auto",
              )}
            />
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={submit}
                disabled={empty}
                className={cn(
                  "rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground",
                  "transition-[opacity,transform] active:scale-[0.97]",
                  "disabled:pointer-events-none disabled:opacity-40",
                )}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
