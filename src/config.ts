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

/** The active backend. */
export const agent: AgentAdapter = piAdapter;
