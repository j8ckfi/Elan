// A compact context-window gauge for the composer (Codex-style): a small ring
// that fills as the active session consumes its context window, with the full
// token/cost readout on hover. Replaces the sidebar-footer meter — all usage
// lives here now, next to the model it belongs to.
//
// The hover panel is styled to match the chat bar itself (system background,
// thin border + shadow) rather than an inverted tooltip, so it reads as part of
// the same surface family.

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { Model, SessionStats } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
function fmtCost(c: number): string {
  if (c === 0) return "$0";
  if (c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}

const SIZE = 16;
const STROKE = 2;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

export function ContextRing({
  stats,
  model,
}: {
  stats: SessionStats | null;
  model: Model | null;
}) {
  const ctx = stats?.contextUsage;
  const contextWindow = ctx?.contextWindow ?? model?.contextWindow ?? 0;
  // Nothing meaningful to show until we know the window size.
  if (!contextWindow) return null;

  const pct =
    ctx && ctx.percent != null ? Math.min(100, Math.max(0, ctx.percent)) : 0;
  const usedTokens = ctx?.tokens ?? 0;

  // Calm until it matters, then escalate — same tones as the old meter.
  const tone =
    pct >= 90
      ? "text-destructive"
      : pct >= 70
        ? "text-amber-500"
        : "text-foreground/55";

  const dash = (pct / 100) * C;

  return (
    <TooltipPrimitive.Provider delay={200}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        aria-label={`Context ${Math.round(pct)}% used`}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-[transform,background-color,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-hover active:scale-90"
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={cn("shrink-0", tone)}
        >
          {/* Track */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            className="opacity-20"
          />
          {/* Fill — starts at 12 o'clock, sweeps clockwise. */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            className="transition-[stroke-dasharray] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]"
          />
        </svg>
      </TooltipPrimitive.Trigger>

      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={10} className="z-50">
          <TooltipPrimitive.Popup
            className={cn(
              // Match the chat bar: system background, thin border + soft shadow.
              "z-50 flex w-fit origin-[var(--transform-origin)] flex-col gap-1 rounded-xl border border-border bg-popover px-3.5 py-3 text-[12px] text-foreground shadow-lg",
              "dark:border-transparent dark:shadow-surface-2",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-100",
            )}
          >
            <div className="font-medium">Context window</div>
            <div className="text-muted-foreground">
              {Math.round(pct)}% used
              <span className="text-muted-foreground/60">
                {" "}
                ({Math.round(100 - pct)}% left)
              </span>
            </div>
            <div className="tabular-nums text-muted-foreground">
              {fmtTokens(usedTokens)} / {fmtTokens(contextWindow)} tokens
            </div>
            {(stats?.tokens?.total || stats?.cost != null) && (
              <div className="mt-0.5 border-t border-border pt-1.5 tabular-nums text-muted-foreground">
                {fmtTokens(stats?.tokens?.total ?? 0)} used ·{" "}
                {fmtCost(stats?.cost ?? 0)}
              </div>
            )}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
