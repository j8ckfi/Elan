// Linear's glyph vocabulary — status circles, agent avatars. Inline SVG
// only, no icon-library substitutes (harness brand marks are generated into
// harness-icons.ts — see AgentAvatar below). See docs/FRONTEND.md "Glyph
// vocabulary" for the exact spec these components implement.

import { GradientAvatar } from "@outpacelabs/avatars";
import { cn } from "@/lib/utils";
import type { Author, RosterEntry, ThreadStatus } from "@/lib/board/types";
import { USER } from "@/lib/board/types";
import { HARNESS_ICONS } from "./harness-icons";

// ── Colors ───────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<ThreadStatus, string> = {
  todo: "var(--muted-foreground)",
  in_progress: "#f2994a",
  in_review: "#4cb782",
  done: "#5e6ad2",
  canceled: "var(--muted-foreground)",
};

// ── Status ───────────────────────────────────────────────────────────────

export const STATUS_META: Record<ThreadStatus, { label: string; color: string }> = {
  todo: { label: "Todo", color: STATUS_COLOR.todo },
  in_progress: { label: "In Progress", color: STATUS_COLOR.in_progress },
  in_review: { label: "In Review", color: STATUS_COLOR.in_review },
  done: { label: "Done", color: STATUS_COLOR.done },
  canceled: { label: "Canceled", color: STATUS_COLOR.canceled },
};

// Center/radius of the 14-unit viewBox the ring + pie constructions share.
const CX = 7;
const CY = 7;
const RING_R = 5.5;
const PIE_R = RING_R - 3;

/** Point on a circle of radius r centered at (CX, CY), 0deg = 12 o'clock,
 *  sweeping clockwise — matches how the eye reads a "fill" pie. */
function pointOnCircle(r: number, fraction: number) {
  const angle = -Math.PI / 2 + fraction * Math.PI * 2;
  return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle) };
}

/** SVG path for a pie wedge covering `fraction` of the circle, starting at
 *  12 o'clock and sweeping clockwise. fraction === 1 draws a full disc. */
function pieWedgePath(r: number, fraction: number): string {
  if (fraction >= 1) {
    // Full circle as two arcs (a single arc can't close on itself).
    return `M ${CX} ${CY - r} A ${r} ${r} 0 1 1 ${CX - 0.001} ${CY - r} Z`;
  }
  const start = pointOnCircle(r, 0);
  const end = pointOnCircle(r, fraction);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${CX} ${CY} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

interface StatusGlyphProps {
  status: ThreadStatus;
  size?: number;
  className?: string;
}

function StatusGlyph({ status, size = 14, className }: StatusGlyphProps) {
  const color = STATUS_COLOR[status];

  if (status === "done" || status === "canceled") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        className={className}
        aria-hidden
      >
        <circle cx={CX} cy={CY} r={RING_R} fill={color} />
        {status === "done" ? (
          <path
            d="M 4.3 7.1 L 6.2 9 L 9.8 5"
            fill="none"
            stroke="var(--background)"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M 5 5 L 9 9 M 9 5 L 5 9"
            fill="none"
            stroke="var(--background)"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        )}
      </svg>
    );
  }

  const fraction = status === "in_progress" ? 0.5 : status === "in_review" ? 0.75 : 0;

  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={className} aria-hidden>
      <circle
        cx={CX}
        cy={CY}
        r={RING_R}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
      />
      {fraction > 0 && <path d={pieWedgePath(PIE_R, fraction)} fill={color} />}
    </svg>
  );
}

// ── Agent avatars ────────────────────────────────────────────────────────

// Harness brand marks live in harness-icons.ts (generated from LobeHub's
// mono icon set — the Claude spark, the OpenAI blossom, Grok's black hole).
// They render BARE, in the system color (text-foreground): no disc, no
// border, no tint. Harnesses without a mark fall through to the
// initials-circle fallback below.

/** mock's neutral "›_" terminal-prompt motif — no brand mark to borrow. */
function MockHarnessGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M5 7 L11 12 L5 17"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13 17 H19" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

/** "fable-5" -> "F5"; "gpt-5.6" -> "G5"; "grok-4.5" -> "G4". First character
 *  of each dash-separated segment, uppercased, max 2. */
function initialsFor(handle: string): string {
  const segments = handle.split("-").filter(Boolean);
  const initials = segments.map((s) => s[0]?.toUpperCase() ?? "").join("");
  return initials.slice(0, 2) || "?";
}

interface AgentAvatarProps {
  author: Author;
  roster: RosterEntry[];
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

function AgentAvatar({ author, roster, size = 18, className, style }: AgentAvatarProps) {
  if (author === USER) {
    // GradientAvatar has no title/aria-label passthrough (and defaults to a
    // full circle already, so no rounding/clip wrapper is needed) — a plain
    // sized wrapper carries those.
    return (
      <div
        className={cn("inline-flex shrink-0", className)}
        style={{ width: size, height: size, ...style }}
        title="You"
        aria-label="You"
      >
        <GradientAvatar seed="elan-user" size={size} />
      </div>
    );
  }

  const entry = roster.find((r) => r.handle === author);
  const title = entry?.handle ?? author;
  const icon = entry ? HARNESS_ICONS[entry.harness] : undefined;
  const isMock = entry?.harness === "mock";

  // Bare brand mark in the system color — dark on light, light on dark.
  if (icon || isMock) {
    return (
      <div
        className={cn(
          "inline-flex shrink-0 items-center justify-center text-foreground",
          className,
        )}
        style={{ width: size, height: size, ...style }}
        title={title}
        aria-label={title}
      >
        {isMock ? (
          <MockHarnessGlyph size={size * 0.85} />
        ) : (
          <svg
            width={size * 0.85}
            height={size * 0.85}
            viewBox={icon!.viewBox}
            fill="currentColor"
            fillRule="evenodd"
            aria-hidden
          >
            {icon!.paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </svg>
        )}
      </div>
    );
  }

  // Unknown harness → initials-circle fallback.
  const background = entry?.color ?? "var(--muted-foreground)";
  const initials = entry ? initialsFor(entry.handle) : "?";

  return (
    <div
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full text-white", className)}
      style={{
        width: size,
        height: size,
        backgroundColor: background,
        fontSize: size * 0.42,
        fontWeight: 600,
        lineHeight: 1,
        ...style,
      }}
      title={title}
      aria-label={title}
    >
      {initials}
    </div>
  );
}

interface AvatarStackProps {
  authors: Author[];
  roster: RosterEntry[];
  size?: number;
  max?: number;
  className?: string;
}

function AvatarStack({ authors, roster, size = 18, max = 3, className }: AvatarStackProps) {
  const shown = authors.slice(0, max);
  const overflow = authors.length - shown.length;

  // Bare marks don't overlap legibly the way discs do — a tight row instead.
  return (
    <div className={cn("inline-flex items-center gap-1", className)}>
      {shown.map((author, i) => (
        <AgentAvatar key={`${author}-${i}`} author={author} roster={roster} size={size} />
      ))}
      {overflow > 0 && (
        <div
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground"
          style={{
            width: size,
            height: size,
            fontSize: size * 0.38,
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

export { StatusGlyph, AgentAvatar, AvatarStack };
