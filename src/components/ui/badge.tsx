"use client";

import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { useShape } from "@/lib/shape-context";

const badgeColors = {
  gray: "oklch(0.715 0 0)",
  red: "oklch(0.637 0.208 25.331)",
  orange: "oklch(0.705 0.187 47.604)",
  amber: "oklch(0.769 0.165 70.080)",
  yellow: "oklch(0.795 0.162 86.047)",
  lime: "oklch(0.768 0.204 130.850)",
  green: "oklch(0.723 0.192 149.579)",
  emerald: "oklch(0.696 0.149 162.480)",
  teal: "oklch(0.704 0.123 182.503)",
  cyan: "oklch(0.715 0.126 215.221)",
  blue: "oklch(0.623 0.188 259.815)",
  indigo: "oklch(0.585 0.204 277.117)",
  violet: "oklch(0.606 0.219 292.717)",
  purple: "oklch(0.627 0.233 303.900)",
  fuchsia: "oklch(0.667 0.259 322.150)",
  pink: "oklch(0.656 0.212 354.308)",
  rose: "oklch(0.645 0.215 16.439)",
} as const;

type BadgeColor = keyof typeof badgeColors;

const badgeVariants = cva(
  "inline-flex items-center font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        solid: "",
        dot: "border border-border text-foreground",
      },
      size: {
        sm: "h-5 px-2 text-[11px] gap-1",
        md: "h-6 px-2.5 text-[12px] gap-1.5",
        lg: "h-7 px-3 text-[13px] gap-1.5",
      },
    },
    defaultVariants: {
      variant: "solid",
      size: "md",
    },
  }
);

interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof badgeVariants> {
  color?: BadgeColor;
}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      className,
      variant = "solid",
      size = "md",
      color = "gray",
      children,
      style,
      ...props
    },
    ref
  ) => {
    const shape = useShape();
    const colorValue = badgeColors[color];
    const isSolid = variant === "solid";
    const dotSize = size === "sm" ? 6 : size === "lg" ? 8 : 7;

    const colorStyle = isSolid
      ? color === "gray"
        ? { backgroundColor: "var(--accent)", color: "var(--foreground)" }
        : {
            color: "var(--foreground)",
            backgroundColor: `color-mix(in srgb, ${colorValue} 15%, var(--background))`,
          }
      : {};

    const dotColor = color === "gray" ? "var(--muted-foreground)" : colorValue;

    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant, size }), shape.item, className)}
        style={{ ...colorStyle, ...style }}
        {...props}
      >
        {!isSolid && (
          <span
            className="shrink-0 rounded-full"
            style={{
              width: dotSize,
              height: dotSize,
              backgroundColor: dotColor,
            }}
          />
        )}
        {/* text-box needs a block container — the badge root is a flex
            container, so the label gets its own span. Height is fixed (h-*),
            so trimming only recenters the letterforms. */}
        <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
      </span>
    );
  }
);

Badge.displayName = "Badge";

export { Badge, badgeVariants, badgeColors };
export type { BadgeProps, BadgeColor };
