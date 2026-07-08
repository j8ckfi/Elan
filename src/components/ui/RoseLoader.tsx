// A small self-drawing rose / spirograph loader — replaces the morphing
// infinity glyph in Fluid's ThinkingIndicator. Ported from the parametric
// "rose trail" curve in github.com/paidax01/math-curve-loaders:
//   x(t) = R·cos t − a·cos(k·t),  y(t) = R·sin t − a·sin(k·t)
// A faint full curve sits under a bright comet that traces it. currentColor
// throughout; static (no trace) under prefers-reduced-motion.

import { useMemo } from "react";

interface RoseLoaderProps {
  size?: number;
  /** Petal count k. 5 reads cleaner than 7 at small sizes. */
  petals?: number;
  className?: string;
}

function rosePath(petals: number): string {
  const R = 5.6; // base radius
  const a = 2.6; // detail amplitude
  const steps = 240;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = 12 + (R * Math.cos(t) - a * Math.cos(petals * t));
    const y = 12 + (R * Math.sin(t) - a * Math.sin(petals * t));
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return d.trim() + " Z";
}

export function RoseLoader({
  size = 20,
  petals = 5,
  className,
}: RoseLoaderProps) {
  const d = useMemo(() => rosePath(petals), [petals]);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="presentation"
      aria-hidden
      className={className}
    >
      {/* Faint full curve. */}
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.22}
      />
      {/* Bright comet tracing the curve. */}
      <path
        className="rose-loader-trace"
        d={d}
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        strokeDasharray="20 80"
      />
    </svg>
  );
}
