"use client";

import { forwardRef, useState, useEffect, type HTMLAttributes } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { RoseLoader } from "@/components/ui/RoseLoader";

const words = ["Thinking", "Planning", "Reasoning", "Refining"];

interface ThinkingLabelProps {
  /** Show the rose loader glyph before the cycling word. */
  showIcon?: boolean;
  /** Rose glyph size in px. */
  iconSize?: number;
  className?: string;
}

/**
 * The rose glyph + shimmering, cycling word ("Thinking… → Planning…").
 * Shared between the standalone ThinkingIndicator pill and the ThinkingSteps
 * header while the agent is working, so the two read as one thing.
 */
export function ThinkingLabel({
  showIcon = true,
  iconSize = 18,
  className,
}: ThinkingLabelProps) {
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    if (reduceMotion) return;
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % words.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [reduceMotion]);

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* Announced once; the cycling word below is aria-hidden. */}
      <span className="sr-only">Thinking…</span>
      {showIcon && (
        <RoseLoader
          size={iconSize}
          className="text-muted-foreground shrink-0"
        />
      )}
      <span
        aria-hidden="true"
        className="inline-grid text-[13px] overflow-hidden"
        style={{ fontVariationSettings: fontWeights.medium }}
      >
        {/* Invisible widest word reserves width so the row never jumps. */}
        <span className="col-start-1 row-start-1 invisible shimmer-text">
          {words.reduce((a, b) => (a.length >= b.length ? a : b))}
        </span>
        {reduceMotion ? (
          <span className="col-start-1 row-start-1 shimmer-text">
            {words[0]}
          </span>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={words[index]}
              className="col-start-1 row-start-1 shimmer-text"
              initial={{ y: "80%", opacity: 0 }}
              animate={{
                y: 0,
                opacity: 1,
                transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
              }}
              exit={{
                y: "-80%",
                opacity: 0,
                transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1] },
              }}
            >
              {words[index]}
            </motion.span>
          </AnimatePresence>
        )}
      </span>
    </span>
  );
}

interface ThinkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  showIcon?: boolean;
}

const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  ({ className, showIcon = true, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="status"
        className={cn("flex items-center gap-2 px-3 py-2", className)}
        {...props}
      >
        <ThinkingLabel showIcon={showIcon} iconSize={20} />
      </div>
    );
  },
);

ThinkingIndicator.displayName = "ThinkingIndicator";

export { ThinkingIndicator };
export type { ThinkingIndicatorProps };
export default ThinkingIndicator;
