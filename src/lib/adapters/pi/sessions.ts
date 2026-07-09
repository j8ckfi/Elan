// Pi's SessionStore — powers the sidebar from the on-disk session store.
//
// Pi has no cross-session "list" RPC, so listing reads the store directly:
//   • Desktop  → Rust commands (pi_list_sessions / pi_delete_session /
//                pi_rename_session) + a real filesystem watcher
//                (`pi://sessions-changed`) that fires for ANY change, including
//                sessions written by a terminal `pi`.
//   • Browser  → the dev bridge's HTTP endpoints + a light poll (no watcher).

import type { SessionStore, SessionSummary } from "@/lib/agent/types";
import { bridgeHttpBase, isTauri } from "@/lib/agent/transport";

async function list(cwd?: string): Promise<SessionSummary[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<SessionSummary[]>("pi_list_sessions", { cwd });
  }
  const url = new URL(`${bridgeHttpBase()}/sessions`);
  if (cwd) url.searchParams.set("cwd", cwd);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`listSessions failed: ${res.status}`);
  return (await res.json()) as SessionSummary[];
}

function watch(cb: () => void): () => void {
  if (isTauri()) {
    let un: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen("pi://sessions-changed", () => cb()).then((u) => {
        if (cancelled) u();
        else un = u;
      }),
    );
    return () => {
      cancelled = true;
      un?.();
    };
  }
  const id = setInterval(cb, 2500);
  return () => clearInterval(id);
}

/** Permanently delete a saved session file (disk op, no RPC process needed). */
async function deleteSession(path: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_delete_session", { path });
    return;
  }
  await fetch(`${bridgeHttpBase()}/delete?path=${encodeURIComponent(path)}`, {
    method: "POST",
  });
}

/**
 * Rename a saved session on disk (appends a session_info line). Only for
 * sessions with no live process — the app renames open ones over RPC instead.
 */
async function rename(path: string, name: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_rename_session", { path, name });
    return;
  }
  await fetch(
    `${bridgeHttpBase()}/rename?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
    { method: "POST" },
  );
}

export const piSessionStore: SessionStore = {
  list,
  watch,
  delete: deleteSession,
  rename,
};
