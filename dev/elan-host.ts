// The Elan host: one process that owns BoardState, serves it to UI clients
// (REST + WS full-state push), and runs the HOT-SESSION orchestrator — all on
// the same createBoardStore rules module the browser store uses, persisted to
// `${ELAN_STATE_DIR}/board.json` instead of localStorage. Run with:
//
//   bun dev/elan-host.ts          # port 4519, state in ./.elan/
//
// Config via env: ELAN_HOST_PORT (4519), ELAN_STATE_DIR (./.elan),
// ELAN_MAX_SESSIONS (4), ELAN_SESSION_TIMEOUT_MS (per-TURN, 30 min),
// ELAN_THREAD_BUDGET (opt-in breaker, default uncapped), ELAN_SPAWN_ENV_EXTRA
// (comma-separated var names forwarded to children). The contract is
// docs/ORCHESTRATION.md — "Hot sessions" + "Durability architecture"; tests
// boot this in-process via startHost() (auto-start only under
// import.meta.main).
//
// THE INVARIANT (docs/ORCHESTRATION.md "Hot sessions", 2026-07-10): at most
// ONE AgentSessionRecord per (threadId, handle), and at most ONE live child
// per record, forever. Structurally enforced:
//   - sessionFor(threadId, handle) is the ONLY place records are minted
//     (besides the boot migration, which collapses legacy duplicates).
//   - Every ping (explicit @tag or reply-to-agent implicit tag — the store
//     emits both as `tagged` events) appends a TURN to the record's turns[].
//     Durable claims: an event is handled iff some record's turns[] carries
//     its id (or a legacy triggerEventId equals it).
//   - Turns run strictly one at a time per record: a per-record drain loop
//     is the only spawner; the reconciler never spawns directly. A tag
//     during a running turn just queues the next turn — that IS the fix for
//     the old wake model's clone bug.
//   - The wake/end/resume machinery is GONE. `elan wake-me`/`wait` explain
//     hotness and exit 0; POST /api/sessions/:id/wake-on answers 410.
//
// Residency: claude-code (bidirectional --input-format stream-json) and pi
// (--mode rpc) keep ONE resident child per record; new turns are injected on
// stdin. Idle resident children are NEVER killed (the per-turn timeout
// applies to in-flight turns only); if one dies, the next turn resurrects
// the SAME record via --resume/--session-id. mock is resident too (line-in,
// ack-out — zero credentials). cursor/grok/opencode run serialized one-shot
// turns on the SAME harness conversation; codex/devin/pool run each turn
// fresh with full context.
//
// Durability rules kept from the pre-hot host (docs/ORCHESTRATION.md):
//   3. The stream is the signal — per-harness outcome extractors over the
//      captured stdout JSONL lead every failure post; the ANSI-stripped
//      stderr tail is secondary. One log per RECORD, appended across turns:
//      .elan/sessions/<record-id>.log.
//   4. Environment is built, not inherited — login-shell probe, strip-list,
//      shim-first PATH with static fallbacks, TERM=dumb, our ELAN_*.
//   5. Limits — ELAN_MAX_SESSIONS concurrent children, opt-in per-thread
//      turn budget, per-turn ELAN_SESSION_TIMEOUT_MS with SIGTERM → 10s →
//      SIGKILL (fails the turn; the record goes idle and the next ping
//      resurrects).
//   6. Preflight before spawn — runner binary resolved on the CHILD's PATH;
//      GET /api/doctor (v2) reports per-harness bin/found/path/version/auth/
//      models/discoveryError/lastFailure — model discovery runs lazily off
//      doctor with per-probe 15s timeouts, cached until restart (?refresh=1).
//   7. Runner correctness — one declarative HARNESSES registry row per CLI
//      (claude-code, codex, pi, opencode, cursor, devin, pool, grok, mock):
//      argv shape, residency wiring, instructions injection, session-id
//      strategy (capture/mint/none), model discovery, auth probe, outcome
//      extractor. An instantly-dying resume falls back once to a fresh
//      start with full context (reason "resume-fell-back").
//
// Events: session-start once per record (first spawn); session-end ONLY on a
// failed turn (outcome error) — idling is not an ending.
//
// Telemetry: every captured stdout/stderr line of a live child ALSO goes
// out on the main WS channel as {type:"session-line", sessionId, stream,
// line}, appended across turns; logs replay via GET /api/sessions/:id/log.
// Roster mutation: PUT /api/roster {roster} → store.setRoster.

import type { FileSink, ServerWebSocket, Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createBoardStore,
  normalizeState,
  type BoardStore,
} from "../src/lib/board/store.ts";
import { emptyState } from "../src/lib/board/seed.ts";
import {
  toExchanges,
  type AgentSessionRecord,
  type BoardEvent,
  type BoardEventType,
  type BoardState,
  type Exchange,
  type Post,
  type RosterEntry,
  type Thread,
  type ThreadStatus,
} from "../src/lib/board/types.ts";

const CLI_PATH = join(import.meta.dir, "elan-cli.ts");
const MOCK_AGENT_PATH = join(import.meta.dir, "mock-agent.ts");
const PERSIST_DEBOUNCE_MS = 100;
const RECONCILE_TICK_MS = 2_000;
const KILL_GRACE_MS = 10_000;
const STALE_TAG_MS = 24 * 60 * 60 * 1000;
const BUDGET_WINDOW_MS = 10 * 60 * 1000;
const RESUME_FALLBACK_WINDOW_MS = 3_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

const VALID_STATUS = new Set<string>([
  "todo", "in_progress", "in_review", "done", "canceled",
]);
const EVENT_TYPES = new Set<string>([
  "created", "status", "tagged", "session-start", "session-end", "artifact", "label",
]);

// (The harness registry — HARNESSES — lives below, after the extractors and
// discovery parsers it references.)

/** One entry of AgentSessionRecord.turns — the hot model's unit of work. */
export type Turn = NonNullable<AgentSessionRecord["turns"]>[number];

/** Legacy claim-bookkeeping records (never a spawn attempt). The boot
 *  migration drops them entirely, folding their triggerEventIds into the
 *  surviving record's turns as done so nothing respawns. */
export const MARKER_REASONS = new Set([
  "budget-exceeded", "stale-skipped", "absorbed-by-live-session", "unknown-handle",
  "superseded-by-wake",
]);

function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Boot migration: collapse legacy sessions to ONE per (thread, handle) ────
// Legacy state files hold many records per (thread, handle) — the wake model
// minted one per tag plus marker records (the user's real board reached ~200
// records for one grok handle). Each group merges to ONE record:
//   - survivor: the newest record with a harnessSessionId, else the newest
//     non-marker record, else the newest of the group;
//   - every triggerEventId in the group becomes a done turn on the survivor
//     (nothing ever respawns for an already-claimed event); other records'
//     turns[] are absorbed as done; markers are dropped entirely;
//   - states normalize: waiting/done → idle; spawning/running (orphans — no
//     child can survive a host restart) → idle with the FIRST pending turn
//     failed and reason "orphaned-by-restart" (logged, NOT an error: the
//     next ping simply runs a turn); queued with nothing pending → idle;
//   - wakeOn and triggerEventId are stripped (turns[] carries the claims);
//     logPath is kept (survivor's, else the newest one in the group).
// Pure over BoardState so tests hit it directly; runs on every boot (a
// single modern record passes through untouched apart from orphan cleanup).
export function migrateSessions(
  state: BoardState,
  now: number = Date.now(),
): { state: BoardState; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;

  const groups = new Map<string, AgentSessionRecord[]>();
  for (const s of state.sessions) {
    const k = `${s.threadId} ${s.handle}`;
    const list = groups.get(k);
    if (list) list.push(s);
    else groups.set(k, [s]);
  }

  const newest = (list: AgentSessionRecord[]): AgentSessionRecord =>
    list.reduce((a, b) => ((b.startedAt ?? 0) >= (a.startedAt ?? 0) ? b : a));
  const isMarker = (s: AgentSessionRecord): boolean =>
    s.reason != null && MARKER_REASONS.has(s.reason);

  const out: AgentSessionRecord[] = [];
  for (const group of groups.values()) {
    const real = group.filter((s) => !isMarker(s));
    const withSid = real.filter((s) => s.harnessSessionId);
    const base =
      withSid.length > 0 ? newest(withSid) : real.length > 0 ? newest(real) : newest(group);

    // Absorb claims: the survivor's own turns keep their state; everything
    // else in the group (turns and legacy triggerEventIds) folds in as done.
    const turnMap = new Map<string, Turn>();
    for (const t of base.turns ?? []) turnMap.set(t.eventId, { ...t });
    for (const s of group) {
      if (s !== base)
        for (const t of s.turns ?? [])
          if (!turnMap.has(t.eventId))
            turnMap.set(t.eventId, { eventId: t.eventId, state: "done", at: t.at });
      if (s.triggerEventId && !turnMap.has(s.triggerEventId))
        turnMap.set(s.triggerEventId, {
          eventId: s.triggerEventId,
          state: "done",
          at: s.endedAt ?? s.startedAt ?? now,
        });
    }
    let turns = [...turnMap.values()].sort((a, b) => a.at - b.at);

    let st = base.state;
    let reason = base.reason;
    if (st === "spawning" || st === "running") {
      // Orphaned by a restart: the in-flight turn (the FIRST pending one)
      // did not finish; queued-behind turns stay pending and run at boot.
      const idx = turns.findIndex((t) => t.state === "pending");
      if (idx !== -1)
        turns = turns.map((t, i) => (i === idx ? { ...t, state: "failed" as const } : t));
      st = "idle";
      reason = "orphaned-by-restart";
      notes.push(
        `@${base.handle} in thread ${base.threadId} was ${base.state} at shutdown — ` +
          `idle now (orphaned-by-restart); the next ping runs a turn`,
      );
    } else if (st === "waiting" || st === "done") {
      st = "idle";
    } else if (st === "queued" && !turns.some((t) => t.state === "pending")) {
      st = "idle"; // legacy queued record whose claim was folded to done
    }
    if (isMarker(base)) {
      // A group that was ONLY markers: keep one record so the claims stay
      // durable, but it is idle bookkeeping, not an error.
      st = turns.some((t) => t.state === "pending") ? "queued" : "idle";
    }

    const logPath =
      base.logPath ??
      group.filter((s) => s.logPath).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
        ?.logPath;

    const survivor: AgentSessionRecord = {
      ...base,
      state: st,
      reason,
      turns,
      logPath,
      wakeOn: undefined,
      triggerEventId: undefined,
      procKey: undefined,
    };

    if (group.length > 1) {
      changed = true;
      notes.push(
        `merged ${group.length} session records for (@${base.handle}, thread ` +
          `${base.threadId}) → ${survivor.id} (${turns.length} claimed turns` +
          `${survivor.harnessSessionId ? `, harness session ${survivor.harnessSessionId}` : ""})`,
      );
    } else if (
      survivor.state !== base.state ||
      survivor.reason !== base.reason ||
      base.wakeOn !== undefined ||
      base.triggerEventId !== undefined ||
      base.procKey !== undefined ||
      (base.turns?.length ?? 0) !== turns.length
    ) {
      changed = true;
    }
    out.push(survivor);
  }

  return { state: { ...state, sessions: out }, changed, notes };
}

// ── ANSI stripping + per-harness outcome extraction ─────────────────────────
// Rule 3: the stdout event stream is the authoritative outcome; stderr is
// noise. Verified live 2026-07-10: claude's "Not logged in" rides the stdout
// `result` event with an EMPTY stderr; codex's fatal "requires a newer
// version of Codex" is a stdout `turn.failed` while stderr fills with
// non-fatal ANSI-colored rmcp noise.

/** Strip ANSI CSI sequences and OSC sequences (title-set etc.). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\].*?\x07/g, "");
}

export interface SessionOutcome {
  ok: boolean;
  /** The authoritative message extracted from the stream ("" if none). */
  text: string;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Extractor families — which parser folds a harness's stdout into the
 *  authoritative outcome (docs/ORCHESTRATION.md "Durability architecture" §3).
 *  Keyed by FAMILY, not harness id: cursor-agent speaks the claude-stream
 *  dialect, so both share one extractor. */
export type ExtractorKind =
  | "claude-stream"
  | "codex-events"
  | "pi-stream"
  | "opencode-events"
  | "devin-raw"
  | "pool-events"
  | "grok-stream"
  | "raw";

/** grok wraps provider errors as "Internal error: {json…}" — unwrap the
 *  nested JSON `message` when parseable, else return the original. */
