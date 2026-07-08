// One Pi session engine: owns a single `pi --mode rpc` process (via a per-key
// transport), streams its events into the reducer, tracks model/identity/stats,
// and exposes the per-session actions the UI needs. The SessionManager mounts
// one of these per open session — background engines keep reducing while off
// screen, so their agents keep running when you navigate away.
//
// Transport-agnostic (Tauri IPC on desktop, WebSocket bridge in the browser).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPiTransport, type ConnState } from "@/lib/pi/client";
import { initialState, reduce } from "@/lib/pi/reducer";
import type {
  AgentMessage,
  ImageContent,
  Model,
  PiEvent,
  RpcResponse,
  SessionStats,
  ThinkingLevel,
} from "@/lib/pi/types";

/** Identity of the currently-loaded session (from get_state). */
export interface SessionIdentity {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  /** Working directory of the active session — the "project" it belongs to. */
  cwd?: string;
}

export type ConnectionStatus = ConnState;

// Startup model. Overridable via VITE_PI_MODEL; defaults to a fast, available
// cursor model (the local Laguna default is often down).
const DEFAULT_MODEL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_PI_MODEL ??
  "openai-codex/gpt-5.5";

async function fileToImageContent(file: File): Promise<ImageContent> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return {
    type: "image",
    data: btoa(binary),
    mimeType: file.type || "application/octet-stream",
  };
}

export interface PiSessionSpec {
  /** Stable process key — one Pi child per key for this engine's whole life. */
  procKey: string;
  /** Working directory to root a fresh session in. */
  cwd?: string;
  /** Existing session file to boot into (`--session`); omit for a new chat. */
  sessionPath?: string;
  /** Display name for a freshly-created session (`--name`). */
  name?: string;
  /** Called after activity that touches the on-disk store (agent_end, rename)
   *  so the manager can refresh the global session list / recency. */
  onActivity?: () => void;
}

export type PiSession = ReturnType<typeof usePiSession>;

