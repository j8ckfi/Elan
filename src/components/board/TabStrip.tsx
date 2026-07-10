// The content pane's tab row: one persistent board tab (follows the sidebar
// selection) + one closable tab per open thread. Built on FF's TabsSubtle in
// activeLabel mode — unselected tabs collapse to their status glyph, which
// doubles as the working indicator (gradient-spin while a session runs).

import { useMemo } from "react";
import { IconInbox } from "@tabler/icons-react";
import { GradientSpin } from "gradient-spin";
import { TabsSubtle, TabsSubtleItem } from "@/components/ui/tabs-subtle";
import type { IconComponentProps } from "@/lib/icon-map";
import { StatusGlyph } from "./glyphs";
import type { ThreadStatus } from "@/lib/board/types";

export interface TabDescriptor {
  key: string;
  title: string;
  /** null = uncreated draft; renders as todo. */
  status: ThreadStatus | null;
  running: boolean;
}

// Stable per-(status, running) icon components — TabsSubtleItem measures its
// children, so identity churn would remount SVGs every render for nothing.
const threadIconCache = new Map<string, React.ComponentType<IconComponentProps>>();
function threadIcon(status: ThreadStatus | null, running: boolean) {
  const k = `${status ?? "draft"}:${running}`;
  let Icon = threadIconCache.get(k);
  if (!Icon) {
    Icon = function ThreadTabIcon({ className }: IconComponentProps) {
      if (running)
        return (
          <GradientSpin
            cellSize={3}
            cellGap={1.5}
            label="Working"
            className={className}
          />
        );
      return <StatusGlyph status={status ?? "todo"} size={14} className={className} />;
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
}: {
  boardLabel: string;
  tabs: TabDescriptor[];
  /** "board" or a TabDescriptor key. */
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const selectedIndex =
    activeKey === "board" ? 0 : tabs.findIndex((t) => t.key === activeKey) + 1;

  // Index-addressed API → key-addressed callbacks.
  const keys = useMemo(() => ["board", ...tabs.map((t) => t.key)], [tabs]);

  return (
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
          icon={threadIcon(t.status, t.running)}
          label={t.title || "New thread"}
          title={t.title || "New thread"}
          onClose={() => onClose(t.key)}
        />
      ))}
    </TabsSubtle>
  );
}
