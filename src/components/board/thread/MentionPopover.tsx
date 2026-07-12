// The "@" mention popover, anchored above the composer. The composer owns
// filtering + keyboard state; this is the presentation. Origin-aware scale-in
// per FRONTEND.md motion; onMouseDown (not click) selects so the textarea
// never loses focus.

import { motion, AnimatePresence } from "framer-motion";
import { AgentAvatar } from "@/components/board/glyphs";
import type { RosterEntry } from "@/lib/board/types";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";

interface MentionPopoverProps {
  open: boolean;
  entries: RosterEntry[];
  roster: RosterEntry[];
  activeIndex: number;
  onSelect: (entry: RosterEntry) => void;
  onHover: (index: number) => void;
}

export function MentionPopover({
  open,
  entries,
  roster,
  activeIndex,
  onSelect,
  onHover,
}: MentionPopoverProps) {
  const shown = open && entries.length > 0;

  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          role="listbox"
          aria-label="Mention an agent"
          initial={{ opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 2, transition: spring.fast.exit }}
          transition={spring.fast}
          style={{ transformOrigin: "bottom left" }}
          className="absolute bottom-full left-0 z-30 mb-1.5 w-64 rounded-md border border-border bg-background p-1 shadow-[var(--shadow-3)]"
        >
          {entries.map((entry, i) => (
            <button
              key={entry.handle}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              tabIndex={-1}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(entry);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left",
                i === activeIndex && "bg-hover",
              )}
            >
              <AgentAvatar author={entry.handle} roster={roster} size={18} />
              <span className="truncate text-[13px] text-foreground">@{entry.handle}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {entry.harness}
              </span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