export function usePiSession(spec: PiSessionSpec) {
  const { procKey, cwd, sessionPath, name, onActivity } = spec;
  const [state, dispatch] = useReducer(reduce, initialState);
  const [model, setModel] = useState<Model | null>(null);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel | null>(
    null,
  );
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [identity, setIdentity] = useState<SessionIdentity>({ cwd });
  const [stats, setStats] = useState<SessionStats | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // One transport bound to this engine's process key, stable for its lifetime.
  const transport = useMemo(() => createPiTransport(procKey), [procKey]);
  // Keep the latest onActivity without re-subscribing the event stream.
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  const refreshStats = useCallback(() => {
    void transport.send({ type: "get_session_stats" });
  }, [transport]);

  const applyResponse = useCallback(
    (res: RpcResponse) => {
      if (!res.success) return;
      const data = res.data as Record<string, unknown> | undefined;
      switch (res.command) {
        case "get_state":
          if (data?.model) setModel(data.model as unknown as Model);
          if (data?.thinkingLevel)
            setThinkingLevelState(data.thinkingLevel as ThinkingLevel);
          // get_state omits cwd; keep whatever the transport reported (bridge
          // "cwd" event / prior state) so the breadcrumb path survives.
          setIdentity((prev) => ({
            sessionFile: data?.sessionFile as string | undefined,
            sessionId: data?.sessionId as string | undefined,
            sessionName: data?.sessionName as string | undefined,
            cwd: (data?.cwd as string | undefined) ?? prev.cwd,
          }));
          break;
        case "set_model":
          if (data) setModel(data as unknown as Model);
          break;
        case "cycle_model":
          if (data?.model) setModel(data.model as unknown as Model);
          break;
        case "get_available_models":
          if (Array.isArray(data?.models))
            setAvailableModels(data.models as unknown as Model[]);
          break;
        case "get_messages":
          if (Array.isArray(data?.messages))
            dispatch({
              type: "@hydrate",
              messages: data.messages as AgentMessage[],
            });
          break;
        case "get_session_stats":
          setStats((data ?? null) as SessionStats | null);
          break;
        case "set_session_name":
          void transport.send({ type: "get_state" });
          onActivityRef.current?.();
          break;
        case "fork":
          // A fork created a fresh session file → reload transcript + identity.
          if (!(data && data.cancelled)) {
            void transport.send({ type: "get_messages" });
            void transport.send({ type: "get_state" });
            refreshStats();
            onActivityRef.current?.();
          }
          break;
      }
    },
    [transport, refreshStats],
  );

  const handleEvent = useCallback(
    (ev: PiEvent) => {
      if (ev.type === "response") {
        applyResponse(ev);
        return;
      }
      // Synthetic transport event: the working directory pi was spawned in.
      if ((ev as { type?: string }).type === "cwd") {
        const evCwd = (ev as { cwd?: string }).cwd;
        if (evCwd) setIdentity((prev) => ({ ...prev, cwd: evCwd }));
        return;
      }
      dispatch(ev);
      // A fresh run creates/writes the session file → nudge the sidebar so a
      // brand-new chat appears the moment it starts (the fs watcher also covers
      // this, but this makes the common case instant).
      if (ev.type === "agent_start") {
        onActivityRef.current?.();
        void transport.send({ type: "get_state" });
      }
      // A completed turn changes token/cost totals and touches the session
      // file's mtime — refresh the stats meter and let the manager re-sort.
      if (ev.type === "agent_end") {
        refreshStats();
        onActivityRef.current?.();
        void transport.send({ type: "get_state" });
      }
    },
    [applyResponse, refreshStats, transport],
  );

  useEffect(() => {
    const offEvent = transport.onEvent(handleEvent);
    const offState = transport.onState((s) => {
      setConnection(s);
      if (s === "connected") {
        void transport.send({ type: "get_state" });
        void transport.send({ type: "get_available_models" });
        // An existing session boots with --session; pull its transcript.
        if (sessionPath) void transport.send({ type: "get_messages" });
        refreshStats();
      }
    });
    void transport
      .start({ model: DEFAULT_MODEL, cwd, session: sessionPath, name })
      .catch(() => setConnection("disconnected"));
    return () => {
      offEvent();
      offState();
      void transport.stop();
    };
    // transport is stable (keyed useMemo); handleEvent is stable via useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, handleEvent]);

  // ── actions ──────────────────────────────────────────────────────────
  const sendPrompt = useCallback(
    async (text: string, files: File[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && files.length === 0) return;
      const images =
        files.length > 0
          ? await Promise.all(files.map(fileToImageContent))
          : undefined;
      dispatch({ type: "@user", text: trimmed, images: files.length || undefined });
      await transport.send({
        type: "prompt",
        message: trimmed,
        images,
        streamingBehavior: stateRef.current.streaming ? "steer" : undefined,
      });
    },
    [transport],
  );

  const steer = useCallback(
    (text: string) => void transport.send({ type: "steer", message: text }),
    [transport],
  );

  const abort = useCallback(
    () => void transport.send({ type: "abort" }),
    [transport],
  );

  const answer = useCallback(
    (
      id: string,
      response: { value: string } | { confirmed: boolean } | { cancelled: true },
    ) => {
      void transport.send({ type: "extension_ui_response", id, ...response });
      dispatch({ type: "@resolveQuestion", id });
    },
    [transport],
  );

  const setModelById = useCallback(
    (provider: string, modelId: string) => {
      void transport.send({ type: "set_model", provider, modelId });
      // A new model may support a different thinking level — refresh state.
      void transport.send({ type: "get_state" });
    },
    [transport],
  );

  const setThinking = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelState(level); // optimistic
      void transport.send({ type: "set_thinking_level", level });
    },
    [transport],
  );

  const cycleModel = useCallback(
    () => void transport.send({ type: "cycle_model" }),
    [transport],
  );

  const forkSession = useCallback(
    (entryId: string) => void transport.send({ type: "fork", entryId }),
    [transport],
  );

  const renameSession = useCallback(
    (newName: string) =>
      void transport.send({ type: "set_session_name", name: newName }),
    [transport],
  );

  const restart = useCallback(async () => {
    setConnection("connecting");
    await transport
      .start({ model: DEFAULT_MODEL, cwd, session: sessionPath, name })
      .catch(() => setConnection("disconnected"));
  }, [transport, cwd, sessionPath, name]);

  return {
    procKey,
    items: state.items,
    streaming: state.streaming,
    queue: state.queue,
    model,
    availableModels,
    thinkingLevel,
    connection,
    identity,
    stats,
    sendPrompt,
    steer,
    abort,
    answer,
    setModelById,
    setThinking,
    cycleModel,
    forkSession,
    renameSession,
    restart,
  };
}