function unwrapNestedMessage(message: string): string {
  for (const candidate of [message, message.slice(message.indexOf("{"))]) {
    if (!candidate || !candidate.trimStart().startsWith("{")) continue;
    try {
      const inner: unknown = JSON.parse(candidate);
      if (typeof inner === "object" && inner !== null) {
        const io = inner as Record<string, unknown>;
        const ie = io.error as Record<string, unknown> | undefined;
        if (typeof io.message === "string") return io.message;
        if (typeof ie?.message === "string") return ie.message;
      }
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return message;
}

/** Extract the authoritative outcome from a session's captured stdout lines.
 *  Pure — unit-testable against recorded fixtures. */
export function extractOutcome(
  kind: ExtractorKind | string,
  stdoutLines: string[],
  exitCode: number,
): SessionOutcome {
  if (kind === "claude-stream") {
    // claude-code + cursor-agent. The last `result` event is the verdict; its
    // `.result` field carries the human-readable message even for failures
    // ("Not logged in · Please run /login" arrives on a subtype:"success"
    // result event with is_error:true and an EMPTY stderr — verified live).
    let result: Record<string, unknown> | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (obj?.type === "result") result = obj;
    }
    const subtype = typeof result?.subtype === "string" ? result.subtype : "";
    const text = typeof result?.result === "string" ? result.result : "";
    const isError = result?.is_error === true;
    return { ok: exitCode === 0 && !subtype.startsWith("error") && !isError, text };
  }

  if (kind === "codex-events") {
    // `turn.failed` → error.message (sometimes itself a JSON envelope —
    // unwrap); otherwise the last `agent_message` item is the reply.
    let failed: string | undefined;
    let lastMessage: string | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (obj.type === "turn.failed") {
        const err = obj.error as Record<string, unknown> | undefined;
        let m = typeof err?.message === "string" ? err.message : "";
        // The message is often itself a JSON envelope — verified live both as
        // {"message":…} and as {"type":"error","error":{"message":…}}.
        try {
          const inner: unknown = JSON.parse(m);
          if (typeof inner === "object" && inner !== null) {
            const io = inner as Record<string, unknown>;
            const ie = io.error as Record<string, unknown> | undefined;
            if (typeof io.message === "string") m = io.message;
            else if (typeof ie?.message === "string") m = ie.message;
          }
        } catch {
          /* not nested JSON — keep as-is */
        }
        failed = m || "turn failed";
      } else if (obj.type === "item.completed") {
        const item = obj.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string")
          lastMessage = item.text;
      }
    }
    return {
      ok: exitCode === 0 && failed === undefined,
      text: failed ?? lastMessage ?? "",
    };
  }

  if (kind === "pi-stream") {
    // CRITICAL (verified live 2026-07-10): pi's exit code is MEANINGLESS —
    // it exits 0 after a provider failure (3 silent auto-retries, then
    // agent_settled). The stream is the ONLY outcome signal: failure iff the
    // last assistant turn_end has stopReason:"error" (errorMessage field) or
    // an auto_retry_end reports success:false (finalError). Success text is
    // the last turn_end's message.content[] text blocks.
    let lastText: string | undefined;
    let lastError: string | undefined;
    let sawTurnEnd = false;
    let retryFail: string | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (obj.type === "turn_end") {
        const m = obj.message as Record<string, unknown> | undefined;
        if (m?.role !== "assistant") continue;
        sawTurnEnd = true;
        if (m.stopReason === "error") {
          lastError =
            typeof m.errorMessage === "string" && m.errorMessage
              ? m.errorMessage
              : "provider error";
          lastText = undefined;
        } else {
          lastError = undefined;
          const content = Array.isArray(m.content) ? m.content : [];
          lastText = content
            .filter(
              (c): c is { type: string; text: string } =>
                typeof c === "object" && c !== null &&
                (c as Record<string, unknown>).type === "text" &&
                typeof (c as Record<string, unknown>).text === "string",
            )
            .map((c) => c.text)
            .join("\n")
            .trim();
        }
      } else if (obj.type === "auto_retry_end" && obj.success === false) {
        retryFail =
          typeof obj.finalError === "string" && obj.finalError
            ? obj.finalError
            : "auto-retry failed";
      }
    }
    const failure = retryFail ?? lastError;
    if (failure !== undefined) return { ok: false, text: failure };
    // No turn_end at all = the stream never got going (spawn-level failure).
    return { ok: sawTurnEnd, text: lastText ?? "" };
  }

  if (kind === "opencode-events") {
    // Exit code is reliable (0/1); the failure DETAIL is a stdout
    // {"type":"error", error.data.message} event, the success text the last
    // {"type":"text"} event's part.text.
    let errText: string | undefined;
    let lastText: string | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (obj.type === "error") {
        const err = obj.error as Record<string, unknown> | undefined;
        const data = err?.data as Record<string, unknown> | undefined;
        errText =
          (typeof data?.message === "string" && data.message) ||
          (typeof err?.name === "string" && err.name) ||
          "error";
      } else if (obj.type === "text") {
        const part = obj.part as Record<string, unknown> | undefined;
        if (typeof part?.text === "string") lastText = part.text;
      }
    }
    return {
      ok: exitCode === 0 && errText === undefined,
      text: errText ?? lastText ?? "",
    };
  }

  if (kind === "devin-raw") {
    // No stream: stdout IS the final answer text; errors ride stderr.
    // Exit 0 ok / 1 CLI error / 101 panic.
    return { ok: exitCode === 0, text: stdoutLines.join("\n").trim() };
  }

  if (kind === "pool-events") {
    // No text/message event exists. The answer is the last {"type":"thought"}
    // whose text doesn't duplicate a prior reasoning event (pool mirrors every
    // reasoning block as a thought; the actual reply is the thought with no
    // reasoning twin). Terminal = toolCall name:"exit" args.success. Exit 0
    // ok / 4 agent-declared failure (still an outcome — keep the message) /
    // 1 unexpected (stderr carries "Unexpected error: …").
    const reasoning = new Set<string>();
    let answer = "";
    let exitSuccess: boolean | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (obj.type === "reasoning" && typeof obj.reasoning === "string") {
        reasoning.add(obj.reasoning.trim());
      } else if (obj.type === "thought" && typeof obj.thought === "string") {
        const t = obj.thought.trim();
        if (t && !reasoning.has(t)) answer = t;
      } else if (obj.type === "toolCall" && obj.name === "exit") {
        const args = obj.args as Record<string, unknown> | undefined;
        exitSuccess = args?.success === true;
      }
    }
    return { ok: exitCode === 0 && exitSuccess !== false, text: answer };
  }

  if (kind === "grok-stream") {
    // {"type":"text","data"} chunks concatenate into the answer; terminal is
    // {"type":"end"}. {"type":"error","message"} is the failure text — the
    // message often wraps a nested JSON error (403 entitlement etc.).
    let text = "";
    let errMsg: string | undefined;
    for (const line of stdoutLines) {
      const obj = parseLine(line);
      if (!obj) continue;
      if (obj.type === "text" && typeof obj.data === "string") text += obj.data;
      else if (obj.type === "error" && typeof obj.message === "string")
        errMsg = unwrapNestedMessage(obj.message);
    }
    if (errMsg !== undefined) return { ok: false, text: errMsg };
    return { ok: exitCode === 0, text: text.trim() };
  }

  // raw (mock) + unknown: the last non-empty stdout line is the message.
  let last = "";
  for (const line of stdoutLines) if (line.trim()) last = line.trim();
  return { ok: exitCode === 0, text: last };
}

// ── Built child environment (rule 4) ────────────────────────────────────────
// The host's own env is assumed polluted (it may itself run under an agent
// harness — CLAUDECODE etc.). Children get a login-shell probe instead.

export const ENV_PROBE_BEGIN = "__ELAN_ENV_BEGIN__";
export const ENV_PROBE_END = "__ELAN_ENV_END__";
const ENV_PROBE_TIMEOUT_MS = 10_000;

/** Parse KEY=VALUE lines between the probe markers (rc noise outside the
 *  markers is ignored; continuation lines of multi-line values are dropped). */
export function parseEnvProbeOutput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of raw.split("\n")) {
    const t = line.replace(/\r$/, "");
    if (t === ENV_PROBE_BEGIN) {
      inside = true;
      continue;
    }
    if (t === ENV_PROBE_END) break;
    if (!inside) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Run the login-shell env probe: `env -i HOME=… USER=… SHELL=… $SHELL -lc
 *  'echo BEGIN; env; echo END'`, 10s timeout. Returns {} on any failure. */
export function probeLoginEnv(
  shell: string,
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  try {
    const seed = [
      `HOME=${hostEnv.HOME ?? ""}`,
      `USER=${hostEnv.USER ?? ""}`,
      `SHELL=${shell}`,
    ];
    const r = spawnSync(
      "env",
      ["-i", ...seed, shell, "-lc", `echo ${ENV_PROBE_BEGIN}; env; echo ${ENV_PROBE_END}`],
      { timeout: ENV_PROBE_TIMEOUT_MS, encoding: "utf8" },
    );
    if (typeof r.stdout !== "string") return {};
    return parseEnvProbeOutput(r.stdout);
  } catch {
    return {};
  }
}

let cachedLoginEnv: Record<string, string> | null = null;
function loginEnv(): Record<string, string> {
  if (cachedLoginEnv === null)
    cachedLoginEnv = probeLoginEnv(process.env.SHELL ?? "/bin/sh");
  return cachedLoginEnv;
}

const STRIP_EXACT = new Set(["CLAUDECODE"]);
const STRIP_PREFIXES = ["CLAUDE_CODE_", "ELAN_"];
const stripped = (key: string): boolean =>
  STRIP_EXACT.has(key) || STRIP_PREFIXES.some((p) => key.startsWith(p));

export interface BuildChildEnvInput {
  shimDir: string;
  /** Our ELAN_* identity vars (+ per-runner extras like ELAN_CONTEXT). */
  elan: Record<string, string>;
  /** Probed login-shell env (inject a fixture in tests). */
  probed: Record<string, string>;
  /** The host process env — only consulted for extraKeys + HOME/USER/SHELL
   *  fallbacks. Defaults to process.env. */
  hostEnv?: Record<string, string | undefined>;
  /** ELAN_SPAWN_ENV_EXTRA names: passed through from the probe (even past
   *  the strip list) or, failing that, from the host env. */
  extraKeys?: string[];
}

/** Build a child session's environment per rule 4. Pure given `probed`. */
export function buildChildEnv(input: BuildChildEnvInput): Record<string, string> {
  const hostEnv = input.hostEnv ?? process.env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.probed)) if (!stripped(k)) out[k] = v;

  const extraKeys =
    input.extraKeys ??
    (hostEnv.ELAN_SPAWN_ENV_EXTRA ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (const key of extraKeys) {
    const v = input.probed[key] ?? hostEnv[key];
    if (v !== undefined) out[key] = v;
  }

  // Identity fallbacks if the probe came back empty.
  for (const key of ["HOME", "USER", "SHELL"] as const)
    if (!out[key] && hostEnv[key]) out[key] = hostEnv[key]!;

  const home = out.HOME ?? "";
  const fallbackDirs = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const parts = [input.shimDir, ...(input.probed.PATH ?? "").split(":"), ...fallbackDirs];
  const seen = new Set<string>();
  const path: string[] = [];
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    path.push(p);
  }
  out.PATH = path.join(":");
  out.TERM = "dumb";
  Object.assign(out, input.elan);
  return out;
}

/** Resolve a binary against an explicit PATH string (our own `which` — the
 *  host's Bun.which would consult the polluted host PATH). */
export function whichOnPath(bin: string, pathStr: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of pathStr.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

const versionCache = new Map<string, string | undefined>();
/** `<bin> --version`, 5s timeout, cached until host restart. */
export function probeVersion(binPath: string): string | undefined {
  if (!versionCache.has(binPath)) {
    let v: string | undefined;
    try {
      const r = spawnSync(binPath, ["--version"], { timeout: 5_000, encoding: "utf8" });
      const line = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
        .split("\n")
        .map((s) => stripAnsi(s).trim())
        .find(Boolean);
      v = line || undefined;
    } catch {
      v = undefined;
    }
    versionCache.set(binPath, v);
  }
  return versionCache.get(binPath);
}

// ── Model-discovery parsers (pure — unit-tested against fixtures) ────────────
// One per harness with programmatic model enumeration. Formats verified live
// on this machine 2026-07-10; prefer "provider/model" where the CLI names
// providers.

/** `pi --list-models`: fixed-width table; skip the header row; columns 1+2
 *  (whitespace-split) are provider and model → "provider/model". */
export function parsePiModelTable(stdout: string): string[] {
  const out: string[] = [];
  let headerSkipped = false;
  for (const raw of stdout.split("\n")) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    if (!headerSkipped) {
      headerSkipped = true; // the first non-empty line is the header
      continue;
    }
    const cols = line.split(/\s+/);
    if (cols.length >= 2) out.push(`${cols[0]}/${cols[1]}`);
  }
  return out;
}

/** `opencode models`: one "provider/model" per line, no header. */
export function parseOpencodeModels(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = stripAnsi(raw).trim();
    if (line && line.includes("/") && !/\s/.test(line)) out.push(line);
  }
  return out;
}

/** `cursor-agent models`: skip the "Available models" header and trailing
 *  "Tip:" line; entries are "<id> - <Display Name>" — split on the first
 *  " - " and keep the id. */
export function parseCursorModels(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = stripAnsi(raw).trim();
    if (!line || /^available models/i.test(line) || /^tip:/i.test(line)) continue;
    const idx = line.indexOf(" - ");
    if (idx > 0) out.push(line.slice(0, idx).trim());
  }
  return out;
}

/** `grok models`: banner lines, then entries "  - <id>" or
 *  "  * <id> (default)". */
export function parseGrokModels(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const m = /^\s*[-*]\s+(\S+)/.exec(stripAnsi(raw));
    if (m) out.push(m[1]);
  }
  return out;
}

/** devin's bogus-model probe: exits 1 BEFORE any API call with the model
 *  families on stderr as a comma list after "Available:" (some builds spell
 *  it "Available models:"). */
export function parseDevinModels(stderr: string): string[] {
  const m = /Available(?:\s+models)?:\s*([^\n]+)/i.exec(stripAnsi(stderr));
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/** codex app-server JSON-RPC: the id:2 response to model/list carries
 *  result.data[] of {id, displayName, supportedReasoningEfforts}. */
export function parseCodexModelList(stdout: string): string[] {
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line.trim());
    if (obj?.id !== 2) continue;
    const result = obj.result as Record<string, unknown> | undefined;
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .map((d) => (d as Record<string, unknown>)?.id)
      .filter((id): id is string => typeof id === "string" && id !== "");
  }
  return [];
}

/** claude's control protocol: the control_response to the initialize
 *  control_request carries a `models` array (under response.response on the
 *  current CLI). Entries carry the pinnable id as `value` ("opus[1m]",
 *  "claude-fable-5[1m]", …) with displayName/supportedEffortLevels — older
 *  shapes spell it `model`; accept both. (NEVER `claude models`: that is not
 *  a subcommand, it runs a paid prompt.) */
