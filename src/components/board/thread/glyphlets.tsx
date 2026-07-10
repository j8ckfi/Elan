// Tiny inline SVGs the thread view shares — flag, chevron, paperclip, clock.
// Kept out of board/glyphs.tsx: these are thread-view furniture, not the
// Linear glyph vocabulary.

import { cn } from "@/lib/utils";

interface GlyphProps {
  size?: number;
  className?: string;
}

/** ⚑ — marks resolution posts and the resolve composer mode. */
export function FlagGlyph({ size = 12, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className={cn("shrink-0", className)} aria-hidden>
      <path d="M3 1.5 V 11" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
      <path d="M3 1.8 H 9.6 L 7.8 4.1 L 9.6 6.4 H 3 Z" fill="currentColor" />
    </svg>
  );
}

/** ▸ — exchange collapse toggle; rotates 90° when open. */
export function ChevronGlyph({ size = 12, className, open }: GlyphProps & { open?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className={cn("shrink-0 transition-transform duration-150", open && "rotate-90", className)}
      aria-hidden
    >
      <path
        d="M4.5 2.5 L 8.5 6 L 4.5 9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Attachment chip marker. */
export function PaperclipGlyph({ size = 11, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className={cn("shrink-0", className)} aria-hidden>
      <path
        d="M10 5.4 L 6.1 9.3 a 2.4 2.4 0 0 1 -3.4 -3.4 L 6.9 1.7 a 1.6 1.6 0 0 1 2.3 2.3 L 5.1 8.1 a 0.8 0.8 0 0 1 -1.2 -1.2 L 7.6 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Hollow clock — the Waiting session-state chip. Never a pulsing dot. */
export function ClockGlyph({ size = 11, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className={cn("shrink-0", className)} aria-hidden>
      <circle cx={6} cy={6} r={4.6} fill="none" stroke="currentColor" strokeWidth={1.1} />
      <path
        d="M6 3.6 V 6 L 7.8 7.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
