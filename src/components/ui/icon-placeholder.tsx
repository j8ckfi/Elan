// Shim for shadcn's registry `IconPlaceholder` helper. The base-nova components
// render icons via <IconPlaceholder tabler="IconX" lucide="XIcon" … />; Mari is
// a Tabler-icon app, so we resolve the `tabler` prop against a small explicit
// map (kept tight so we never pull the whole icon set into the bundle).

import {
  IconLayoutSidebar,
  IconX,
  type IconProps,
  type Icon,
} from "@tabler/icons-react";

const TABLER: Record<string, Icon> = {
  IconLayoutSidebar,
  IconX,
};

export interface IconPlaceholderProps extends IconProps {
  /** Tabler export name — the one Mari resolves. */
  tabler?: string;
  /** Ignored (other libraries' names), kept for drop-in registry compatibility. */
  lucide?: string;
  hugeicons?: string;
  phosphor?: string;
  remixicon?: string;
}

export function IconPlaceholder({
  tabler,
  lucide: _l,
  hugeicons: _h,
  phosphor: _p,
  remixicon: _r,
  ...props
}: IconPlaceholderProps) {
  const Cmp = tabler ? TABLER[tabler] : undefined;
  if (!Cmp) return null;
  return <Cmp {...props} />;
}
