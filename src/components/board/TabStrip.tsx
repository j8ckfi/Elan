// The content pane's tab row: one persistent board tab (follows the sidebar
// selection) + one closable tab per open thread. Built on FF's TabsSubtle in
// activeLabel mode. The tab bar is the ONLY place the brand gradient lives:
// every thread tab carries the working grid — still and grey while nothing
// runs, the animated gradient while a session works the thread.

import { useMemo } from "react";
import { IconInbox, IconPlus } from "@tabler/icons-react";
import { GradientSpin } from "gradient-spin";
import { TabsSubtle, TabsSubtleItem } from "@/components/ui/tabs-subtle";
import type { IconComponentProps } from "@/lib/icon-map";
import { cn } from "@/lib/utils";

export interface TabDescriptor {
  key: string;
  title: string;
  running: boolean;
}

// GradientSpin's geometry, frozen: the same 3×3 grid, every cell resting
// grey in the system color. The idle state of the brand mark.
const GRID = { rows: 3, cols: 3, cellSize: 3, cellGap: 1.5, cellRadius: 1 };

function StillGrid({ className }: { className?: string }) {
  const { rows, cols, cellSize, cellGap, cellRadius } = GRID;
  const side = (n: number) => n * cellSize + (n - 1) * cellGap;
  const cells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={c * (cellSize + cellGap)}
          y={r * (cellSize + cellGap)}
          width={cellSize}
          height={cellSize}
          rx={cellRadius}
          fill="currentColor"
          opacity={0.35}
        />,
      );
  return (
    <svg
      width={side(cols)}
      height={side(rows)}
      viewBox={`0 0 ${side(cols)} ${side(rows)}`}
      className={cn("text-muted-foreground", className)}
      aria-hidden
    >
      {cells}
    </svg>
  );
}

// Stable per-running-state icon components — TabsSubtleItem measures its
// children, so identity churn would remount SVGs every render for nothing.
const threadIconCache = new Map<string, React.ComponentType<IconComponentProps>>();
function threadIcon(running: boolean) {
  const k = String(running);
  let Icon = threadIconCache.get(k);
  if (!Icon) {
    Icon = function ThreadTabIcon({ className }: IconComponentProps) {
      if (running)
        return (
          <GradientSpin
            cellSize={GRID.cellSize}
            cellGap={GRID.cellGap}
            label="Working"
            className={className}
          />
        );
      return <StillGrid className={className} />;
    };
    threadIconCache.set(k, Icon);
  }
  return Icon;
}

export function TabStrip({
  boardLabel,
  tabs,
  activeKey,
  onSelect,
  onClose,
  onNewThread,
}: {
  boardLabel: string;
  tabs: TabDescriptor[];
  /** "board" or a TabDescriptor key. */
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** The browser-style new-tab affordance, rendered after the last tab. */
  onNewThread: () => void;
}) {
  const selectedIndex =
    activeKey === "board" ? 0 : tabs.findIndex((t) => t.key === activeKey) + 1;

  // Index-addressed API → key-addressed callbacks.
  const keys = useMemo(() => ["board", ...tabs.map((t) => t.key)], [tabs]);

  // Browser grammar: the new-tab affordance rides immediately after the last
  // tab (not pinned to the far edge), so it stays where the eye left off as
  // tabs open and close. `min-w-0` on the strip lets it scroll; the + never
  // shrinks.
  return (
    <div className="flex min-w-0 items-center gap-1">
      <TabsSubtle
        activeLabel
        idPrefix="elan-tabs"
        selectedIndex={selectedIndex < 0 ? 0 : selectedIndex}
        onSelect={(i) => onSelect(keys[i] ?? "board")}
        className="min-w-0"
      >
        <TabsSubtleItem index={0} icon={IconInbox} label={boardLabel} />
        {tabs.map((t, i) => (
          <TabsSubtleItem
            key={t.key}
            index={i + 1}
            icon={threadIcon(t.running)}
            label={t.title || "New thread"}
            title={t.title || "New thread"}
            onClose={() => onClose(t.key)}
          />
        ))}
      </TabsSubtle>
      <button
        onClick={onNewThread}
        aria-label="New thread"
        title="New thread"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-[background-color,color,transform]",
          "duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:bg-hover hover:text-foreground active:scale-[0.96]",
        )}
      >
        <IconPlus size={15} />
      </button>
    </div>
  );
}
