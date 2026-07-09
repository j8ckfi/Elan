// ─── The fork knob ────────────────────────────────────────────────────────────
// This file is the single place a fork points Mari at a different agent CLI.
//
// To build "Mari for <your agent>":
//   1. Write an adapter (copy src/lib/adapters/mock/ as the template; the
//      contract is src/lib/agent/types.ts, the guide is docs/ADAPTERS.md).
//   2. Import it here and set `agent` to it.
//
// The UI reads `agent.name` for copy ("Message Pi…", "Pi disconnected") and
// `agent.capabilities` to decide what chrome to render — a minimal adapter
// (spawn + prompt + streamed text) gets a working app with the extras hidden.

import type { AgentAdapter } from "@/lib/agent/types";
import { piAdapter } from "@/lib/adapters/pi";
import { mockAdapter } from "@/lib/adapters/mock";
import { claudeCodeAdapter } from "@/lib/adapters/claude-code";

/** Adapters selectable at runtime (dev/tests): `VITE_AGENT=mock bun run dev`
 *  or `?agent=claude-code`. */
const REGISTRY: Record<string, AgentAdapter> = {
  pi: piAdapter,
  mock: mockAdapter,
  "claude-code": claudeCodeAdapter,
};

// Runtime selection, for dev and tests only — forks should change the default
// below instead. Priority: `?agent=mock` URL param → VITE_AGENT env → default.
const fromUrl =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent")
    : null;
const fromEnv = (import.meta as { env?: Record<string, string> }).env
  ?.VITE_AGENT;
const requested = fromUrl ?? fromEnv;

/** The active backend. Forks: replace `piAdapter` with your adapter. */
export const agent: AgentAdapter =
  (requested && REGISTRY[requested]) || piAdapter;