export function parseClaudeModels(stdout: string): string[] {
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line.trim());
    if (obj?.type !== "control_response") continue;
    const response = obj.response as Record<string, unknown> | undefined;
    const inner = response?.response as Record<string, unknown> | undefined;
    const models = Array.isArray(response?.models)
      ? response.models
      : Array.isArray(inner?.models)
        ? inner.models
        : [];
    return models
      .map((m) => {
        const r = m as Record<string, unknown>;
        return typeof r?.model === "string" && r.model
          ? r.model
          : typeof r?.value === "string"
            ? r.value
            : "";
      })
      .filter((m) => m !== "");
  }
  return [];
}

/** pool acp JSON-RPC: the id:2 response to session/new carries
 *  result.configOptions[]; the entry with id:"model" lists options[].value
 *  (+ currentValue). */
export function parsePoolModels(stdout: string): string[] {
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line.trim());
    if (obj?.id !== 2) continue;
    const result = obj.result as Record<string, unknown> | undefined;
    const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    const modelOpt = configOptions.find(
      (o) => (o as Record<string, unknown>)?.id === "model",
    ) as Record<string, unknown> | undefined;
    if (!modelOpt) return [];
    const options = Array.isArray(modelOpt.options) ? modelOpt.options : [];
    const values = options
      .map((o) => (o as Record<string, unknown>)?.value)
      .filter((v): v is string => typeof v === "string" && v !== "");
    const current = modelOpt.currentValue;
    if (typeof current === "string" && current && !values.includes(current))
      values.push(current);
    return values;
  }
  return [];
}

// ── Line pump (shared by session capture and discovery probes) ──────────────

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            onLine(line);
          } catch {
            /* one bad line never kills the pump */
          }
        }
      }
    }
    if (buffer.trim()) onLine(buffer.trim());
  } catch {
    /* stream closed */
  }
}

// ── Discovery / auth probe engines ───────────────────────────────────────────
// Discovery runs lazily off /api/doctor with the BUILT child env, in
// parallel, one 15s cap per probe, cached until host restart (?refresh=1
// re-probes). Interactive probes (claude/codex/pool spawn a child that would
// otherwise run forever) are ALWAYS killed in a finally.

const DISCOVERY_TIMEOUT_MS = 15_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

interface ExecCaptureResult {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn-to-completion with a hard timeout; the child is always reaped. */
async function execCapture(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<ExecCaptureResult> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exit: typeof exit === "number" ? exit : null, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
}

export interface ProbeStep {
  /** One ndjson line to write to the child's stdin. */
  send: string;
  /** Wait for a matching stdout line before the next step (absent = fire
   *  and continue immediately, e.g. JSON-RPC notifications). */
  until?: (line: string) => boolean;
}

/** Drive an interactive (stdin/stdout ndjson) probe: write each step, wait
 *  for its response, then KILL the child — it would otherwise idle forever.
 *  Returns every stdout line seen, joined. */
async function runInteractiveProbe(
  argv: string[],
  steps: ProbeStep[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  void pumpLines(proc.stdout, (l) => lines.push(l));
  const deadline = Date.now() + timeoutMs;
  try {
    for (const step of steps) {
      proc.stdin.write(step.send + "\n");
      await proc.stdin.flush();
      if (!step.until) continue;
      let scanned = 0;
      let matched = false;
      while (!matched) {
        while (scanned < lines.length) {
          if (step.until(lines[scanned++])) {
            matched = true;
            break;
          }
        }
        if (matched) break;
        if (Date.now() > deadline)
          throw new Error(`model discovery timed out after ${Math.round(timeoutMs / 1000)}s`);
        await Bun.sleep(25);
      }
    }
  } finally {
    try {
      proc.kill("SIGKILL"); // interactive children NEVER outlive the probe
    } catch {
      /* already dead */
    }
  }
  return lines.join("\n");
}

// ── The harness registry ─────────────────────────────────────────────────────
// One declarative table, one entry per supported CLI; everything
// harness-specific hangs off it — runners, discovery, auth probes,
// extraction — so adding a harness is adding a row
// (docs/ORCHESTRATION.md "The harness registry"). Every runner/discovery
// shape below was verified against the live CLI on this machine 2026-07-10.

export interface RunnerCtx {
  /** The resolved binary (on the CHILD's PATH). */
  binPath: string;
  /** Rendered thread context on a fresh spawn; the wake prompt on resume. */
  prompt: string;
  /** Elan standing instructions (how to drive the `elan` CLI). */
  instructions: string;
  /** Roster-pinned model, if any. */
  model?: string;
  /** The session's cwd (thread worktree). */
  cwd: string;
  /** Elan session id (names per-session scratch files). */
  sessionId: string;
  /** Host dir where runners may park prompt files (devin). */
  sessionDir: string;
  /** Set when this start is a wake of an existing harness session. */
  resume?: { harnessSessionId: string };
  /** The harness-native session id when one exists — including the minted
   *  one grok gets on FRESH spawns (mint-per-(thread,handle) strategy). */
  harnessSessionId?: string;
}

export interface RunnerSpec {
  argv: string[];
  env?: Record<string, string>;
  /** Files the host writes before spawning (devin's --prompt-file). */
  files?: { path: string; content: string }[];
}

export type ModelDiscovery =
  | {
      kind: "simple";
      /** argv after the binary. */
      args: string[];
      /** Exit codes that still carry a valid answer (devin exits 1 by design). */
      okExit?: number[];
      parse(stdout: string, stderr: string): string[];
    }
  | {
      kind: "interactive";
      args: string[];
      steps(ctx: { cwd: string }): ProbeStep[];
      parse(stdout: string, stderr: string): string[];
    };

export type AuthProbe =
  | { kind: "file-keys"; path(home: string): string }
  | { kind: "file-exists"; path(home: string): string }
  | {
      kind: "exec";
      args: string[];
      interpret(exit: number, stdout: string, stderr: string): string;
    }
  /** Authenticated iff model discovery succeeds (claude: an unauthenticated
   *  CLI answers the initialize control_request differently / exits 1). */
  | { kind: "discovery" };

/** What a resident harness needs at spawn time. NO prompt: turns are
 *  injected on stdin, never argv. */
export interface ResidencyCtx {
  binPath: string;
  /** Elan standing instructions (how to drive the `elan` CLI). */
  instructions: string;
  /** Roster-pinned model, if any. */
  model?: string;
  /** Harness-native session id when this start resurrects a dead resident
   *  child (--resume / --session-id continuity — same record, new child). */
  resume?: string;
}

/** Bidirectional residency: ONE live child per record; each turn is one
 *  stdin line; completion is a recognizable stdout event. */
export interface Residency {
  argv(ctx: ResidencyCtx): string[];
  /** Encode a turn prompt as one stdin line (newline appended by the host).
   *  `turnNo` is the 1-based position of the turn on the record. */
  encodeTurn(prompt: string, turnNo: number): string;
  /** Does this parsed stdout line settle the in-flight turn? */
  isTurnEnd(msg: Record<string, unknown>): boolean;
}

export interface HarnessProfile {
  /** The roster's `harness` value. */
  id: string;
  displayName: string;
  /** Executable resolved on the CHILD PATH (preflight + doctor). */
  bin: string;
  /** One-shot spawn per turn (serialized harnesses). Exactly one of
   *  runner/residency is set. */
  runner?(ctx: RunnerCtx): RunnerSpec | { error: string };
  /** Resident child wiring (claude-code, pi, mock). */
  residency?: Residency;
  /** How the harness-native session id (for resume) is learned: captured
   *  from the stdout stream, minted by the host (grok's create-or-resume
   *  `-s`), or not at all (no resume support). */
  sessionId:
    | { mode: "capture"; capture(msg: Record<string, unknown>): string | undefined }
    | { mode: "mint" }
    | null;
  modelDiscovery: ModelDiscovery | null;
  authProbe: AuthProbe | null;
  extract: ExtractorKind;
}

export const THREAD_CONTEXT_SEPARATOR = "── thread context ──";

/** Separates the rendered context from the triggering ping in a full-context
 *  turn prompt. dev/mock-agent.ts mirrors this literal to find the ping. */
export const TURN_PING_SEPARATOR = "── this turn's ping ──";

/** Harnesses without a native system-prompt/append flag get the standing
 *  instructions PREPENDED to the prompt under a separator. */
export function prependInstructions(instructions: string, prompt: string): string {
  return `${instructions}\n\n${THREAD_CONTEXT_SEPARATOR}\n\n${prompt}`;
}

const captureSessionIdField = (msg: Record<string, unknown>): string | undefined =>
  typeof msg.session_id === "string" && msg.session_id ? msg.session_id : undefined;

export const HARNESSES: Record<string, HarnessProfile> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    bin: "claude",
    extract: "claude-stream",
    sessionId: { mode: "capture", capture: captureSessionIdField },
    // Resident: ONE bidirectional child per record. Turns ride stdin as
    // {type:"user"} messages (the exact wire shape of the desktop adapter,
    // src/lib/adapters/claude-code/index.ts); the stream's `result` event
    // settles each turn; the init event's session_id is the resurrection
    // handle (--resume on the REPLACEMENT resident child).
    residency: {
      argv: (ctx) => [
        ctx.binPath, "-p",
        "--input-format", "stream-json", "--output-format", "stream-json",
        // stream-json in -p mode refuses to run without --verbose.
        "--verbose",
        // Non-interactive -p auto-denies tool permissions, which would make
        // the elan CLI unreachable. Autonomy in an isolated worktree is the
        // product premise; the board is the oversight.
        "--permission-mode", "bypassPermissions",
        "--append-system-prompt", ctx.instructions,
        ...(ctx.model ? ["--model", ctx.model] : []),
        ...(ctx.resume ? ["--resume", ctx.resume] : []),
      ],
      encodeTurn: (prompt) =>
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        }),
      isTurnEnd: (msg) => msg.type === "result",
    },
    modelDiscovery: {
      kind: "interactive",
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      steps: () => [
        {
          send: JSON.stringify({
            type: "control_request",
            request_id: "r1",
            request: { subtype: "initialize" },
          }),
          until: (line) => line.includes('"control_response"'),
        },
      ],
      parse: (stdout) => parseClaudeModels(stdout),
    },
    authProbe: { kind: "discovery" },
  },

  codex: {
    id: "codex",
    displayName: "Codex",
    bin: "codex",
    extract: "codex-events",
    sessionId: null, // no resume support → always a fresh run with full context
    runner(ctx) {
      // --skip-git-repo-check: codex hard-fails outside a trusted dir
      // without it; -m: the roster pin must beat a possibly-broken user
      // config default. No instructions flag → prepend. Prompt is LAST.
      return {
        argv: [
          ctx.binPath, "exec", "--json", "--skip-git-repo-check",
          ...(ctx.model ? ["-m", ctx.model] : []),
          prependInstructions(ctx.instructions, ctx.prompt),
        ],
      };
    },
    modelDiscovery: {
      kind: "interactive",
      args: ["app-server"],
      steps: () => [
        {
          send: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "elan", title: "Elan", version: "0.1.0" } },
          }),
          until: (line) => line.includes('"id":1'),
        },
        { send: JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) },
        {
          send: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "model/list",
            params: { limit: 200, includeHidden: false },
          }),
          until: (line) => line.includes('"id":2'),
        },
      ],
      parse: (stdout) => parseCodexModelList(stdout),
    },
    authProbe: null,
  },

  pi: {
    id: "pi",
    displayName: "Pi",
    bin: "pi",
    extract: "pi-stream",
    sessionId: {
      mode: "capture",
      // The FIRST stream line is {"type":"session","id":…} — that id is the
      // --session-id resume handle.
      capture: (msg) =>
        msg.type === "session" && typeof msg.id === "string" && msg.id ? msg.id : undefined,
    },
    // Resident over `pi --mode rpc`: turns are {type:"prompt"} commands per
    // src/lib/adapters/pi/protocol.ts; the run settles on agent_end (or the
    // prompt command's RpcResponse). Resurrection via --session-id.
    residency: {
      argv: (ctx) => [
        ctx.binPath, "--mode", "rpc",
        ...(ctx.model ? ["--model", ctx.model] : []),
        "--append-system-prompt", ctx.instructions,
        ...(ctx.resume ? ["--session-id", ctx.resume] : []),
      ],
      encodeTurn: (prompt, turnNo) =>
        JSON.stringify({ id: `elan-turn-${turnNo}`, type: "prompt", message: prompt }),
      isTurnEnd: (msg) =>
        msg.type === "agent_end" ||
        (msg.type === "response" && msg.command === "prompt"),
    },
    // Offline, <1s, ~301 models on this machine.
    modelDiscovery: {
      kind: "simple",
      args: ["--list-models"],
      parse: (stdout) => parsePiModelTable(stdout),
    },
    authProbe: { kind: "file-keys", path: (home) => join(home, ".pi", "agent", "auth.json") },
  },

  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    bin: "opencode",
    extract: "opencode-events",
    sessionId: {
      mode: "capture",
      capture: (msg) =>
        typeof msg.sessionID === "string" && msg.sessionID ? msg.sessionID : undefined,
    },
    runner(ctx) {
      // ALWAYS pass -m: the user's config default may point at a dead local
      // LM Studio server — an unpinned roster entry cannot spawn honestly.
      if (!ctx.model)
        return {
          error:
            "opencode needs a pinned model on the roster entry (its config default " +
            "may point at a dead local server) — set one in Settings.",
        };
      // stdin MUST be /dev/null (it eats piped stdin as prompt text and
      // merges it) — the host spawns every child with stdin: "ignore".
      // --auto: opencode's permission system treats a git WORKTREE as an
      // external directory (project-root detection follows gitdir to the
      // main repo) and auto-rejects fs access headlessly. --auto is the
      // autonomy flag, same stance as bypassPermissions/--force/dangerous.
      if (ctx.resume) {
        return {
          argv: [
            ctx.binPath, "run", "--format", "json", "--auto", "-m", ctx.model,
            "-s", ctx.resume.harnessSessionId, ctx.prompt,
          ],
        };
      }
      return {
        argv: [
          ctx.binPath, "run", "--format", "json", "--auto", "-m", ctx.model,
          prependInstructions(ctx.instructions, ctx.prompt),
        ],
      };
    },
    modelDiscovery: {
      kind: "simple",
      args: ["models"],
      parse: (stdout) => parseOpencodeModels(stdout),
    },
    // The `providers list` output has ANSI even when piped — read the auth
    // file instead.
    authProbe: {
      kind: "file-keys",
      path: (home) => join(home, ".local", "share", "opencode", "auth.json"),
    },
  },

  cursor: {
    id: "cursor",
    displayName: "Cursor",
    bin: "cursor-agent",
    extract: "claude-stream", // cursor speaks the claude-stream dialect
    sessionId: { mode: "capture", capture: captureSessionIdField },
    runner(ctx) {
      // Prompt must be argv (stdin may stay open); --force + --trust skip
      // the workspace-trust interrogation that otherwise blocks -p.
      // NOTE: --resume silently adopts unknown ids as fresh sessions — never
      // trust it to validate; the resume-fallback covers instant deaths only.
      if (ctx.resume) {
        return {
          argv: [
            ctx.binPath, "-p", "--output-format", "stream-json", "--force", "--trust",
            "--resume", ctx.resume.harnessSessionId,
            ...(ctx.model ? ["--model", ctx.model] : []),
            ctx.prompt,
          ],
        };
      }
      return {
        argv: [
          ctx.binPath, "-p", "--output-format", "stream-json", "--force", "--trust",
          ...(ctx.model ? ["--model", ctx.model] : []),
          prependInstructions(ctx.instructions, ctx.prompt), // no append flag
        ],
      };
    },
    // ~190 models here; requires auth.
    modelDiscovery: {
      kind: "simple",
      args: ["models"],
      parse: (stdout) => parseCursorModels(stdout),
    },
    authProbe: {
      kind: "exec",
      args: ["status"],
      interpret: (exit) => (exit === 0 ? "logged-in" : "not-logged-in"),
    },
  },

  devin: {
    id: "devin",
    displayName: "Devin",
    bin: "devin",
    extract: "devin-raw",
    // Resume (`-r <word-pair-id>`) exists but the id never appears on the
    // stream (stdout is the bare answer text) — no way to capture it, so
    // every start is a fresh run with full context.
    sessionId: null,
    runner(ctx) {
      // NEVER spawn without a prompt: it panics with exit 101.
      if (!ctx.prompt.trim()) return { error: "devin requires a non-empty prompt" };
      // The context goes through --prompt-file (a temp file in the session
      // dir) — thread contexts overflow ARG_MAX.
      const promptFile = join(ctx.sessionDir, `${ctx.sessionId}.prompt.md`);
      return {
        argv: [
          ctx.binPath, "--permission-mode", "dangerous", "--prompt-file", promptFile,
          ...(ctx.model ? ["--model", ctx.model] : []),
        ],
        files: [{ path: promptFile, content: prependInstructions(ctx.instructions, ctx.prompt) }],
      };
    },
    // Free and ~instant: a bogus --model exits 1 BEFORE any API call with
    // the model families on stderr.
    modelDiscovery: {
      kind: "simple",
      args: ["--model", "bogus-model-xyz-elan-probe", "-p", "ping"],
      okExit: [0, 1],
      parse: (_stdout, stderr) => parseDevinModels(stderr),
    },
    authProbe: {
      kind: "exec",
      args: ["auth", "status"],
      interpret: (exit) => (exit === 0 ? "logged-in" : "not-logged-in"),
    },
  },

  pool: {
    id: "pool",
    displayName: "Poolside",
    bin: "pool",
    extract: "pool-events",
    // `pool exec --continue <runId>` exists, but the runId never reaches
    // stdout (it lands as the newest session-<runId>.json under the user's
    // Application Support dir) — resume is best-effort at most, so v1
    // always fresh-spawns with full context.
    sessionId: null,
    runner(ctx) {
      return {
        argv: [
          ctx.binPath, "exec", "-o", "json", "--unsafe-auto-allow",
          "-d", ctx.cwd,
          "-p", prependInstructions(ctx.instructions, ctx.prompt),
        ],
        // POOLSIDE_STANDALONE_MODEL is the ONLY model pin — no flag exists.
        env: ctx.model ? { POOLSIDE_STANDALONE_MODEL: ctx.model } : undefined,
      };
    },
    modelDiscovery: {
      kind: "interactive",
      args: ["acp"],
      steps: ({ cwd }) => [
        {
          send: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {} },
          }),
          until: (line) => line.includes('"id":1'),
        },
        {
          send: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd, mcpServers: [] },
          }),
          until: (line) => line.includes('"id":2'),
        },
      ],
      parse: (stdout) => parsePoolModels(stdout),
    },
    authProbe: {
      kind: "file-exists",
      path: (home) => join(home, ".config", "poolside", "credentials.json"),
    },
  },

  grok: {
    id: "grok",
    displayName: "Grok Build",
    bin: "grok",
    extract: "grok-stream",
    // `-s <id>` is create-or-resume: the host MINTS one UUID per
    // (thread,handle) session record and always passes it — wake is just
    // the same id again.
    sessionId: { mode: "mint" },
    runner(ctx) {
      if (!ctx.harnessSessionId)
        return { error: "grok runner needs a minted session id (host bug)" };
      return {
        argv: [
          ctx.binPath, "-p", ctx.prompt, // --rules carries the instructions
          ...(ctx.model ? ["-m", ctx.model] : []),
          "--output-format", "streaming-json", "--always-approve",
          "--cwd", ctx.cwd,
          "--rules", ctx.instructions, // --rules = system prompt append
          "-s", ctx.harnessSessionId,
        ],
      };
    },
    modelDiscovery: {
      kind: "simple",
      args: ["models"],
      parse: (stdout) => parseGrokModels(stdout),
    },
    // NOTE: logged-in ≠ chat-entitled — a 403 on the chat endpoint arrives
    // as a stream {"type":"error"} and surfaces through the extractor as
    // the ⚠︎ post; this probe only answers "is there a login at all".
    authProbe: {
      kind: "exec",
      args: ["models"],
      interpret: (exit, stdout) =>
        exit === 0 && /you are logged in/i.test(stdout) ? "logged-in" : "not-logged-in",
    },
  },

  mock: {
    id: "mock",
    displayName: "Mock (demo-bot)",
    bin: "bun",
    // The resident mock speaks the claude-stream dialect for turn ends: one
    // {"type":"result",…} line per turn, so extraction and settling share
    // the claude path. Zero credentials — the residency test harness.
    extract: "claude-stream",
    sessionId: null,
    residency: {
      argv: (ctx) => [ctx.binPath, MOCK_AGENT_PATH],
      encodeTurn: (prompt, turnNo) => JSON.stringify({ prompt, turn: turnNo }),
      isTurnEnd: (msg) => msg.type === "result",
    },
    modelDiscovery: null,
    authProbe: null,
  },
};

