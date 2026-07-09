// Pi's on-disk session store format (~/.pi/agent/sessions/<encoded-cwd>/*.jsonl).
//
// This module is intentionally dependency-light (no `fs`, relative type import
// only) so it can be imported by BOTH the browser bundle (parser for the
// session store client) and the Bun dev bridge (which does the actual disk
// reads). The Rust core mirrors this parsing for the Tauri build — keep the
// three in sync.

import type { SessionSummary } from "../../agent/types";

/** Encode a cwd to its session-store directory name (mirrors pi's SessionManager). */
export function encodeCwdDir(cwd: string): string {
  const safe = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safe}--`;
}

function firstUserText(msg: unknown): string {
  const m = msg as { content?: unknown };
  const content = m?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

function collapse(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/**
 * Parse a single session file's contents into a summary. Returns null for files
 * with no valid header or no user turn (empty/aborted shells we don't list).
 */
export function parseSessionMeta(
  content: string,
  path: string,
  mtimeMs: number,
): SessionSummary | null {
  let id = "";
  let cwd = "";
  let createdAt = mtimeMs;
  let name: string | undefined;
  let title = "";
  let messages = 0;

  for (const raw of content.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (e.type) {
      case "session":
        id = String(e.id ?? "");
        cwd = String(e.cwd ?? "");
        if (typeof e.timestamp === "string") {
          const t = Date.parse(e.timestamp);
          if (!Number.isNaN(t)) createdAt = t;
        }
        break;
      case "session_info":
        // Latest one wins.
        if (typeof e.name === "string" && e.name.trim()) name = e.name.trim();
        break;
      case "message": {
        const msg = e.message as { role?: string } | undefined;
        if (msg?.role === "user" || msg?.role === "assistant") messages++;
        if (msg?.role === "user" && !title) title = collapse(firstUserText(msg));
        break;
      }
    }
  }

  if (!id) return null;
  if (!title && !name) return null; // empty shell — skip
  return {
    path,
    id,
    cwd,
    name,
    title: name ?? title ?? "Untitled",
    createdAt,
    updatedAt: mtimeMs,
    messages,
  };
}
