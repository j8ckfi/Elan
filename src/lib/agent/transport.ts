// Process transports — how JSONL lines move between the webview and a spawned
// agent CLI. Two hosts, one interface:
//   • Desktop  → Tauri IPC: the Rust core (src-tauri/src/pi.rs) owns the child;
//                commands via invoke("pi_send"), events on `pi://event`.
//   • Browser  → WebSocket dev bridge (dev/pi-bridge.ts): one socket per
//                session, each spawning its own child. Fast UI iteration in
//                Claude Preview / any browser with no Rust rebuild.
//
// Mari runs ONE process per open session so background agents keep streaming
// when you navigate away. A transport is therefore bound to a session `key`:
//   • Tauri  → all children share the pi://event stream; a module-level hub
//              demuxes the `{key, line}` envelopes to the right transport, and
//              every command carries its key to pi_send/pi_start/pi_stop.
//   • Browser → one WebSocket per session, so the key never travels on the wire.
//
// Transports are protocol-blind: they ship raw JSON values both ways. The
// adapter layer (src/lib/adapters/) gives the lines meaning. Hosts inject one
// synthetic line, `{type:"cwd", cwd}` — the resolved working directory the
// child was spawned in (adapters fold it into session identity).

import type { SpawnSpec } from "./types";

export type ConnState = "connecting" | "connected" | "disconnected";

export interface Transport {
  start(spec: SpawnSpec): Promise<void>;
  stop(): Promise<void>;
  /** Write one command object to the child's stdin as a single JSON line. */
  send(line: unknown): Promise<void>;
  /** Parsed JSON lines from the child's stdout. Returns an unsubscribe fn. */
  onLine(cb: (line: unknown) => void): () => void;
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
  onLine: (line: unknown) => void;
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
      h.onLine(JSON.parse(env.line));
    } catch {
      /* ignore non-JSON child line */
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
      console.debug("[agent:stderr]", env.key, env.line);
    } catch {
      /* ignore */
    }
  });
}

// ── Tauri transport (one per session key) ────────────────────────────────────
class TauriTransport implements Transport {
  private lineCbs = new Set<(line: unknown) => void>();
  private stateCbs = new Set<(s: ConnState) => void>();

  constructor(private readonly key: string) {}

  private emitState(s: ConnState) {
    this.stateCbs.forEach((cb) => cb(s));
  }

  async start(spec: SpawnSpec) {
    await ensureHub(); // listeners live before we spawn (catch started + events)
    tauriHandlers.set(this.key, {
      onLine: (line) => this.lineCbs.forEach((cb) => cb(line)),
      onStarted: () => this.emitState("connected"),
      onExit: () => this.emitState("disconnected"),
    });
    const { invoke } = await import("@tauri-apps/api/core");
    this.emitState("connecting");
    await invoke("pi_start", { key: this.key, spec });
  }

  async stop() {
    tauriHandlers.delete(this.key);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_stop", { key: this.key });
  }

  async send(line: unknown) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_send", { key: this.key, line: JSON.stringify(line) });
  }

  onLine(cb: (line: unknown) => void) {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }

  onState(cb: (s: ConnState) => void) {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
}

// ── WebSocket transport (dev bridge, one socket per session) ─────────────────
export const BRIDGE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_PI_BRIDGE_URL ??
  "ws://localhost:4317";

/** The bridge's HTTP base (session-store endpoints live beside the WS). */
export function bridgeHttpBase(): string {
  return BRIDGE_URL.replace(/^ws/, "http");
}

class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private lineCbs = new Set<(line: unknown) => void>();
  private stateCbs = new Set<(s: ConnState) => void>();
  private queue: string[] = [];

  // The key is unused on the wire — each socket owns its own child in the bridge.
  constructor(_key: string) {}

  private emitState(s: ConnState) {
    this.stateCbs.forEach((cb) => cb(s));
  }

  async start(spec: SpawnSpec) {
    this.stop();
    this.emitState("connecting");
    const params = new URLSearchParams();
    params.set("spec", JSON.stringify(spec));
    const url = `${BRIDGE_URL}?${params.toString()}`;

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
        const line: unknown = JSON.parse(e.data as string);
        this.lineCbs.forEach((cb) => cb(line));
      } catch {
        /* ignore */
      }
    };
  }

  async stop() {
    this.ws?.close();
    this.ws = null;
  }

  async send(line: unknown) {
    const s = JSON.stringify(line);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  onLine(cb: (line: unknown) => void) {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }

  onState(cb: (s: ConnState) => void) {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }
}

/** The default host transport for one session/process key: Tauri IPC on
 *  desktop, the WS dev bridge in the browser. Adapters can override via
 *  `AgentAdapter.createTransport` (the mock adapter runs fully in-memory). */
export function createHostTransport(key: string): Transport {
  return isTauri() ? new TauriTransport(key) : new WebSocketTransport(key);
}