// ── Thread context rendering ────────────────────────────────────────────────
// The markdown document a summoned agent sees. Pure over BoardState so tests
// can hit it directly (docs/ORCHESTRATION.md "Thread context rendering").

const VERB_TABLE = `| verb | usage |
| --- | --- |
| post | \`elan post <text>\` — top-level post; @handle mentions summon that agent |
| reply | \`elan reply <post-id> <text>\` — reply inside an exchange |
| resolve | \`elan resolve <post-id> <text>\` — file the ⚑ resolution that closes an exchange |
| attach | \`elan attach <path> [--note <text>]\` — register an artifact on the board |
| status | \`elan status <todo/in-progress/in-review/done/canceled>\` — move the thread |
| thread | \`elan thread\` — reprint this context, refreshed |
| read | \`elan read <post-id>\` — print the full exchange behind a ⚑ line |

Your session stays hot: when your turn's work is done, just stop — every new
ping (an @mention or a reply to your posts) arrives as a new message in this
same session. There is nothing to wait on and no session to end.`;

function eventLine(e: BoardEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "created":
      return `- ${e.actor} created the thread`;
    case "status":
      return `- ${e.actor} moved ${String(p.from)} → ${String(p.to)}`;
    case "tagged":
      return `- ${e.actor} tagged @${String(p.handle)}`;
    case "session-start":
      return `- @${String(p.handle)} session started`;
    case "session-end":
      return `- @${String(p.handle)} session ended (${String(p.outcome)})`;
    case "artifact": {
      const a = (p.attachment ?? {}) as { name?: string; path?: string };
      return `- ${e.actor} attached ${a.path ?? a.name ?? "an artifact"}`;
    }
    case "label":
      return `- ${e.actor} changed labels`;
    default:
      return `- ${e.actor}: ${e.type}`;
  }
}

function postLines(lines: string[], p: Post, indent: string): void {
  const flag = p.kind === "resolution" ? "⚑ " : "";
  lines.push(`${indent}**${p.author}**: ${flag}${p.body}`);
  for (const a of p.attachments) lines.push(`${indent}  (attachment: ${a.path})`);
}

function exchangeBlock(x: Exchange): string {
  // Resolved exchanges compress to their resolution line — collapse state and
  // context compression are the same abstraction (docs/DATA-MODEL.md).
  if (x.resolution) {
    return (
      `- ⚑ [resolved, ${x.replies.length} replies — run \`elan read ${x.root.id}\` ` +
      `for the full exchange] ${x.resolution.body}`
    );
  }
  const lines: string[] = [];
  postLines(lines, x.root, "");
  for (const r of x.replies) postLines(lines, r, "  ");
  return lines.join("\n");
}

/** Render a thread as the markdown context document. `handle` addresses the
 *  "## You" instructions to a specific roster agent (omitted without one). */
export function renderThreadContext(
  state: BoardState,
  threadId: string,
  handle?: string,
): string {
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) throw new Error(`unknown thread ${threadId}`);
  const project = state.projects.find((p) => p.id === thread.projectId);
  const key = project ? `${project.key}-${thread.number}` : `#${thread.number}`;

  const out: string[] = [];
  out.push(`# ${key}: ${thread.title}`, "");
  out.push(
    `Status: ${thread.status}` +
      (project ? ` · Project: ${project.name} (${project.repoPath})` : ""),
    "",
  );
  if (thread.body.trim()) out.push(thread.body.trim(), "");

  out.push("## Roster", "");
  out.push("| handle | harness |", "| --- | --- |");
  for (const r of state.roster) out.push(`| ${r.handle} | ${r.harness} |`);
  out.push("");

  out.push("## Activity", "");
  const events = state.events.filter((e) => e.threadId === threadId);
  const posts = state.posts.filter((p) => p.threadId === threadId);
  const items = [
    ...events.map((e) => ({ at: e.at, text: eventLine(e) })),
    ...toExchanges(posts).map((x) => ({ at: x.root.createdAt, text: exchangeBlock(x) })),
  ].sort((a, b) => a.at - b.at);
  if (items.length === 0) out.push("(no activity yet)");
  for (const it of items) out.push(it.text);
  out.push("");

  if (handle) {
    const entry = state.roster.find((r) => r.handle === handle);
    out.push("## You", "");
    out.push(
      `You are **@${handle}**${entry ? ` (harness: ${entry.harness})` : ""}, ` +
        `summoned into this thread.`,
      "",
    );
    out.push(
      `- Your worktree (cwd): ${thread.worktreePath ?? project?.repoPath ?? "(host cwd)"}`,
    );
    out.push("- Act on the board ONLY via the `elan` CLI (already on your PATH):", "");
    out.push(VERB_TABLE, "");
    out.push(
      "- The repo's own policy files (AGENTS.md etc.) are the authority on " +
        "process — read them before acting.",
    );
    out.push(
      "- When your work is done: move the thread (`elan status …`) and mention " +
        "whoever the policy files say acts next (`@handle` in a post).",
    );
  }
  return out.join("\n").trimEnd() + "\n";
}

/** The one-liner injected natively (claude-code/pi --append-system-prompt,
 *  grok --rules) or prepended for the rest. */
function shortInstructions(handle: string): string {
  return (
    `You are @${handle} on an Elan board thread. Act on the board ONLY via the ` +
    "`elan` CLI on your PATH (elan post/reply/resolve/attach/status/thread/read " +
    "— run `elan help`). The repo's own policy files (AGENTS.md etc.) govern " +
    "process. When your turn's work is done, move the thread status, mention " +
    "whoever policy says acts next, and stop — your session stays hot, and new " +
    "pings arrive as new messages."
  );
}

// ── The host ────────────────────────────────────────────────────────────────

export interface StartHostOptions {
  /** Overrides ELAN_HOST_PORT (default 4519). Pass 0 for an ephemeral port. */
  port?: number;
  /** Overrides ELAN_STATE_DIR (default: join(cwd, ".elan")). */
  stateDir?: string;
  /** Silence request/boot logging (tests). Errors still print. */
  log?: boolean;
  /** Overrides ELAN_MAX_SESSIONS (default 4). */
  maxSessions?: number;
  /** Overrides ELAN_SESSION_TIMEOUT_MS (default 30 min). */
  sessionTimeoutMs?: number;
  /** Overrides ELAN_THREAD_BUDGET (default 0 = uncapped; >0 opts into the breaker). */
  threadBudget?: number;
  /** /api/doctor runs `<bin> --version` on found binaries (default true).
   *  Tests pass false — fixtures only, never the real harness CLIs. */
  probeVersions?: boolean;
  /** /api/doctor runs model discovery + auth probes (default true). Tests
   *  pass false — the parsers are covered by fixtures instead. */
  probeDiscovery?: boolean;
}

