// Transport abstraction so the same React app can drive Pi two ways:
//   • Desktop  → Tauri IPC (invoke "pi_send", listen "pi://event")
//   • Browser  → WebSocket bridge (dev/pi-bridge.ts), for fast iteration in
//                Claude Preview / any browser without the Tauri shell.
//
// Mari runs ONE Pi process per open session so background agents keep streaming
// when you navigate away. A transport is therefore bound to a session `key`:
//   • Tauri  → all children share the pi://event stream; a module-level hub
//              demuxes the `{key, line}` envelopes to the right transport, and
//              every command carries its key to pi_send/pi_start/pi_stop.
//   • Browser → one WebSocket per session (the bridge already spawns one pi per
//               socket), so the key never needs to travel on the wire.

import type { PiCommand, PiEvent } from "./types";
import type { SessionSummary } from "./sessions";

export interface StartOptions {
  cwd?: string;
  model?: string;
  name?: string;
  /** Existing session file/id to boot into (`--session`); omit for a fresh one. */
  session?: string;
  /** Explicit path to the `pi` binary (Tauri only; overrides auto-resolution). */
  piBin?: string;
  /** Extra dirs prepended to the spawned pi's PATH (Tauri only). */
  pathDirs?: string[];
}

export type ConnState = "connecting" | "connected" | "disconnected";

export interface PiTransport {
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  send(command: PiCommand): Promise<void>;
  onEvent(cb: (ev: PiEvent) => void): () => void;
  onState(cb: (state: ConnState) => void): () => void;
}

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

// ── Tauri event hub ──────────────────────────────────────────────────────────
// Every child's stdout arrives on the single `pi://event` channel as a
// `{key, line}` envelope. We attach the Tauri listeners ONCE and fan each event
// out to the transport registered for that key. started/exit carry the bare key.
interface KeyHandler {
  onEvent: (ev: PiEvent) => void;
  onStarted: () => void;
  onExit: () => void;
}
const tauriHandlers = new Map<string, KeyHandler>();
let hubReady: Promise<void> | null = null;

function ensureHub(): Promise<void> {
  if (!hubReady) hubReady = attachHub();
  return hubReady;
}

async function attachHub(): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("pi://event", (e) => {
    let env: { key?: string; line?: string };
    try {
      env = JSON.parse(e.payload);
    } catch {
      return; // strict framing — ignore non-JSON envelopes
    }
    if (!env.key || env.line == null) return;
    const h = tauriHandlers.get(env.key);
    if (!h) return;
    try {
      h.onEvent(JSON.parse(env.line) as PiEvent);
    } catch {
      /* ignore non-JSON pi line */
    }
  });
  await listen<string>("pi://started", (e) =>
    tauriHandlers.get(e.payload)?.onStarted(),
  );
  await listen<string>("pi://exit", (e) =>
    tauriHandlers.get(e.payload)?.onExit(),
  );
  await listen<string>("pi://stderr", (e) => {
    try {
      const env = JSON.parse(e.payload) as { key?: string; line?: string };
      console.debug("[pi:stderr]", env.key, env.line);
    } catch {
      /* ignore */
    }
  });
}

// ── Tauri transport (one per session key) ────────────────────────────────────
class TauriTransport implements PiTransport {
  private eventCbs = new Set<(ev: PiEvent) => void>();
  private stateCbs = new Set<(s: ConnState) => void>();

  constructor(private readonly key: string) {}

  private emitState(s: ConnState) {
    this.stateCbs.forEach((cb) => cb(s));
  }

  async start(options?: StartOptions) {
    await ensureHub(); // listeners live before we spawn (catch started + events)
    tauriHandlers.set(this.key, {
      onEvent: (ev) => this.eventCbs.forEach((cb) => cb(ev)),
      onStarted: () => this.emitState("connected"),
      onExit: () => this.emitState("disconnected"),
    });
    const { invoke } = await import("@tauri-apps/api/core");
    this.emitState("connecting");
    await invoke("pi_start", { key: this.key, options: options ?? {} });
  }

