// One agent session engine: owns a single CLI process (via a per-key
// transport), streams its lines through the adapter into the reducer, tracks
// model/identity/stats, and exposes the per-session actions the UI needs. The
// SessionManager (App.tsx) mounts one of these per open session — background
// engines keep reducing while off screen, so their agents keep running when
// you navigate away.
//
// Backend-agnostic: everything protocol-shaped goes through the AgentAdapter
// (src/lib/adapters/); everything host-shaped goes through the Transport
// (Tauri IPC on desktop, WebSocket bridge in the browser, or an
// adapter-supplied override).

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createHostTransport, type ConnState } from "@/lib/agent/transport";
import {
  filesToImageAttachments,
  initialState,
  reduce,
} from "@/lib/agent/reducer";
import { useSettings, parsePathDirs } from "@/lib/settings";
import type {
  AgentAdapter,
  AgentEvent,
  Model,
  QuestionAnswer,
  SessionIdentity,
  SessionStats,
  ThinkingLevel,
} from "@/lib/agent/types";

export type ConnectionStatus = ConnState;

interface MetaState {
  model: Model | null;
  availableModels: Model[];
  thinkingLevel: ThinkingLevel | null;
  identity: SessionIdentity;
  stats: SessionStats | null;
}

export interface AgentSessionSpec {
  /** The backend to drive (from src/config.ts). */
  adapter: AgentAdapter;
  /** Stable process key — one CLI child per key for this engine's whole life. */
  procKey: string;
  /** Working directory to root a fresh session in. */
  cwd?: string;
  /** Existing session file to boot into; omit for a new chat. */
  sessionPath?: string;
  /** Display name for a freshly-created session. */
  name?: string;
  /** Called after activity that touches the on-disk store (run end, rename)
   *  so the manager can refresh the global session list / recency. */
  onActivity?: () => void;
}

export type AgentSession = ReturnType<typeof useAgentSession>;

export function useAgentSession(spec: AgentSessionSpec) {
  const { adapter, procKey, cwd, sessionPath, name, onActivity } = spec;
  const [state, dispatch] = useReducer(reduce, initialState);
  const [meta, setMeta] = useState<MetaState>({
    model: null,
    availableModels: [],
    thinkingLevel: null,
    identity: { cwd },
    stats: null,
  });
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const stateRef = useRef(state);
  stateRef.current = state;

  // One transport bound to this engine's process key, stable for its lifetime.
  const transport = useMemo(
    () => adapter.createTransport?.(procKey) ?? createHostTransport(procKey),
    [adapter, procKey],
  );
  // Keep the latest onActivity without re-subscribing the event stream.
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  // Settings feed session defaults (model/thinking) and the runtime override.
  // Read through a ref so a settings change never restarts a live session — the
  // values are captured at start/restart time, applying only to future spawns.
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const buildSpawnSpec = useCallback(() => {
    const s = settingsRef.current;
    return adapter.spawn({
      cwd,
      sessionPath,
      name,
      model: s.defaultModel || adapter.defaultModel,
      binPath: s.piBinPath || undefined,
      pathDirs: parsePathDirs(s.extraPathDirs),
    });
  }, [adapter, cwd, sessionPath, name]);

  // Fold one batch of adapter events: transcript events go to the reducer,
  // meta patches merge into engine state, activity nudges the session manager.
  const applyEvents = useCallback((events: AgentEvent[]) => {
    for (const ev of events) {
      switch (ev.kind) {
        case "meta":
          setMeta((prev) => ({
            model: ev.model !== undefined ? ev.model : prev.model,
            availableModels: ev.availableModels ?? prev.availableModels,
            thinkingLevel: ev.thinkingLevel ?? prev.thinkingLevel,
            identity: ev.identity
              ? { ...prev.identity, ...ev.identity }
              : prev.identity,
            stats: ev.stats !== undefined ? ev.stats : prev.stats,
          }));
          break;
        case "activity":
          onActivityRef.current?.();
          break;
        default:
          dispatch(ev);
          if (ev.kind === "run-start" || ev.kind === "run-end")
            onActivityRef.current?.();
      }
    }
  }, []);

  // The per-session translation state. Recreated with the transport; its ctx
  // writes to the transport and can push out-of-band events (timers, async).
  const session = useMemo(
    () =>
      adapter.createSession({
        send: (line) => void transport.send(line),
        emit: (events) => applyEvents(events),
      }),
    [adapter, transport, applyEvents],
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const offLine = transport.onLine((line) =>
      applyEvents(sessionRef.current.handleLine(line)),
    );
    const offState = transport.onState((s) => {
      setConnection(s);
      if (s === "connected") {
        sessionRef.current.onConnected({
          resumed: Boolean(sessionPath),
          defaultThinkingLevel: settingsRef.current.defaultThinking || undefined,
        });
      }
    });
    void transport
      .start(buildSpawnSpec())
      .catch(() => setConnection("disconnected"));
    return () => {
      offLine();
      offState();
      void transport.stop();
    };
    // transport is stable (keyed useMemo); the rest are stable callbacks/refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, applyEvents]);

  // ── actions ────────────────────────────────────────────────────────────────
  const sendPrompt = useCallback(
    async (text: string, files: File[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && files.length === 0) return;
      const attachments =
        files.length > 0 ? await filesToImageAttachments(files) : undefined;
      dispatch({
        type: "@user",
        text: trimmed,
        images: files.length || undefined,
      });
      sessionRef.current.prompt(trimmed, attachments, {
        streaming: stateRef.current.streaming,
      });
    },
    [],
  );

  const abort = useCallback(() => sessionRef.current.abort(), []);

  const answer = useCallback((id: string, response: QuestionAnswer) => {
    sessionRef.current.respond?.(id, response);
    dispatch({ type: "@resolveQuestion", id });
  }, []);

  const setModelById = useCallback((provider: string, modelId: string) => {
    sessionRef.current.setModel?.(provider, modelId);
  }, []);

  const setThinking = useCallback((level: ThinkingLevel) => {
    setMeta((prev) => ({ ...prev, thinkingLevel: level })); // optimistic
    sessionRef.current.setThinkingLevel?.(level);
  }, []);

  const forkSession = useCallback(
    (entryId: string) => sessionRef.current.fork?.(entryId),
    [],
  );

  const renameSession = useCallback(
    (newName: string) => sessionRef.current.rename?.(newName),
    [],
  );

  const restart = useCallback(async () => {
    setConnection("connecting");
    await transport
      .start(buildSpawnSpec())
      .catch(() => setConnection("disconnected"));
  }, [transport, buildSpawnSpec]);

  return {
    procKey,
    adapter,
    capabilities: adapter.capabilities,
    items: state.items,
    streaming: state.streaming,
    queue: state.queue,
    model: meta.model,
    availableModels: meta.availableModels,
    thinkingLevel: meta.thinkingLevel,
    connection,
    identity: meta.identity,
    stats: meta.stats,
    sendPrompt,
    abort,
    answer,
    setModelById,
    setThinking,
    forkSession,
    renameSession,
    restart,
  };
}