export interface ElanHost {
  port: number;
  url: string;
  store: BoardStore;
  stop(): void;
}

/** The in-flight turn on one child — the per-TURN timeout applies to this
 *  and only this (idle resident children are exempt). */
interface TurnFlight {
  eventId: string;
  startedAt: number;
  /** Stdout lines seen while THIS turn was in flight (outcome extraction). */
  lines: string[];
  /** First settle wins: either the residency's turn-end line, or the child
   *  exiting (serialized turns always settle by exit). */
  settle(result: { kind: "turn-end" } | { kind: "exit"; code: number }): void;
  settled: boolean;
  timedOut?: boolean;
  killedAt?: number;
}

/** In-memory bookkeeping for one live child — a cache around the process
 *  handle, never correctness (the session record is). Keyed by RECORD id:
 *  one live child per record, structurally. */
interface ChildInfo {
  proc: Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  /** The resident child's stdin sink (turns ride it as ndjson lines). */
  stdin?: FileSink;
  recordId: string;
  threadId: string;
  handle: string;
  harness: string;
  /** Which outcome extractor folds this child's stdout (from the registry). */
  extract: ExtractorKind;
  /** A resident child outlives its turns; a serialized child IS one turn. */
  resident: boolean;
  isResume: boolean;
  spawnedAt: number;
  jsonEvents: number;
  stderrRaw: string;
  logPath: string;
  turn?: TurnFlight;
}

