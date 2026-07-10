// Mention pre-pass: turn validated @handles into `**@handle**` before the
// markdown render. Deliberately the simple/honest fallback from FRONTEND.md —
// mentions read as emphasized tokens, not roster-tinted spans (react-markdown
// offers no text-node override and Markdown.tsx's component map is fixed).
// Bodies are short; a handle inside a code span mis-bolding is an accepted
// v1 edge.

import type { RosterEntry } from "@/lib/board/types";

export function emphasizeMentions(body: string, roster: RosterEntry[]): string {
  const handles = new Set(roster.map((r) => r.handle));
  return body.replace(/@([a-z0-9][a-z0-9._-]*)/gi, (match, h: string) =>
    handles.has(h.toLowerCase()) ? `**${match}**` : match,
  );
}
