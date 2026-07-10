// Module-level singleton store + the React hook the UI reads it through.
// Mutations go straight through boardStore(); reads go through useBoard()
// (useSyncExternalStore keeps every subscriber in lockstep, no context).
//
// Store selection happens once, at module load: an Elan host present via
// build-time env or a URL param wins; otherwise it's the browser-only
// localStorage store (docs/ORCHESTRATION.md, "The UI picks its store at
// boot").

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChatItem } from "@/lib/agent/types";
import {
  bufferedSessionLines,
  createHostStore,
  hostBaseUrl,
  hostStatus,
  subscribeHostStatus,
  subscribeSessionLines,
  type HostStatus,
} from "./host-store";
import { createLocalStore, type BoardStore } from "./store";
import {
  createFold,
  foldSessionLines,
  parseSessionLog,
  type SessionLine,
  type TelemetryFold,
} from "./telemetry";
import type { AgentSessionRecord, BoardState, SessionState } from "./types";

const DEFAULT_HOST_URL = "http://127.0.0.1:4519";

// `VITE_ELAN_HOST` (build-time env) wins; else `?host=1` (default host URL)
// or `?host=http://…` (explicit URL); else no host — browser-only mode.
function resolveHostUrl(): string | null {
  const envHost = import.meta.env.VITE_ELAN_HOST;
  if (envHost) return envHost;
  if (typeof window === "undefined") return null;
  const param = new URLSearchParams(window.location.search).get("host");
  if (param == null) return null;
  return param === "1" || param === "" ? DEFAULT_HOST_URL : param;
}

const hostUrl = resolveHostUrl();

let singleton: BoardStore | null = null;

function getStore(): BoardStore {
  if (!singleton) singleton = hostUrl ? createHostStore(hostUrl) : createLocalStore();
  return singleton;
}

export function boardStore(): BoardStore {
  return getStore();
}

export function boardMode(): "local" | "host" {
  return hostUrl ? "host" : "local";
}

export function useBoard(): BoardState {
  const store = getStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

// Local mode has no host, hence no connection to report — null, not a fake
// "connected". Host mode reads host-store's module-level status (it isn't
// part of the BoardStore contract; only the host client tracks a socket).
const noopSubscribeHostStatus = () => () => {};
const nullHostStatus = () => null;

export function useHostStatus(): HostStatus | null {
  return useSyncExternalStore(
    hostUrl ? subscribeHostStatus : noopSubscribeHostStatus,
    hostUrl ? hostStatus : nullHostStatus,
  );
}

// ── Session telemetry ─────────────────────────────────────────────────────
// One hook per mounted session block (docs/FRONTEND.md "Session telemetry").
// Live sessions fold the WS session-line stream incrementally (buffered
// prefix first, so a block expanded mid-run isn't missing its head);
// completed sessions stay inert until `load()` — the lazy expand — fetches
// GET /api/sessions/:id/log and folds it once. Local mode has no host and
// therefore no telemetry: the hook returns null and the event lines stand
// alone.

const LIVE_SESSION_STATES: readonly SessionState[] = ["queued", "spawning", "running"];

export interface SessionTelemetry {
  items: ChatItem[];
  /** No stream translator for this harness — render `lines` as a raw tail. */
  raw: boolean;
  /** The captured log lines behind `items` (the raw fallback's source). */
  lines: SessionLine[];
  live: boolean;
  /** Telemetry is present (streaming, or the replay fetch landed). */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Completed sessions only: fetch + fold the on-disk log. Idempotent. */
  load: () => void;
}

function harnessFor(handle: string | undefined): string {
  if (!handle) return "";
  return getStore().getState().roster.find((r) => r.handle === handle)?.harness ?? "";
}

export function useSessionTelemetry(
  session: AgentSessionRecord | undefined,
): SessionTelemetry | null {
  const sessionId = session?.id;
  const handle = session?.handle;
  const live = session != null && LIVE_SESSION_STATES.includes(session.state);

  const [snap, setSnap] = useState<{
    items: ChatItem[];
    raw: boolean;
    lines: SessionLine[];
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The live fold survives the running→done transition so a block that
  // watched the whole run never refetches what it already has.
  const foldRef = useRef<{ fold: TelemetryFold; lines: SessionLine[] } | null>(null);

  useEffect(() => {
    if (!hostUrl || !sessionId || !live) return;
    const fold = createFold(harnessFor(handle));
    const lines: SessionLine[] = [];
    foldRef.current = { fold, lines };
    // Coalesce per-frame: a chatty harness must not schedule a render per line.
    let frame = 0;
    const flush = () => {
      frame = 0;
      const s = fold.snapshot();
      setSnap({ items: s.items, raw: s.raw, lines: [...lines] });
      setLoaded(true);
    };
    const push = (l: SessionLine) => {
      lines.push(l);
      fold.push(l);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    for (const l of bufferedSessionLines(sessionId)) push(l);
    const unsubscribe = subscribeSessionLines(sessionId, push);
    flush();
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sessionId, handle, live]);

  // Live → terminal while mounted: settle the fold in place (Mari invariant:
  // the run ends even when the CLI's terminal event never arrived).
  useEffect(() => {
    if (live || !foldRef.current) return;
    const { fold, lines } = foldRef.current;
    fold.finish();
    const s = fold.snapshot();
    setSnap({ items: s.items, raw: s.raw, lines });
  }, [live]);

  const load = useCallback(() => {
    if (!hostUrl || !sessionId || live || loaded || loading) return;
    const harness = harnessFor(handle);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const base = hostBaseUrl() ?? hostUrl;
        const res = await fetch(`${base}/api/sessions/${sessionId}/log`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const lines = parseSessionLog(await res.text());
        const folded = foldSessionLines(harness, lines);
        setSnap({ items: folded.items, raw: folded.raw, lines });
        setLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId, handle, live, loaded, loading]);

  if (!hostUrl || !session) return null;
  return {
    items: snap?.items ?? [],
    raw: snap?.raw ?? false,
    lines: snap?.lines ?? [],
    live,
    loaded,
    loading,
    error,
    load,
  };
}