export function startHost(opts: StartHostOptions = {}): ElanHost {
  const stateDir =
    opts.stateDir ?? process.env.ELAN_STATE_DIR ?? join(process.cwd(), ".elan");
  const requestedPort = opts.port ?? Number(process.env.ELAN_HOST_PORT ?? 4519);
  const stateFile = join(stateDir, "board.json");
  const shimDir = join(stateDir, "bin");
  const sessionsDir = join(stateDir, "sessions");
  const say = opts.log === false ? () => {} : console.log;

  const maxSessions = opts.maxSessions ?? intEnv(process.env.ELAN_MAX_SESSIONS, 4);
  const sessionTimeoutMs =
    opts.sessionTimeoutMs ?? intEnv(process.env.ELAN_SESSION_TIMEOUT_MS, 30 * 60 * 1000);
  // Uncapped by default: agent-to-agent chains are the product working as
  // designed — sessions self-terminate, the concurrency cap bounds load, and
  // the board makes every chain visible (the human is the circuit breaker).
  // Set ELAN_THREAD_BUDGET to a positive number to opt into the breaker.
  const threadBudget = opts.threadBudget ?? intEnv(process.env.ELAN_THREAD_BUDGET, 0);
  const probeVersions = opts.probeVersions ?? true;
  const probeDiscovery = opts.probeDiscovery ?? true;
  const bootedAt = Date.now();

  // ── store: hydrate-or-empty, debounced atomic-ish persist ─────────────────
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  let initial: BoardState;
  try {
    initial = normalizeState(JSON.parse(readFileSync(stateFile, "utf8")));
  } catch {
    initial = emptyState(); // absent or corrupt → empty, never demo
  }
  // Boot migration: collapse legacy sessions to ONE per (thread, handle) and
  // normalize legacy states — see migrateSessions above. Runs before the
  // store exists, so nothing can observe the duplicates.
  const migration = migrateSessions(initial);
  initial = migration.state;
  for (const note of migration.notes) say(`[host] migrate: ${note}`);
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty: BoardState | null = null;
  function flush(): void {
    if (!dirty) return;
    try {
      writeFileSync(`${stateFile}.tmp`, JSON.stringify(dirty, null, 2));
      renameSync(`${stateFile}.tmp`, stateFile);
    } catch (e) {
      console.error("[host] persist failed:", e);
    }
    dirty = null;
  }
  const store = createBoardStore({
    initial,
    persist(state) {
      dirty = state;
      if (persistTimer != null) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        flush();
      }, PERSIST_DEBOUNCE_MS);
    },
  });
  if (migration.changed) {
    // The collapse must land on disk NOW — a crash before the first mutation
    // would otherwise re-run against the duplicated legacy file forever.
    dirty = store.getState();
    flush();
  }

  // ── the elan shim: `elan` on every child session's PATH ────────────────────
  // Absolute bun path — the built child env's PATH may not include wherever
  // bun lives on this machine, but the shim must always resolve it.
  const shimPath = join(shimDir, "elan");
  writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  // ── HTTP plumbing ──────────────────────────────────────────────────────────
  const sockets = new Set<ServerWebSocket<undefined>>();

  const json = (data: unknown, status = 200): Response =>
    Response.json(data, { status, headers: CORS });
  const errRes = (message: string, status: number): Response =>
    json({ error: message }, status);

  async function readBody(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const body: unknown = await req.json();
      return typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null; // malformed JSON → caller 400s
    }
  }

  const isAttachment = (a: unknown): a is { name: string; path: string } =>
    typeof a === "object" && a !== null &&
    typeof (a as Record<string, unknown>).name === "string" &&
    typeof (a as Record<string, unknown>).path === "string";

  // ── children: the only in-memory process table ────────────────────────────
  const children = new Map<string, ChildInfo>(); // sessionId → live child
  let stopped = false;

  function killChildrenOfThreads(threadIds: Set<string>): void {
    for (const ch of children.values()) {
      if (!threadIds.has(ch.threadId)) continue;
      try {
        ch.proc.kill(); // SIGTERM; the exit handler cleans up
      } catch {
        /* already dead */
      }
    }
  }

  // ── doctor v2: bin/version + model discovery + auth ───────────────────────
  // Discovery is lazy (first /api/doctor call), parallel across harnesses,
  // 15s per probe, cached until restart; ?refresh=1 re-probes. Failures cache
  // as models:null + a discoveryError string. Never consulted by the spawn
  // path — discovery can never block spawning.
  const discoveryCache = new Map<
    string,
    Promise<{ models: string[] | null; discoveryError?: string }>
  >();
  const authCache = new Map<string, Promise<string | undefined>>();

  function discoverModels(
    profile: HarnessProfile,
    binPath: string,
    env: Record<string, string>,
    refresh: boolean,
  ): Promise<{ models: string[] | null; discoveryError?: string }> {
    if (refresh) discoveryCache.delete(profile.id);
    let pending = discoveryCache.get(profile.id);
    if (!pending) {
      pending = (async () => {
        const d = profile.modelDiscovery!;
        try {
          let stdout: string;
          let stderr = "";
          if (d.kind === "interactive") {
            stdout = await runInteractiveProbe(
              [binPath, ...d.args],
              d.steps({ cwd: stateDir }),
              env,
              stateDir,
              DISCOVERY_TIMEOUT_MS,
            );
          } else {
            const r = await execCapture([binPath, ...d.args], env, stateDir, DISCOVERY_TIMEOUT_MS);
            if (r.timedOut)
              throw new Error(
                `model discovery timed out after ${Math.round(DISCOVERY_TIMEOUT_MS / 1000)}s`,
              );
            const okExit = d.okExit ?? [0];
            if (r.exit === null || !okExit.includes(r.exit))
              throw new Error(
                `probe exited ${r.exit}: ${stripAnsi(r.stderr).trim().slice(0, 300)}`,
              );
            stdout = r.stdout;
            stderr = r.stderr;
          }
          const models = d.parse(stdout, stderr);
          if (models.length === 0) throw new Error("no models in the probe output");
          return { models };
        } catch (e) {
          return {
            models: null,
            discoveryError: e instanceof Error ? e.message : String(e),
          };
        }
      })();
      discoveryCache.set(profile.id, pending);
    }
    return pending;
  }

  function probeAuthCached(
    profile: HarnessProfile,
    binPath: string,
    env: Record<string, string>,
    refresh: boolean,
  ): Promise<string | undefined> {
    if (refresh) authCache.delete(profile.id);
    let pending = authCache.get(profile.id);
    if (!pending) {
      pending = (async () => {
        const a = profile.authProbe!;
        try {
          if (a.kind === "file-keys") {
            const file = a.path(env.HOME ?? "");
            if (!existsSync(file)) return "no credentials file";
            const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
            const keys =
              typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
            return keys.length ? `credentials: ${keys.join(", ")}` : "credentials file empty";
          }
          if (a.kind === "file-exists")
            return existsSync(a.path(env.HOME ?? "")) ? "credentials present" : "no credentials";
          if (a.kind === "exec") {
            const r = await execCapture(
              [binPath, ...a.args], env, stateDir, AUTH_PROBE_TIMEOUT_MS,
            );
            if (r.timedOut) return undefined;
            return a.interpret(r.exit ?? -1, stripAnsi(r.stdout), stripAnsi(r.stderr));
          }
          return undefined; // "discovery" is answered from the discovery result
        } catch {
          return undefined;
        }
      })();
      authCache.set(profile.id, pending);
    }
    return pending;
  }

  function lastFailureFor(
    harness: string,
    state: BoardState,
  ): Record<string, unknown> | undefined {
    const handles = new Set(
      state.roster.filter((r) => r.harness === harness).map((r) => r.handle),
    );
    const latest = state.sessions
      .filter((s) => s.state === "error" && handles.has(s.handle))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0];
    if (!latest) return undefined;
    const post = state.posts
      .filter(
        (p) =>
          p.threadId === latest.threadId &&
          p.author === latest.handle &&
          p.body.startsWith("⚠︎"),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      reason: latest.reason ?? "error",
      at: latest.endedAt ?? latest.startedAt,
      ...(post ? { message: post.body.split("\n")[0].replace(/^⚠︎\s*/, "") } : {}),
    };
  }

  async function doctorReport(refresh: boolean): Promise<Record<string, unknown>> {
    const state = store.getState();
    // The BUILT child env — probes must see what a session child would see,
    // never the host's possibly-polluted env (rule 4).
    const childEnv = buildChildEnv({ shimDir, elan: {}, probed: loginEnv() });
    // Every registry harness (the roster editor's menu) plus any roster-only
    // custom harness ids (reported honestly as unrunnable).
    const ids = new Set([...Object.keys(HARNESSES), ...state.roster.map((r) => r.harness)]);
    const harnesses: Record<string, unknown> = {};
    await Promise.all(
      [...ids].map(async (harness) => {
        const profile: HarnessProfile | undefined = HARNESSES[harness];
        const bin = profile?.bin ?? null;
        const found = bin ? whichOnPath(bin, childEnv.PATH) : null;
        const entry: Record<string, unknown> = {
          bin,
          found: found != null,
          models: null as string[] | null,
        };
        if (profile) entry.displayName = profile.displayName;
        if (found) entry.path = found;
        if (found && probeVersions) {
          const v = probeVersion(found);
          if (v) entry.version = v;
        }
        let discovered: { models: string[] | null; discoveryError?: string } | undefined;
        if (found && profile?.modelDiscovery && probeDiscovery) {
          discovered = await discoverModels(profile, found, childEnv, refresh);
          entry.models = discovered.models;
          if (discovered.discoveryError) entry.discoveryError = discovered.discoveryError;
        }
        if (found && profile?.authProbe && probeDiscovery) {
          const auth =
            profile.authProbe.kind === "discovery"
              ? discovered?.models
                ? "authenticated"
                : undefined
              : await probeAuthCached(profile, found, childEnv, refresh);
          if (auth !== undefined) entry.auth = auth;
        }
        const lastFailure = lastFailureFor(harness, state);
        if (lastFailure) entry.lastFailure = lastFailure;
        harnesses[harness] = entry;
      }),
    );
    return {
      harnesses,
      host: {
        pid: process.pid,
        stateFile,
        uptime: Math.round((Date.now() - bootedAt) / 1000),
      },
    };
  }

  // ── HTTP API ───────────────────────────────────────────────────────────────
  async function handle(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/state") return json(store.getState());
    if (req.method === "GET" && path === "/api/doctor")
      return json(await doctorReport(url.searchParams.get("refresh") === "1"));

    if (req.method === "PUT" && path === "/api/roster") {
      const b = await readBody(req);
      if (!b || !Array.isArray(b.roster))
        return errRes("expected {roster: RosterEntry[]}", 400);
      const roster: RosterEntry[] = [];
      for (const raw of b.roster) {
        if (typeof raw !== "object" || raw === null) continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.handle !== "string" || typeof r.harness !== "string") continue;
        roster.push({
          handle: r.handle,
          harness: r.harness,
          model: typeof r.model === "string" && r.model ? r.model : undefined,
          color: typeof r.color === "string" && r.color ? r.color : "#8b8d98",
        });
      }
      // setRoster enforces the rest: non-empty unique handles, `user` reserved.
      store.setRoster(roster);
      return json({ ok: true });
    }

    const logMatch = path.match(/^\/api\/sessions\/([^/]+)\/log$/);
    if (req.method === "GET" && logMatch) {
      const id = decodeURIComponent(logMatch[1]);
      const record = store.getState().sessions.find((s) => s.id === id);
      const logPath = record?.logPath ?? join(sessionsDir, `${id}.log`);
      if (!existsSync(logPath)) return errRes("no log for this session", 404);
      return new Response(readFileSync(logPath, "utf8"), {
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (req.method === "POST" && path === "/api/projects") {
      const b = await readBody(req);
      if (!b || typeof b.name !== "string" || !b.name || typeof b.repoPath !== "string")
        return errRes("expected {name, repoPath, key?}", 400);
      return json(
        store.createProject({
          name: b.name,
          repoPath: b.repoPath,
          key: typeof b.key === "string" ? b.key : undefined,
          color: typeof b.color === "string" ? b.color : undefined,
          id: typeof b.id === "string" ? b.id : undefined,
        }),
      );
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "DELETE") {
      const id = decodeURIComponent(projectMatch[1]);
      const state = store.getState();
      if (!state.projects.some((p) => p.id === id))
        return errRes("unknown project", 404);
      // Live sessions under this project die first — no orphan children.
      const threadIds = new Set(
        state.threads.filter((t) => t.projectId === id).map((t) => t.id),
      );
      killChildrenOfThreads(threadIds);
      store.deleteProject(id);
      return json({ ok: true });
    }

    if (req.method === "POST" && path === "/api/threads") {
      const b = await readBody(req);
      if (!b || typeof b.projectId !== "string" || typeof b.title !== "string")
        return errRes("expected {projectId, title, body}", 400);
      if (!store.getState().projects.some((p) => p.id === b.projectId))
        return errRes("unknown project", 404);
      return json(
        store.createThread({
          projectId: b.projectId,
          title: b.title,
          body: typeof b.body === "string" ? b.body : "",
          createdBy: typeof b.createdBy === "string" ? b.createdBy : undefined,
          id: typeof b.id === "string" ? b.id : undefined,
        }),
      );
    }

    const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = decodeURIComponent(threadMatch[1]);
      if (!store.getState().threads.some((t) => t.id === id))
        return errRes("unknown thread", 404);
      if (req.method === "DELETE") {
        killChildrenOfThreads(new Set([id]));
        store.deleteThread(id);
        return json({ ok: true });
      }
      const b = await readBody(req);
      if (!b || typeof b.patch !== "object" || b.patch === null || typeof b.actor !== "string")
        return errRes("expected {patch, actor}", 400);
      const p = b.patch as Record<string, unknown>;
      const patch: Partial<
        Pick<Thread, "title" | "body" | "status" | "labels" | "worktreePath">
      > = {};
      if (typeof p.title === "string") patch.title = p.title;
      if (typeof p.body === "string") patch.body = p.body;
      if (typeof p.worktreePath === "string") patch.worktreePath = p.worktreePath;
      if (Array.isArray(p.labels))
        patch.labels = p.labels.filter((l): l is string => typeof l === "string");
      if (p.status !== undefined) {
        if (typeof p.status !== "string" || !VALID_STATUS.has(p.status))
          return errRes(`invalid status ${JSON.stringify(p.status)}`, 400);
        patch.status = p.status as ThreadStatus;
      }
      store.updateThread(id, patch, b.actor);
      return json({ ok: true });
    }

    if (req.method === "POST" && path === "/api/posts") {
      const b = await readBody(req);
      if (
        !b || typeof b.threadId !== "string" || typeof b.author !== "string" ||
        typeof b.body !== "string"
      )
        return errRes("expected {threadId, author, body}", 400);
      if (!store.getState().threads.some((t) => t.id === b.threadId))
        return errRes("unknown thread", 404);
      return json(
        store.addPost({
          threadId: b.threadId,
          author: b.author,
          body: b.body,
          replyTo: typeof b.replyTo === "string" ? b.replyTo : undefined,
          kind: b.kind === "resolution" ? "resolution" : undefined,
          attachments: Array.isArray(b.attachments)
            ? b.attachments.filter(isAttachment)
            : undefined,
          id: typeof b.id === "string" ? b.id : undefined,
        }),
      );
    }

    if (req.method === "POST" && path === "/api/events") {
      const b = await readBody(req);
      if (
        !b || typeof b.threadId !== "string" || typeof b.actor !== "string" ||
        typeof b.type !== "string" || !EVENT_TYPES.has(b.type)
      )
        return errRes("expected {threadId, actor, type, payload?}", 400);
      if (!store.getState().threads.some((t) => t.id === b.threadId))
        return errRes("unknown thread", 404);
      return json(
        store.addEvent({
          threadId: b.threadId,
          actor: b.actor,
          type: b.type as BoardEventType,
          payload:
            typeof b.payload === "object" && b.payload !== null
              ? (b.payload as Record<string, unknown>)
              : {},
        }),
      );
    }

    const ctxMatch = path.match(/^\/api\/thread-context\/([^/]+)$/);
    if (req.method === "GET" && ctxMatch) {
      const id = decodeURIComponent(ctxMatch[1]);
      const state = store.getState();
      if (!state.threads.some((t) => t.id === id)) return errRes("unknown thread", 404);
      const handle = url.searchParams.get("handle") ?? undefined;
      return new Response(renderThreadContext(state, id, handle), {
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const wakeMatch = path.match(/^\/api\/sessions\/([^/]+)\/wake-on$/);
    if (req.method === "POST" && wakeMatch) {
      // Retired with the hot-session model (docs/ORCHESTRATION.md
      // "Wake-on-event — removed"): nothing wakes because nothing ends.
      return errRes("wake-on is gone: sessions are hot; every ping is a turn", 410);
    }

    return errRes("not found", 404);
  }

  const server = Bun.serve({
    port: requestedPort,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/api/subscribe") {
        if (srv.upgrade(req)) {
          say(`[host] GET /api/subscribe → ws`);
          return;
        }
        return errRes("expected a WebSocket upgrade", 426);
      }
      return handle(req, url)
        .then((res) => {
          say(`[host] ${req.method} ${url.pathname} → ${res.status}`);
          return res;
        })
        .catch((e) => {
          console.error(`[host] ${req.method} ${url.pathname} failed:`, e);
          return errRes("internal error", 500);
        });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        sockets.add(ws);
        try {
          ws.send(JSON.stringify({ type: "state", state: store.getState() }));
        } catch {
          sockets.delete(ws);
        }
      },
      close(ws: ServerWebSocket<undefined>) {
        sockets.delete(ws);
      },
      message() {
        /* subscribe-only channel; mutations come over REST */
      },
    },
  });
  const port = server.port ?? requestedPort; // undefined only for unix sockets
  const hostUrl = `http://127.0.0.1:${port}`;

  function broadcast(): void {
    if (sockets.size === 0) return;
    const msg = JSON.stringify({ type: "state", state: store.getState() });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        sockets.delete(ws);
      }
    }
  }

  /** Live telemetry: every captured line of a running session goes out on
   *  the main WS channel (alongside the {type:"state"} pushes) so the UI can
   *  fold it through the harness's stream adapter in real time. Completed
   *  sessions replay via GET /api/sessions/:id/log. */
  function broadcastSessionLine(sessionId: string, stream: "out" | "err", line: string): void {
    if (sockets.size === 0) return;
    const msg = JSON.stringify({ type: "session-line", sessionId, stream, line });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        sockets.delete(ws);
      }
    }
  }

  // ── worktrees ──────────────────────────────────────────────────────────────
  // One per thread under <repo>/.elan/worktrees/<KEY>-<n>, branch elan/<KEY>-<n>.
  // Returns the session cwd; every failure degrades (worktree → repoPath →
  // host cwd) rather than blocking the spawn.
  function ensureWorktree(thread: Thread, handle: string): string {
    const project = store.getState().projects.find((p) => p.id === thread.projectId);
    if (thread.worktreePath && existsSync(thread.worktreePath)) return thread.worktreePath;

    const repo = project?.repoPath;
    if (!repo || !existsSync(repo)) {
      console.error(
        `[host] project repoPath ${repo ?? "(unset)"} does not exist — @${handle} runs in the host cwd`,
      );
      return process.cwd();
    }
    if (Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-dir"]).exitCode !== 0) {
      console.error(`[host] ${repo} is not a git repo — no worktree, cwd = repoPath`);
      return repo;
    }

    // One-time: keep .elan/ out of the repo's history.
    try {
      const gi = join(repo, ".gitignore");
      if (existsSync(gi)) {
        const content = readFileSync(gi, "utf8");
        if (!content.split(/\r?\n/).includes(".elan/"))
          appendFileSync(gi, `${content.endsWith("\n") || content === "" ? "" : "\n"}.elan/\n`);
      } else {
        writeFileSync(gi, ".elan/\n");
      }
    } catch (e) {
      console.error(`[host] could not update ${repo}/.gitignore:`, e);
    }

    const key = `${project.key}-${thread.number}`;
    const wtPath = join(repo, ".elan", "worktrees", key);
    if (!existsSync(wtPath)) {
      mkdirSync(dirname(wtPath), { recursive: true });
      const add = Bun.spawnSync([
        "git", "-C", repo, "worktree", "add", wtPath, "-b", `elan/${key}`,
      ]);
      if (add.exitCode !== 0) {
        // Branch may already exist (prior provision) — retry without -b.
        const retry = Bun.spawnSync([
          "git", "-C", repo, "worktree", "add", wtPath, `elan/${key}`,
        ]);
        if (retry.exitCode !== 0) {
          console.error(
            `[host] worktree add failed for ${key} — cwd falls back to repoPath\n` +
              `${add.stderr.toString().trim()}\n${retry.stderr.toString().trim()}`,
          );
          return repo;
        }
      }
    }
    store.updateThread(thread.id, { worktreePath: wtPath }, handle);
    say(`[host] worktree for ${key}: ${wtPath}`);
    return wtPath;
  }

  // ── session-record bookkeeping (THE invariant lives here) ──────────────────
  const nowMs = () => Date.now();

  /** Find-or-create THE record for (threadId, handle). This is the only
   *  place records are minted (besides the boot migration) — no other code
   *  path may upsert a NEW session record for a pair that has one. */
  function sessionFor(threadId: string, handle: string): AgentSessionRecord {
    const existing = store
      .getState()
      .sessions.find((s) => s.threadId === threadId && s.handle === handle);
    if (existing) return existing;
    const record: AgentSessionRecord = {
      id: crypto.randomUUID(),
      threadId,
      handle,
      state: "queued",
      turns: [],
      queuedAt: nowMs(),
      startedAt: nowMs(),
    };
    store.upsertSession(record);
    return record;
  }

  const currentRecord = (id: string): AgentSessionRecord | undefined =>
    store.getState().sessions.find((s) => s.id === id);

  function patchRecord(
    id: string,
    patch: Partial<AgentSessionRecord>,
  ): AgentSessionRecord | undefined {
    const cur = currentRecord(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    store.upsertSession(next);
    return next;
  }

  /** Append a turn — the durable claim for its tagged event. */
  function appendTurn(recordId: string, turn: Turn): void {
    const cur = currentRecord(recordId);
    if (!cur) return;
    store.upsertSession({ ...cur, turns: [...(cur.turns ?? []), turn] });
  }

  function setTurnState(recordId: string, eventId: string, state: Turn["state"]): void {
    const cur = currentRecord(recordId);
    if (!cur) return;
    store.upsertSession({
      ...cur,
      turns: (cur.turns ?? []).map((t) =>
        t.eventId === eventId ? { ...t, state } : t,
      ),
    });
  }

  /** session-end fires ONLY on turn failure — idling is not an ending. */
  function emitSessionEnd(s: AgentSessionRecord): void {
    store.addEvent({
      threadId: s.threadId,
      actor: s.handle,
      type: "session-end",
      payload: { sessionId: s.id, handle: s.handle, outcome: "error" },
    });
  }

  /** session-start fires once per RECORD, at its first spawn ever. */
  function maybeEmitSessionStart(record: AgentSessionRecord): void {
    const seen = store
      .getState()
      .events.some(
        (e) => e.type === "session-start" && e.payload.sessionId === record.id,
      );
    if (seen) return;
    patchRecord(record.id, { startedAt: nowMs() });
    store.addEvent({
      threadId: record.threadId,
      actor: record.handle,
      type: "session-start",
      payload: { sessionId: record.id, handle: record.handle },
    });
  }

  /** Fail a turn: mark it failed, badge the record, emit session-end(error),
   *  file the extractor-led ⚠︎ post. The badge NEVER gates the loop — the
   *  next ping still runs (a timeout leaves the record idle outright). */
  function failTurn(
    record: AgentSessionRecord,
    turn: Turn,
    reason: string,
    postBody: string | undefined,
    extra: Partial<AgentSessionRecord> = {},
  ): void {
    setTurnState(record.id, turn.eventId, "failed");
    patchRecord(record.id, {
      state: reason === "timeout" ? "idle" : "error",
      reason,
      endedAt: nowMs(),
      ...extra,
    });
    emitSessionEnd(record);
    if (postBody)
      store.addPost({
        threadId: record.threadId,
        author: record.handle,
        body: postBody,
        // Host-authored text (which may embed extractor/stderr output) must
        // never summon anyone.
        suppressTags: true,
      });
    console.error(`[host] @${record.handle} turn failed (${reason})`);
  }

  /** Complete a turn: done + idle (the error badge clears). Silent-success
   *  fallback per turn: a turn that spoke only in its stream gets its final
   *  message posted on its behalf, mentions suppressed. */
  function completeTurn(
    record: AgentSessionRecord,
    turn: Turn,
    streamText: string | undefined,
    turnStartedAt: number,
    extra: Partial<AgentSessionRecord> = {},
  ): void {
    setTurnState(record.id, turn.eventId, "done");
    patchRecord(record.id, { state: "idle", reason: undefined, ...extra });
    const st = store.getState();
    const spoke =
      st.posts.some(
        (p) =>
          p.threadId === record.threadId &&
          p.author === record.handle &&
          p.createdAt >= turnStartedAt,
      ) ||
      st.events.some(
        (e) =>
          e.threadId === record.threadId &&
          e.actor === record.handle &&
          e.at >= turnStartedAt &&
          e.type !== "session-start" &&
          e.type !== "session-end",
      );
    if (!spoke && streamText?.trim()) {
      store.addPost({
        threadId: record.threadId,
        author: record.handle,
        body: streamText.trim(),
        suppressTags: true, // a ventriloquized post must never summon anyone
      });
      say(`[host] @${record.handle} never used elan this turn — posted its final message`);
    }
    say(`[host] @${record.handle} turn done`);
  }

  // ── transcript log ─────────────────────────────────────────────────────────
  function logLine(logPath: string, channel: "out" | "err", line: string): void {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${channel}] ${line}\n`);
    } catch {
      /* the transcript is best-effort */
    }
  }

  // ── the reconciler + the per-record turn loop ("Hot sessions") ─────────────
  // One level-triggered loop: every store mutation and a 2s tick both just
  // schedule a pass. A pass (a) claims every unhandled tagged event as a
  // turn, (b) enforces the per-TURN timeout, (c) kicks the per-record drain
  // loops. The reconciler NEVER spawns directly — the drain loop is the only
  // spawner, and at most one loop runs per record at a time, so two children
  // for one (thread, handle) is impossible by construction.

  /** The triggering post, verbatim — what a turn prompt leads with. */
  function describeTrigger(ev: BoardEvent, state: BoardState): string {
    const post = state.posts.find(
      (p) => p.threadId === ev.threadId && p.author === ev.actor && p.createdAt === ev.at,
    );
    return `Pinged by ${ev.actor}${post ? `: ${post.body}` : ""}`;
  }

  /** First turn (or any fresh conversation): the full rendered thread with
   *  the triggering ping highlighted. Later turns: the ping verbatim plus
   *  one pointer line — the harness conversation already has the context. */
  function buildTurnPrompt(
    state: BoardState,
    record: AgentSessionRecord,
    turn: Turn,
    full: boolean,
  ): string {
    const ev = state.events.find((e) => e.id === turn.eventId);
    const trigger = ev ? describeTrigger(ev, state) : "Pinged on this thread.";
    if (!full) return `${trigger}\n(run \`elan thread\` for current context)`;
    const context = renderThreadContext(state, record.threadId, record.handle);
    return `${context}\n${TURN_PING_SEPARATOR}\n\n${trigger}\n`;
  }

  /** Turn claims in this thread inside the rolling budget window. Budget
   *  drops themselves are excluded via an in-memory cache — after a restart
   *  the breaker is briefly conservative, never wrong. */
  const budgetDropped = new Set<string>();
  function threadTurnCount(threadId: string, now: number): number {
    let n = 0;
    for (const s of store.getState().sessions) {
      if (s.threadId !== threadId) continue;
      for (const t of s.turns ?? [])
        if (t.at > now - BUDGET_WINDOW_MS && !budgetDropped.has(t.eventId)) n++;
    }
    return n;
  }

  /** Quiet claims (stale/budget) can leave a fresh record with nothing
   *  pending — settle it to idle so nothing dangles in "queued". */
  function settleIfNothingPending(recordId: string): void {
    const cur = currentRecord(recordId);
    if (!cur) return;
    if (cur.state === "queued" && !(cur.turns ?? []).some((t) => t.state === "pending"))
      patchRecord(recordId, { state: "idle" });
  }

  function budgetDrop(ev: BoardEvent, record: AgentSessionRecord): void {
    // The mention-loop breaker (rule 5): the failed turn keeps the tag from
    // ever being re-examined; the post tells the humans why nothing ran.
    budgetDropped.add(ev.id);
    appendTurn(record.id, { eventId: ev.id, state: "failed", at: nowMs() });
    settleIfNothingPending(record.id);
    store.addPost({
      threadId: ev.threadId,
      author: record.handle,
      body:
        `⚠︎ turn budget exceeded (agent mention loop?) — dropped this @${record.handle} ping. ` +
        `Limit: ${threadBudget} turns per ${Math.round(BUDGET_WINDOW_MS / 60_000)} min per thread.`,
      suppressTags: true,
    });
    console.error(`[host] thread ${ev.threadId} over turn budget — dropped @${record.handle} ping`);
  }

  /** (a) Claim every unhandled tagged event as a turn on THE record for its
   *  (thread, handle) — the turn IS the durable claim. An event is handled
   *  iff some record's turns[] carries it (or a legacy triggerEventId
   *  equals it). */
  function claimTags(now: number): void {
    // Snapshot the ids up front; re-read fresh state per event because each
    // claim mutates the store.
    const eventIds = store.getState().events.filter((e) => e.type === "tagged").map((e) => e.id);
    for (const evId of eventIds) {
      const state = store.getState();
      const handled = state.sessions.some(
        (s) => s.triggerEventId === evId || (s.turns ?? []).some((t) => t.eventId === evId),
      );
      if (handled) continue;
      const ev = state.events.find((e) => e.id === evId);
      if (!ev) continue; // thread deleted mid-pass
      const handle = String(ev.payload.handle ?? "") || "unknown";
      const record = sessionFor(ev.threadId, handle);

      if (now - ev.at > STALE_TAG_MS) {
        // Restart archaeology: never run on day-old intent. Claimed as a
        // done turn; one log line, no post spam, no spawn.
        appendTurn(record.id, { eventId: evId, state: "done", at: now });
        settleIfNothingPending(record.id);
        say(
          `[host] tag ${evId} (@${handle}) is ${Math.round((now - ev.at) / 3_600_000)}h old — claimed as done, no turn`,
        );
        continue;
      }

      if (!state.roster.some((r) => r.handle === handle)) {
        // Unknown handle: the claim is a done turn on THE record for the
        // pair (reused on repeat tags — never a second record), the state
        // an error badge, the post honest.
        appendTurn(record.id, { eventId: evId, state: "done", at: now });
        patchRecord(record.id, { state: "error", reason: "unknown-handle", endedAt: now });
        store.addPost({
          threadId: ev.threadId,
          author: handle,
          body: `⚠︎ @${handle} isn't on the roster — nothing ran for this ping.`,
          suppressTags: true,
        });
        console.error(`[host] tagged unknown handle @${handle} — claimed, nothing runs`);
        continue;
      }

      if (threadBudget > 0 && threadTurnCount(ev.threadId, now) >= threadBudget) {
        budgetDrop(ev, record);
        continue;
      }

      appendTurn(record.id, { eventId: evId, state: "pending", at: now });
      say(`[host] queued a turn for @${handle}: tag ${evId}`);
    }
  }

  /** (b) Per-TURN timeout: SIGTERM → 10s → SIGKILL, in-flight turns only.
   *  A hot idle child is NEVER killed for idling. */
  function enforceTimeouts(now: number): void {
    for (const ch of children.values()) {
      const flight = ch.turn;
      if (!flight) continue; // idle resident child — exempt, forever
      if (flight.killedAt != null) {
        if (now - flight.killedAt > KILL_GRACE_MS) {
          try {
            ch.proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
        continue;
      }
      if (now - flight.startedAt > sessionTimeoutMs) {
        flight.timedOut = true;
        flight.killedAt = now;
        console.error(
          `[host] @${ch.handle}'s turn over ${sessionTimeoutMs}ms — SIGTERM (the record stays hot)`,
        );
        try {
          ch.proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }

  /** (c) Kick a drain loop for every record with pending turns. The Set is
   *  the per-record lock: at most one loop per record; turns run strictly
   *  sequentially inside it. Scheduling is idempotent, so concurrent
   *  reconciler passes are safe. */
  const turnLoopActive = new Set<string>();
  function scheduleTurns(): void {
    for (const s of store.getState().sessions) {
      if (turnLoopActive.has(s.id)) continue;
      if (!(s.turns ?? []).some((t) => t.state === "pending")) continue;
      // Concurrency (rule 5): a record with no live child needs a slot.
      if (!children.has(s.id) && children.size >= maxSessions) continue;
      turnLoopActive.add(s.id);
      void drainTurns(s.id)
        .catch((e) => console.error(`[host] turn loop for ${s.id} failed:`, e))
        .finally(() => {
          turnLoopActive.delete(s.id);
          reconcile(); // turns may have queued behind the loop
        });
    }
  }

  async function drainTurns(recordId: string): Promise<void> {
    for (;;) {
      if (stopped) return;
      const record = currentRecord(recordId);
      if (!record) return; // thread/project deleted
      const turn = (record.turns ?? []).find((t) => t.state === "pending");
      if (!turn) return;
      if (!children.has(recordId) && children.size >= maxSessions) return; // wait for a slot
      await runTurn(record, turn);
    }
  }

  async function runTurn(record: AgentSessionRecord, turn: Turn): Promise<void> {
    const state = store.getState();
    if (!state.threads.some((t) => t.id === record.threadId)) {
      setTurnState(record.id, turn.eventId, "failed"); // thread gone — pure defense
      return;
    }
    const entry = state.roster.find((r) => r.handle === record.handle);
    if (!entry) {
      failTurn(record, turn, "runner-not-found", `⚠︎ Can't run @${record.handle}: not on the roster.`);
      return;
    }
    const profile: HarnessProfile | undefined = HARNESSES[entry.harness];
    if (!profile) {
      failTurn(
        record,
        turn,
        "runner-not-found",
        `⚠︎ Can't start: no runner for harness \`${entry.harness}\` (@${record.handle}).`,
      );
      return;
    }
    try {
      if (profile.residency) await runResidentTurn(record, turn, entry, profile);
      else await runSerializedTurn(record, turn, entry, profile);
    } catch (e) {
      console.error(`[host] turn crashed for @${record.handle}:`, e);
      const cur = currentRecord(record.id);
      if (cur && (cur.turns ?? []).some((t) => t.eventId === turn.eventId && t.state === "pending"))
        failTurn(cur, turn, "spawn-failed", `⚠︎ Can't run @${record.handle}: ${String(e)}`);
    }
  }

  // ── spawn plumbing shared by resident and serialized turns ─────────────────

  /** Preflight (rule 6): the CHILD's env and PATH, the worktree cwd. */
  function preflight(
    record: AgentSessionRecord,
    profile: HarnessProfile,
  ): { binPath: string; cwd: string; env: Record<string, string> } | { reason: string; error: string } {
    const state = store.getState();
    const thread = state.threads.find((t) => t.id === record.threadId);
    if (!thread) return { reason: "spawn-failed", error: "the thread is gone" };
    const env = buildChildEnv({
      shimDir,
      probed: loginEnv(),
      elan: {
        ELAN_URL: hostUrl,
        ELAN_THREAD: record.threadId,
        ELAN_AGENT: record.handle,
        ELAN_SESSION: record.id, // the RECORD id, stable across every turn
      },
    });
    const binPath = whichOnPath(profile.bin, env.PATH);
    if (!binPath)
      return {
        reason: "runner-not-found",
        error:
          `\`${profile.bin}\` not found on the session PATH ` +
          `(built from the login-shell probe plus fallback dirs).`,
      };
    const cwd = ensureWorktree(thread, record.handle);
    return { binPath, cwd, env };
  }

  function makeFlight(eventId: string): {
    flight: TurnFlight;
    settled: Promise<{ kind: "turn-end" } | { kind: "exit"; code: number }>;
  } {
    let resolveFn!: (r: { kind: "turn-end" } | { kind: "exit"; code: number }) => void;
    const settled = new Promise<{ kind: "turn-end" } | { kind: "exit"; code: number }>(
      (resolve) => {
        resolveFn = resolve;
      },
    );
    const flight: TurnFlight = {
      eventId,
      startedAt: nowMs(),
      lines: [],
      settled: false,
      settle(result) {
        if (flight.settled) return;
        flight.settled = true;
        resolveFn(result);
      },
    };
    return { flight, settled };
  }

  /** Pumps + exit handling shared by both child kinds. Stdout: tolerant
   *  JSONL, logged + broadcast live, collected per-FLIGHT for extraction;
   *  capture-strategy harnesses surface their native session id here. */
  function wireChild(ch: ChildInfo, profile: HarnessProfile): void {
    const capture =
      profile.sessionId?.mode === "capture" ? profile.sessionId.capture : undefined;
    const isTurnEnd = profile.residency?.isTurnEnd;
    void pumpLines(ch.proc.stdout, (line) => {
      logLine(ch.logPath, "out", line);
      broadcastSessionLine(ch.recordId, "out", line);
      const flight = ch.turn;
      if (flight) {
        flight.lines.push(line);
        if (flight.lines.length > 2_000) flight.lines.splice(0, flight.lines.length - 2_000);
      }
      const msg = parseLine(line);
      if (!msg) return;
      ch.jsonEvents++;
      if (capture) {
        const sid = capture(msg);
        if (typeof sid === "string" && sid) {
          const cur = currentRecord(ch.recordId);
          if (cur && cur.harnessSessionId !== sid)
            store.upsertSession({ ...cur, harnessSessionId: sid });
        }
      }
      if (isTurnEnd?.(msg)) ch.turn?.settle({ kind: "turn-end" });
    });
    void pumpLines(ch.proc.stderr, (line) => {
      logLine(ch.logPath, "err", line);
      broadcastSessionLine(ch.recordId, "err", line);
      ch.stderrRaw = (ch.stderrRaw + line + "\n").slice(-8_000);
    });
    void ch.proc.exited.then((code) => {
      if (children.get(ch.recordId) === ch) children.delete(ch.recordId);
      const c = typeof code === "number" ? code : -1;
      if (ch.turn) {
        // Mid-turn death — the awaiting turn runner owns the outcome.
        ch.turn.settle({ kind: "exit", code: c });
      } else if (!stopped) {
        // Idle death: resurrection material, never an ending. The record
        // stays idle; harnessSessionId is the continuity.
        patchRecord(ch.recordId, { procKey: undefined, exitCode: c });
        say(
          `[host] @${ch.handle}'s resident child exited while idle (code ${c}) — the next ping resurrects it`,
        );
      }
      if (!stopped) reconcile(); // a slot freed
    });
  }

  // ── resident turns (claude-code, pi, mock) ─────────────────────────────────

  /** Spawn (or resurrect) the ONE resident child for a record. */
  function spawnResident(
    record: AgentSessionRecord,
    entry: RosterEntry,
    profile: HarnessProfile,
    resume: string | undefined,
  ): { ok: true; child: ChildInfo } | { ok: false; reason: string; error: string } {
    const pre = preflight(record, profile);
    if ("error" in pre) return { ok: false, reason: pre.reason, error: pre.error };
    const argv = profile.residency!.argv({
      binPath: pre.binPath,
      instructions: shortInstructions(entry.handle),
      model: entry.model,
      resume,
    });
    const logPath = record.logPath ?? join(sessionsDir, `${record.id}.log`);
    patchRecord(record.id, { state: "spawning", logPath });
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(argv, {
        cwd: pre.cwd,
        env: pre.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return { ok: false, reason: "spawn-failed", error: `can't start \`${argv[0]}\`: ${String(e)}` };
    }
    const ch: ChildInfo = {
      proc,
      stdin: proc.stdin,
      recordId: record.id,
      threadId: record.threadId,
      handle: record.handle,
      harness: entry.harness,
      extract: profile.extract,
      resident: true,
      isResume: !!resume,
      spawnedAt: nowMs(),
      jsonEvents: 0,
      stderrRaw: "",
      logPath,
    };
    children.set(record.id, ch);
    maybeEmitSessionStart(record);
    patchRecord(record.id, {
      state: "running",
      procKey: String(proc.pid),
      logPath,
      exitCode: undefined,
      wakeOn: undefined,
    });
    say(
      `[host] @${record.handle} resident child up (pid ${proc.pid}, cwd ${pre.cwd}${resume ? ", resume" : ""})`,
    );
    wireChild(ch, profile);
    return { ok: true, child: ch };
  }

  async function runResidentTurn(
    record: AgentSessionRecord,
    turn: Turn,
    entry: RosterEntry,
    profile: HarnessProfile,
  ): Promise<void> {
    const first = await attemptResidentTurn(record, turn, entry, profile, true);
    if (first !== "resume-fell-back") return;
    // A resumed resident that died instantly without a single stream event
    // is a broken --resume (expired harness session etc.) — fall back ONCE
    // to a fresh resident with full context. Clearing harnessSessionId
    // makes the retry fresh, so this can never loop.
    patchRecord(record.id, { harnessSessionId: undefined, reason: "resume-fell-back" });
    say(`[host] @${record.handle} resume died instantly — one fresh resident with full context`);
    const cur = currentRecord(record.id);
    if (!cur) return;
    await attemptResidentTurn(cur, turn, entry, profile, false);
  }

  async function attemptResidentTurn(
    record: AgentSessionRecord,
    turn: Turn,
    entry: RosterEntry,
    profile: HarnessProfile,
    allowResume: boolean,
  ): Promise<"settled" | "resume-fell-back"> {
    let ch = children.get(record.id);
    let fullContext = false;
    if (!ch) {
      const rec0 = currentRecord(record.id) ?? record;
      const resume = allowResume && rec0.harnessSessionId ? rec0.harnessSessionId : undefined;
      const spawned = spawnResident(rec0, entry, profile, resume);
      if (!spawned.ok) {
        failTurn(rec0, turn, spawned.reason, `⚠︎ Can't start @${record.handle}: ${spawned.error}`, {
          procKey: undefined,
        });
        return "settled";
      }
      ch = spawned.child;
      fullContext = !resume; // a fresh conversation needs the whole thread
    }

    const rec = currentRecord(record.id);
    if (!rec) return "settled";
    const turnNo = (rec.turns ?? []).findIndex((t) => t.eventId === turn.eventId) + 1;
    const prompt = buildTurnPrompt(store.getState(), rec, turn, fullContext);
    const { flight, settled } = makeFlight(turn.eventId);
    ch.turn = flight;
    patchRecord(record.id, { state: "running" });
    try {
      ch.stdin!.write(profile.residency!.encodeTurn(prompt, turnNo) + "\n");
      await ch.stdin!.flush();
    } catch {
      // The child died under us — its exit handler settles the flight.
    }
    const result = await settled;
    ch.turn = undefined;
    if (stopped) return "settled";
    const cur = currentRecord(record.id);
    if (!cur) return "settled"; // thread deleted mid-turn
    const stderrTail = stripAnsi(ch.stderrRaw).slice(-1_000).trim();
    const fence = stderrTail ? `\n\`\`\`\n${stderrTail}\n\`\`\`` : "";

    if (result.kind === "turn-end") {
      const outcome = extractOutcome(ch.extract, flight.lines, 0);
      if (outcome.ok) completeTurn(cur, turn, outcome.text, flight.startedAt);
      else
        failTurn(cur, turn, "error-result", `⚠︎ ${outcome.text || "The turn reported an error."}${fence}`);
      return "settled";
    }

    // The child exited mid-turn.
    if (flight.timedOut) {
      failTurn(
        cur,
        turn,
        "timeout",
        `⚠︎ Turn timed out after ${Math.round(sessionTimeoutMs / 60_000)} min and its child was ` +
          `killed. The session stays hot — ping @${record.handle} again to retry.${fence}`,
        { exitCode: result.code, procKey: undefined },
      );
      return "settled";
    }
    if (
      ch.isResume &&
      result.code !== 0 &&
      nowMs() - ch.spawnedAt < RESUME_FALLBACK_WINDOW_MS &&
      ch.jsonEvents === 0
    )
      return "resume-fell-back";
    const outcome = extractOutcome(ch.extract, flight.lines, result.code);
    if (outcome.ok)
      completeTurn(cur, turn, outcome.text, flight.startedAt, {
        exitCode: result.code,
        procKey: undefined,
      });
    else
      failTurn(
        cur,
        turn,
        result.code !== 0 ? "nonzero-exit" : "error-result",
        `⚠︎ ${outcome.text || `The child exited with code ${result.code} mid-turn.`}${fence}`,
        { exitCode: result.code, procKey: undefined },
      );
    return "settled";
  }

  // ── serialized turns (cursor, grok, opencode + fresh codex/devin/pool) ─────

  async function runSerializedTurn(
    record: AgentSessionRecord,
    turn: Turn,
    entry: RosterEntry,
    profile: HarnessProfile,
  ): Promise<void> {
    const first = await attemptSerializedTurn(record, turn, entry, profile, true);
    if (first !== "resume-fell-back") return;
    patchRecord(record.id, { harnessSessionId: undefined, reason: "resume-fell-back" });
    say(`[host] @${record.handle} resume died instantly — one fresh turn with full context`);
    const cur = currentRecord(record.id);
    if (!cur) return;
    await attemptSerializedTurn(cur, turn, entry, profile, false);
  }

  async function attemptSerializedTurn(
    record: AgentSessionRecord,
    turn: Turn,
    entry: RosterEntry,
    profile: HarnessProfile,
    allowResume: boolean,
  ): Promise<"settled" | "resume-fell-back"> {
    const rec0 = currentRecord(record.id) ?? record;
    if (!profile.runner) {
      failTurn(
        rec0,
        turn,
        "runner-not-found",
        `⚠︎ Can't start: no runner for harness \`${entry.harness}\` (@${record.handle}).`,
      );
      return "settled";
    }
    const pre = preflight(rec0, profile);
    if ("error" in pre) {
      failTurn(rec0, turn, pre.reason, `⚠︎ Can't start @${record.handle}: ${pre.error}`);
      return "settled";
    }
    const isResume = allowResume && profile.sessionId != null && !!rec0.harnessSessionId;
    // Mint-strategy harnesses (grok's create-or-resume `-s`) get ONE id per
    // record, minted at the first turn and re-passed forever after.
    let harnessSessionId = rec0.harnessSessionId;
    if (profile.sessionId?.mode === "mint" && !harnessSessionId)
      harnessSessionId = crypto.randomUUID();
    // Continuity harnesses get the short prompt once a conversation exists;
    // fresh-only harnesses (codex/devin/pool) get full context every turn.
    const prompt = buildTurnPrompt(store.getState(), rec0, turn, !isResume);
    const spec = profile.runner({
      binPath: pre.binPath,
      cwd: pre.cwd,
      prompt,
      instructions: shortInstructions(entry.handle),
      model: entry.model,
      sessionId: record.id,
      sessionDir: sessionsDir,
      resume: isResume ? { harnessSessionId: rec0.harnessSessionId! } : undefined,
      harnessSessionId,
    });
    if (!("argv" in spec)) {
      failTurn(rec0, turn, "spawn-failed", `⚠︎ Can't start @${record.handle}: ${spec.error}`);
      return "settled";
    }
    for (const f of spec.files ?? []) writeFileSync(f.path, f.content);

    const logPath = rec0.logPath ?? join(sessionsDir, `${record.id}.log`);
    patchRecord(record.id, { state: "spawning", logPath, harnessSessionId });
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(spec.argv, {
        cwd: pre.cwd,
        env: { ...pre.env, ...spec.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      failTurn(rec0, turn, "spawn-failed", `⚠︎ Can't start \`${spec.argv[0]}\`: ${String(e)}`, {
        logPath,
      });
      return "settled";
    }
    const { flight, settled } = makeFlight(turn.eventId);
    const ch: ChildInfo = {
      proc,
      recordId: record.id,
      threadId: record.threadId,
      handle: record.handle,
      harness: entry.harness,
      extract: profile.extract,
      resident: false,
      isResume,
      spawnedAt: nowMs(),
      jsonEvents: 0,
      stderrRaw: "",
      logPath,
      turn: flight,
    };
    children.set(record.id, ch);
    maybeEmitSessionStart(rec0);
    patchRecord(record.id, {
      state: "running",
      procKey: String(proc.pid),
      logPath,
      exitCode: undefined,
      wakeOn: undefined,
    });
    say(
      `[host] @${record.handle} turn running (pid ${proc.pid}, cwd ${pre.cwd}${isResume ? ", resume" : ""})`,
    );
    wireChild(ch, profile);

    const result = await settled; // serialized turns settle by exit only
    ch.turn = undefined;
    if (stopped || result.kind !== "exit") return "settled";
    const cur = currentRecord(record.id);
    if (!cur) return "settled";
    const stderrTail = stripAnsi(ch.stderrRaw).slice(-1_000).trim();
    const fence = stderrTail ? `\n\`\`\`\n${stderrTail}\n\`\`\`` : "";
    if (flight.timedOut) {
      failTurn(
        cur,
        turn,
        "timeout",
        `⚠︎ Turn timed out after ${Math.round(sessionTimeoutMs / 60_000)} min and was killed. ` +
          `The session stays hot — ping @${record.handle} again to retry.${fence}`,
        { exitCode: result.code, procKey: undefined },
      );
      return "settled";
    }
    if (
      isResume &&
      result.code !== 0 &&
      nowMs() - ch.spawnedAt < RESUME_FALLBACK_WINDOW_MS &&
      ch.jsonEvents === 0
    )
      return "resume-fell-back";
    const outcome = extractOutcome(ch.extract, flight.lines, result.code);
    if (outcome.ok)
      completeTurn(cur, turn, outcome.text, flight.startedAt, {
        exitCode: result.code,
        procKey: undefined,
      });
    else
      failTurn(
        cur,
        turn,
        result.code !== 0 ? "nonzero-exit" : "error-result",
        `⚠︎ ${outcome.text || `Turn exited with code ${result.code}.`}${fence}`,
        { exitCode: result.code, procKey: undefined },
      );
    return "settled";
  }
  // Re-entrancy guard: mutations made inside a pass re-enter subscribe →
  // request another pass instead of recursing; every pass is idempotent
  // because all work is re-derived from state.
  let inPass = false;
  let passPending = false;
  function reconcile(): void {
    if (stopped) return;
    if (inPass) {
      passPending = true;
      return;
    }
    inPass = true;
    try {
      do {
        passPending = false;
        const now = nowMs();
        try {
          claimTags(now);
          enforceTimeouts(now);
          scheduleTurns();
        } catch (e) {
          console.error("[host] reconciler pass failed:", e);
        }
      } while (passPending);
    } finally {
      inPass = false;
    }
  }

  // No orphan sweep here: the boot migration already normalized
  // spawning/running records (no child survives a restart) to idle with the
  // interrupted turn failed — NOT an error; the next ping simply runs a turn.

  const unsubscribe = store.subscribe(() => {
    broadcast();
    reconcile();
  });
  const tick = setInterval(reconcile, RECONCILE_TICK_MS);

  // ── boot log ───────────────────────────────────────────────────────────────
  say(`[host] elan host on ${hostUrl}`);
  say(`[host] state file: ${stateFile}`);
  say(`[host] elan shim:  ${shimPath}`);
  say(
    `[host] limits: ${maxSessions} concurrent, ${threadBudget > 0 ? threadBudget : "uncapped"} turns/${Math.round(
      BUDGET_WINDOW_MS / 60_000,
    )}min/thread, ${Math.round(sessionTimeoutMs / 60_000)}min per-turn timeout`,
  );

  reconcile(); // pick up pending turns / unclaimed tags persisted before the restart

  return {
    port,
    url: hostUrl,
    store,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearInterval(tick);
      for (const ch of children.values()) {
        try {
          ch.proc.kill(); // SIGTERM; all children die with the host (rule 5)
        } catch {
          /* already dead */
        }
      }
      children.clear();
      server.stop(true);
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      flush();
    },
  };
}

// ── auto-start (bun dev/elan-host.ts) ───────────────────────────────────────
if (import.meta.main) {
  const host = startHost();
  // Ctrl-C must reap child sessions and flush the debounced persist (rule 8).
  const shutdown = () => {
    host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
