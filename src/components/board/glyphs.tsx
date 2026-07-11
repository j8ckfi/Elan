// The board's glyph vocabulary — agent avatars. Inline SVG only, no
// icon-library substitutes (harness brand marks are generated into
// harness-icons.ts — see AgentAvatar below). Everything renders in the
// system color: the app chrome is monochrome; the only gradient in the
// product is the tab bar's working grid (TabStrip). See docs/FRONTEND.md
// "Glyph vocabulary".

import { cn } from "@/lib/utils";
import type { Author, RosterEntry } from "@/lib/board/types";
import { USER } from "@/lib/board/types";
import { HARNESS_ICONS } from "./harness-icons";

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

/** The user's mark — a bare person silhouette in the system color, same
 *  register as the harness marks (the user has no brand to borrow either). */
function UserGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx={12} cy={8} r={4} fill="currentColor" />
      <path d="M4 20.5 C4 15.8 7.6 13.5 12 13.5 S20 15.8 20 20.5 Z" fill="currentColor" />
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
    return (
      <div
        className={cn(
          "inline-flex shrink-0 items-center justify-center text-foreground",
          className,
        )}
        style={{ width: size, height: size, ...style }}
        title="You"
        aria-label="You"
      >
        <UserGlyph size={size * 0.85} />
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

  // Unknown harness → initials-circle fallback, monochrome like the marks.
  const initials = entry ? initialsFor(entry.handle) : "?";

  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-accent text-foreground",
        className,
      )}
      style={{
        width: size,
        height: size,
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

export { AgentAvatar, AvatarStack };