  async stop() {
    tauriHandlers.delete(this.key);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_stop", { key: this.key });
  }

  async send(command: PiCommand) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_send", { key: this.key, line: JSON.stringify(command) });
  }

  onEvent(cb: (ev: PiEvent) => void) {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onState(cb: (s: ConnState) => void) {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
}

// ── WebSocket transport (dev bridge, one socket per session) ─────────────────
const BRIDGE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_PI_BRIDGE_URL ??
  "ws://localhost:4317";

class WebSocketTransport implements PiTransport {
  private ws: WebSocket | null = null;
  private eventCbs = new Set<(ev: PiEvent) => void>();
  private stateCbs = new Set<(s: ConnState) => void>();
  private queue: string[] = [];

  // The key is unused on the wire — each socket owns its own pi in the bridge.
  constructor(_key: string) {}

  private emitState(s: ConnState) {
    this.stateCbs.forEach((cb) => cb(s));
  }

  async start(options?: StartOptions) {
    this.stop();
    this.emitState("connecting");
    const params = new URLSearchParams();
    if (options?.model) params.set("model", options.model);
    if (options?.cwd) params.set("cwd", options.cwd);
    if (options?.name) params.set("name", options.name);
    if (options?.session) params.set("session", options.session);
    const url = params.toString()
      ? `${BRIDGE_URL}?${params.toString()}`
      : BRIDGE_URL;

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.emitState("connected");
      for (const line of this.queue) ws.send(line);
      this.queue = [];
    };
    ws.onclose = () => this.emitState("disconnected");
    ws.onerror = () => this.emitState("disconnected");
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as PiEvent;
        this.eventCbs.forEach((cb) => cb(ev));
      } catch {
        /* ignore */
      }
    };
  }

  async stop() {
    this.ws?.close();
    this.ws = null;
  }

  async send(command: PiCommand) {
    const line = JSON.stringify(command);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line);
    else this.queue.push(line);
  }

  onEvent(cb: (ev: PiEvent) => void) {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onState(cb: (s: ConnState) => void) {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
}

/** Create a transport bound to one session/process key. */
export function createPiTransport(key: string): PiTransport {
  return isTauri() ? new TauriTransport(key) : new WebSocketTransport(key);
}

/**
 * Subscribe to session-store changes so the sidebar can re-list immediately.
 * Desktop: a real filesystem watcher (`pi://sessions-changed`) that fires for
 * ANY change, including sessions written by a terminal `pi`. Browser dev: a
 * light poll, since the bridge has no watcher. Returns an unsubscribe fn.
 */
export function onSessionsChanged(cb: () => void): () => void {
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
export async function deleteSession(path: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_delete_session", { path });
    return;
  }
  const httpBase = BRIDGE_URL.replace(/^ws/, "http");
  await fetch(`${httpBase}/delete?path=${encodeURIComponent(path)}`, {
    method: "POST",
  });
}

/**
 * Rename a saved session on disk (appends a session_info line). Only for
 * sessions with no live process — the app renames open ones over RPC instead.
 */
export async function renameSessionOnDisk(
  path: string,
  name: string,
): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_rename_session", { path, name });
    return;
  }
  const httpBase = BRIDGE_URL.replace(/^ws/, "http");
  await fetch(
    `${httpBase}/rename?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
    { method: "POST" },
  );
}

/** List saved sessions on disk (out-of-band from any RPC stream). */
export async function listSessions(cwd?: string): Promise<SessionSummary[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<SessionSummary[]>("pi_list_sessions", { cwd });
  }
  const httpBase = BRIDGE_URL.replace(/^ws/, "http");
  const url = new URL(`${httpBase}/sessions`);
  if (cwd) url.searchParams.set("cwd", cwd);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`listSessions failed: ${res.status}`);
  return (await res.json()) as SessionSummary[];
}
