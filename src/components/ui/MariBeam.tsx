// Seam over border-beam. Centralizes the model → beam color mapping so call
// sites just pass the active model. Used to wrap the composer while the agent
// is working (size="line", the bottom traveling glow, in the agent's color).

import { BorderBeam } from "border-beam";
import type { ReactNode } from "react";
import { modelColor } from "@/lib/pi/modelColor";
import type { Model } from "@/lib/pi/types";

interface MariBeamProps {
  model: Model | null | undefined;
  active: boolean;
  children: ReactNode;
  size?: "sm" | "md" | "line" | "pulse-outside" | "pulse-inner";
  className?: string;
}

export function MariBeam({
  model,
  active,
  children,
  size = "line",
  className,
}: MariBeamProps) {
  const color = modelColor(model);
  return (
    <BorderBeam
      size={size}
      active={active}
      strength={1}
      colorVariant={color.colorVariant}
      theme="dark"
      className={className}
    >
      {children}
    </BorderBeam>
  );
}
