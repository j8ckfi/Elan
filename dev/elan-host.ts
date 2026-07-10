// The Elan host: one process that owns BoardState, serves it to UI clients
// (REST + WS full-state push), and runs the tag→spawn orchestrator — all on
// the same createBoardStore rules module the browser store uses, persisted to
// `${ELAN_STATE_DIR}/board.json` instead of localStorage. Run with:
//
//   bun dev/elan-host.ts          # port 4519, state in ./.elan/
//
// Config via env: ELAN_HOST_PORT (4519), ELAN_STATE_DIR (./.elan),
// ELAN_MAX_SESSIONS (4), ELAN_SESSION_TIMEOUT_MS (30 min),
// ELAN_THREAD_BUDGET (8 starts / rolling 10 min), ELAN_SPAWN_ENV_EXTRA
// (comma-separated var names forwarded to children). The contract is
// docs/ORCHESTRATION.md — the "Durability architecture" section especially;
// tests boot this in-process via startHost() (auto-start only under
// import.meta.main).
//
// Durability rules implemented here (docs/ORCHESTRATION.md):
//   1. Durable intent — work IS session records; a tagged event is handled
//      iff a session carries its id in triggerEventId. No in-memory set is
//      ever correctness.
//   2. A reconciler, not a reactor — one level-triggered loop (every store
//      mutation + a 2s tick) converges actual toward desired state.
//   3. The stream is the signal — per-harness outcome extractors over the
//      captured stdout JSONL lead every failure post; the ANSI-stripped
//      stderr tail is secondary. Full transcript → .elan/sessions/<id>.log.
//   4. Environment is built, not inherited — login-shell probe, strip-list,
//      shim-first PATH with static fallbacks, TERM=dumb, our ELAN_*.
//   5. Limits — ELAN_MAX_SESSIONS concurrent, per-thread start budget,
//      ELAN_SESSION_TIMEOUT_MS with SIGTERM → 10s → SIGKILL.
//   6. Preflight before spawn — runner binary resolved on the CHILD's PATH;
//      GET /api/doctor (v2) reports per-harness bin/found/path/version/auth/
//      models/discoveryError/lastFailure — model discovery runs lazily off
//      doctor with per-probe 15s timeouts, cached until restart (?refresh=1).
//   7. Runner correctness — one declarative HARNESSES registry row per CLI
//      (claude-code, codex, pi, opencode, cursor, devin, pool, grok, mock):
//      argv shape, instructions injection (native append flag vs prepended
//      under a "── thread context ──" separator), session-id strategy
//      (capture/mint/none), model discovery, auth probe, outcome extractor.
//      An instantly-dying resume falls back once to a fresh spawn.
//
// Telemetry: every captured stdout/stderr line of a live session ALSO goes
// out on the main WS channel as {type:"session-line", sessionId, stream,
// line}; completed sessions replay via GET /api/sessions/:id/log.
// Roster mutation: PUT /api/roster {roster} → store.setRoster.

import type { ServerWebSocket, Subprocess } from "bun";
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

/** Session records minted only to absorb a tagged event (never a spawn
 *  attempt) — excluded from the per-thread start budget. */
const NON_START_REASONS = new Set([
  "budget-exceeded", "stale-skipped", "absorbed-by-live-session", "unknown-handle",
  "superseded-by-wake",
]);

function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

export interface HarnessProfile {
  /** The roster's `harness` value. */
  id: string;
  displayName: string;
  /** Executable resolved on the CHILD PATH (preflight + doctor). */
  bin: string;
  runner(ctx: RunnerCtx): RunnerSpec | { error: string };
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
    runner(ctx) {
      if (ctx.resume) {
        // Resume drops the full context: the harness session has it; only
        // the wake trigger rides the prompt.
        return {
          argv: [
            ctx.binPath, "-p", ctx.prompt, "--output-format", "stream-json",
            "--verbose", "--resume", ctx.resume.harnessSessionId,
            // Non-interactive -p auto-denies tool permissions, which would
            // make the elan CLI unreachable. Autonomy in an isolated
            // worktree is the product premise; the board is the oversight.
            "--permission-mode", "bypassPermissions",
            ...(ctx.model ? ["--model", ctx.model] : []),
          ],
        };
      }
      return {
        argv: [
          ctx.binPath, "-p", ctx.prompt, "--output-format", "stream-json",
          // stream-json in -p mode refuses to run without --verbose.
          "--verbose",
          "--permission-mode", "bypassPermissions",
          ...(ctx.model ? ["--model", ctx.model] : []),
          "--append-system-prompt", ctx.instructions,
        ],
      };
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
    runner(ctx) {
      if (ctx.resume) {
        return {
          argv: [
            ctx.binPath, "-p", ctx.prompt, "--mode", "json",
            "--session-id", ctx.resume.harnessSessionId,
            ...(ctx.model ? ["--model", ctx.model] : []),
          ],
        };
      }
      return {
        argv: [
          ctx.binPath, "-p", ctx.prompt, "--mode", "json",
          ...(ctx.model ? ["--model", ctx.model] : []),
          "--append-system-prompt", ctx.instructions,
        ],
      };
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
    extract: "raw",
    sessionId: null,
    runner(ctx) {
      const env: Record<string, string> = { ELAN_CONTEXT: ctx.prompt };
      // Deliberate forward: the wake test flips the mock's mode via the
      // host process env, which the built child env would otherwise drop.
      if (process.env.ELAN_MOCK_WAKE) env.ELAN_MOCK_WAKE = process.env.ELAN_MOCK_WAKE;
      return { argv: [ctx.binPath, MOCK_AGENT_PATH], env };
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
| wake-me | \`elan wake-me --on <@handle-done/post>\` — end this session now, resume on the event |
| wait | \`elan wait --on <…>\` — alias of wake-me |`;

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

/** The one-liner injected as claude-code's --append-system-prompt. */
function shortInstructions(handle: string): string {
  return (
    `You are @${handle} on an Elan board thread. Act on the board ONLY via the ` +
    "`elan` CLI on your PATH (elan post/reply/resolve/attach/status/thread/read/" +
    "wake-me — run `elan help`). The repo's own policy files (AGENTS.md etc.) " +
    "govern process. When done, move the thread status and mention whoever " +
    "policy says acts next."
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
  /** Overrides ELAN_THREAD_BUDGET (default 8 starts / rolling 10 min). */
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

/** In-memory bookkeeping for one live child — a cache around the process
 *  handle, never correctness (the session record is). */
interface ChildInfo {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  threadId: string;
  handle: string;
  harness: string;
  /** Which outcome extractor folds this child's stdout (from the registry). */
  extract: ExtractorKind;
  isResume: boolean;
  spawnedAt: number;
  stdoutLines: string[];
  jsonEvents: number;
  stderrRaw: string;
  logPath: string;
  timedOut: boolean;
  killedAt?: number;
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
  const threadBudget = opts.threadBudget ?? intEnv(process.env.ELAN_THREAD_BUDGET, 8);
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
      const id = decodeURIComponent(wakeMatch[1]);
      const session = store.getState().sessions.find((s) => s.id === id);
      if (!session) return errRes("unknown session", 404);
      const b = await readBody(req);
      const event = b?.event;
      if (event !== "session-end" && event !== "post")
        return errRes('expected {event: "session-end" | "post", handle?}', 400);
      if (event === "session-end" && typeof b?.handle !== "string")
        return errRes('{event: "session-end"} needs a handle', 400);
      const wakeOn: AgentSessionRecord["wakeOn"] =
        event === "post"
          ? { event: "post" }
          : { event: "session-end", handle: b!.handle as string };
      // Arming the wake IS the session ending (docs/ORCHESTRATION.md) —
      // endedAt is the arm time, so only triggers AFTER it can ever wake it.
      store.upsertSession({
        ...session,
        state: "waiting",
        wakeOn,
        endedAt: session.endedAt ?? Date.now(),
      });
      return json({ ok: true });
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

  // ── session bookkeeping helpers ────────────────────────────────────────────
  const nowMs = () => Date.now();

  function emitSessionEnd(
    s: AgentSessionRecord,
    outcome: "done" | "error" | "waiting",
  ): void {
    store.addEvent({
      threadId: s.threadId,
      actor: s.handle,
      type: "session-end",
      payload: { sessionId: s.id, handle: s.handle, outcome },
    });
  }

  /** Terminal error transition + session-end event + (optionally) the ⚠︎ post. */
  function failSession(
    record: AgentSessionRecord,
    reason: string,
    postBody: string | undefined,
    extra: Partial<AgentSessionRecord> = {},
  ): void {
    store.upsertSession({
      ...record,
      ...extra,
      state: "error",
      reason,
      procKey: undefined,
      endedAt: nowMs(),
    });
    emitSessionEnd(record, "error");
    if (postBody)
      store.addPost({ threadId: record.threadId, author: record.handle, body: postBody });
    console.error(`[host] @${record.handle} session error (${reason})`);
  }

  /** Durable claim marker for a tagged event that must never spawn — the
   *  record IS the claim, so the event is never re-examined. */
  function mintClaimMarker(
    ev: BoardEvent,
    handle: string,
    state: "done" | "error",
    reason: string,
  ): AgentSessionRecord {
    const record: AgentSessionRecord = {
      id: crypto.randomUUID(),
      threadId: ev.threadId,
      handle,
      state,
      reason,
      triggerEventId: ev.id,
      startedAt: nowMs(),
      endedAt: nowMs(),
    };
    store.upsertSession(record);
    return record;
  }

  // ── transcript log ─────────────────────────────────────────────────────────
  function logLine(logPath: string, channel: "out" | "err", line: string): void {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${channel}] ${line}\n`);
    } catch {
      /* the transcript is best-effort */
    }
  }

  // ── the reconciler (rules 1, 2, 5, 6) ─────────────────────────────────────
  // One level-triggered loop: every store mutation and a 2s tick both just
  // schedule a pass; each pass derives ALL pending work from state.

  /** Wake/trigger prompt, rebuilt from state at spawn time (durable: nothing
   *  about a pending wake lives only in memory). triggerEventId may name a
   *  BoardEvent (tag, session-end) or a Post (post-wake). */
  function triggerDescription(s: AgentSessionRecord, state: BoardState): string {
    const ev = state.events.find((e) => e.id === s.triggerEventId);
    if (ev?.type === "tagged") {
      const post = state.posts.find(
        (p) => p.threadId === ev.threadId && p.author === ev.actor && p.createdAt === ev.at,
      );
      return `tagged by ${ev.actor}${post ? `: ${post.body}` : ""}`;
    }
    if (ev?.type === "session-end") {
      const handle = String(ev.payload.handle ?? "");
      const last = state.posts
        .filter((p) => p.threadId === s.threadId && p.author === handle)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return `@${handle} finished in this thread${last ? ` — their last post: ${last.body}` : ""}`;
    }
    const post = state.posts.find((p) => p.id === s.triggerEventId);
    if (post) return `new post by ${post.author}: ${post.body}`;
    return "woken by a board event";
  }

  /** A wake re-points a session's triggerEventId at the waking event; the
   *  ORIGINAL trigger must stay claimed or it would be re-examined (worst
   *  case: a duplicate spawn). A terminal marker record retires it. */
  function retireTrigger(s: AgentSessionRecord, now: number): void {
    const old = s.triggerEventId;
    if (!old) return;
    const claimedElsewhere = store
      .getState()
      .sessions.some((x) => x.id !== s.id && x.triggerEventId === old);
    if (claimedElsewhere) return;
    store.upsertSession({
      id: crypto.randomUUID(),
      threadId: s.threadId,
      handle: s.handle,
      state: "done",
      reason: "superseded-by-wake",
      triggerEventId: old,
      startedAt: now,
      endedAt: now,
    });
  }

  /** Session starts in this thread inside the rolling budget window. */
  function threadStartCount(threadId: string, now: number): number {
    return store
      .getState()
      .sessions.filter(
        (s) =>
          s.threadId === threadId &&
          !(s.reason && NON_START_REASONS.has(s.reason)) &&
          (s.queuedAt ?? s.startedAt) > now - BUDGET_WINDOW_MS,
      ).length;
  }

  /** (a) Claim every unhandled tagged event — creation of the session record
   *  IS the claim (durable intent). */
  function claimTags(now: number): void {
    // Snapshot the ids up front; re-read fresh state per event because each
    // claim mutates the store.
    const eventIds = store.getState().events.filter((e) => e.type === "tagged").map((e) => e.id);
    for (const evId of eventIds) {
      const state = store.getState();
      if (state.sessions.some((s) => s.triggerEventId === evId)) continue; // handled
      const ev = state.events.find((e) => e.id === evId);
      if (!ev) continue; // thread deleted mid-pass

      const handle = String(ev.payload.handle ?? "");

      if (now - ev.at > STALE_TAG_MS) {
        // Restart archaeology: never spawn on day-old intent. One log line,
        // no post spam.
        mintClaimMarker(ev, handle || "unknown", "error", "stale-skipped");
        say(`[host] tag ${ev.id} (@${handle}) is ${Math.round((now - ev.at) / 3_600_000)}h old — stale-skipped`);
        continue;
      }

      const entry = state.roster.find((r) => r.handle === handle);
      if (!entry) {
        mintClaimMarker(ev, handle || "unknown", "error", "unknown-handle");
        console.error(`[host] tagged unknown handle @${handle} — ignoring`);
        continue;
      }

      const mine = state.sessions.filter(
        (s) => s.threadId === ev.threadId && s.handle === handle,
      );
      const live = mine.find(
        (s) => s.state === "queued" || s.state === "spawning" || s.state === "running",
      );
      if (live) {
        // v1: leave a live session alone — the post is on the board, the
        // agent can `elan thread` to refresh. The marker makes that decision
        // durable so the tag is never re-examined.
        mintClaimMarker(ev, handle, "done", "absorbed-by-live-session");
        say(`[host] @${handle} already ${live.state} in this thread — tag absorbed`);
        continue;
      }

      const waiting = mine.find(
        (s) =>
          s.state === "waiting" &&
          s.wakeOn?.event === "post" &&
          s.endedAt != null &&
          ev.at > s.endedAt,
      );
      if (waiting) {
        if (children.has(waiting.id)) continue; // armed but still exiting — next pass
        if (threadStartCount(ev.threadId, now) >= threadBudget) {
          budgetDrop(ev, handle);
          continue;
        }
        retireTrigger(waiting, now);
        store.upsertSession({
          ...waiting,
          state: "queued",
          queuedAt: now,
          triggerEventId: ev.id,
          wakeOn: undefined,
        });
        say(`[host] wake for @${handle}: tag ${ev.id}`);
        continue;
      }

      if (threadStartCount(ev.threadId, now) >= threadBudget) {
        budgetDrop(ev, handle);
        continue;
      }

      store.upsertSession({
        id: crypto.randomUUID(),
        threadId: ev.threadId,
        handle,
        state: "queued",
        triggerEventId: ev.id,
        queuedAt: now,
        startedAt: now,
      });
      say(`[host] queued @${handle} for tag ${ev.id}`);
    }
  }

  function budgetDrop(ev: BoardEvent, handle: string): void {
    // The mention-loop breaker (rule 5): the claim marker keeps the tag from
    // ever being re-examined; the post tells the humans why nothing spawned.
    mintClaimMarker(ev, handle, "error", "budget-exceeded");
    store.addPost({
      threadId: ev.threadId,
      author: handle,
      body:
        `⚠︎ spawn budget exceeded (agent mention loop?) — dropped this @${handle} tag. ` +
        `Limit: ${threadBudget} session starts per ${Math.round(BUDGET_WINDOW_MS / 60_000)} min per thread.`,
    });
    console.error(`[host] thread ${ev.threadId} over spawn budget — dropped @${handle} tag`);
  }

  /** (d) Match armed wakes against session-end events / posts that arrived
   *  after the wake was armed. Same durable claim discipline: the flip to
   *  "queued" + triggerEventId update is the consumption record. */
  function matchWakes(now: number): void {
    const state = store.getState();
    for (const s of state.sessions) {
      if (s.state !== "waiting" || !s.wakeOn || s.endedAt == null) continue;
      if (children.has(s.id)) continue; // armed, process still exiting
      let triggerId: string | undefined;
      if (s.wakeOn.event === "session-end") {
        const ev = state.events.find(
          (e) =>
            e.type === "session-end" &&
            e.threadId === s.threadId &&
            e.payload.handle === s.wakeOn!.handle &&
            e.payload.sessionId !== s.id &&
            e.at > s.endedAt!,
        );
        triggerId = ev?.id;
      } else {
        const post = state.posts
          .filter(
            (p) =>
              p.threadId === s.threadId &&
              p.author !== s.handle &&
              p.createdAt > s.endedAt!,
          )
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        triggerId = post?.id;
      }
      if (!triggerId) continue;
      if (threadStartCount(s.threadId, now) >= threadBudget) {
        failSession(s, "budget-exceeded",
          `⚠︎ spawn budget exceeded (agent mention loop?) — @${s.handle}'s wake was dropped.`);
        continue;
      }
      retireTrigger(s, now);
      store.upsertSession({
        ...s,
        state: "queued",
        queuedAt: now,
        triggerEventId: triggerId,
        wakeOn: undefined,
      });
      say(`[host] wake for @${s.handle}: trigger ${triggerId}`);
    }
  }

  /** (c) Overtime children: SIGTERM → 10s → SIGKILL. Level-triggered off the
   *  child table; the exit handler files the "timeout" error. */
  function enforceTimeouts(now: number): void {
    for (const ch of children.values()) {
      if (ch.killedAt != null) {
        if (now - ch.killedAt > KILL_GRACE_MS) {
          try {
            ch.proc.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
        continue;
      }
      if (now - ch.spawnedAt > sessionTimeoutMs) {
        ch.timedOut = true;
        ch.killedAt = now;
        console.error(`[host] @${ch.handle} over ${sessionTimeoutMs}ms — SIGTERM`);
        try {
          ch.proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }

  /** (b) Spawn queued sessions oldest-first while slots are free. */
  function spawnQueued(): void {
    const queued = store
      .getState()
      .sessions.filter((s) => s.state === "queued")
      .sort((a, b) => (a.queuedAt ?? a.startedAt) - (b.queuedAt ?? b.startedAt));
    for (const s of queued) {
      if (children.size >= maxSessions) break;
      try {
        startQueuedSession(s);
      } catch (e) {
        console.error(`[host] spawn failed for @${s.handle}:`, e);
        failSession(s, "spawn-failed", `⚠︎ Can't start @${s.handle}: ${String(e)}`);
      }
    }
  }

  function startQueuedSession(s: AgentSessionRecord): void {
    const state = store.getState();
    const entry = state.roster.find((r) => r.handle === s.handle);
    if (!entry) {
      failSession(s, "runner-not-found", `⚠︎ Can't start @${s.handle}: not on the roster.`);
      return;
    }
    const thread = state.threads.find((t) => t.id === s.threadId);
    if (!thread) {
      // Thread deleted between claim and spawn — the record goes with it
      // normally; this is pure defense.
      store.upsertSession({ ...s, state: "error", reason: "spawn-failed", endedAt: nowMs() });
      return;
    }

    const profile: HarnessProfile | undefined = HARNESSES[entry.harness];
    if (!profile) {
      failSession(
        s,
        "runner-not-found",
        `⚠︎ Can't start: no runner for harness \`${entry.harness}\` (@${s.handle}).`,
      );
      return;
    }

    // Preflight (rule 6): resolve the binary on the CHILD's PATH — the env
    // the process will actually see, not the host's possibly-polluted one.
    const baseEnv = buildChildEnv({
      shimDir,
      probed: loginEnv(),
      elan: {
        ELAN_URL: hostUrl,
        ELAN_THREAD: s.threadId,
        ELAN_AGENT: s.handle,
        ELAN_SESSION: s.id,
      },
    });
    const binPath = whichOnPath(profile.bin, baseEnv.PATH);
    if (!binPath) {
      failSession(
        s,
        "runner-not-found",
        `⚠︎ Can't start @${s.handle}: \`${profile.bin}\` not found on the session PATH ` +
          `(built from the login-shell probe plus fallback dirs).`,
      );
      return;
    }

    const cwd = ensureWorktree(thread, s.handle); // before render: context shows the path
    const context = renderThreadContext(store.getState(), thread.id, s.handle);
    // A queued record that already has a harness session id is a wake — the
    // resume/fresh split is derived from state, never remembered in memory.
    const isResume = profile.sessionId != null && !!s.harnessSessionId;
    // Mint-strategy harnesses (grok's create-or-resume `-s`) get ONE id per
    // session record, minted at first spawn and re-passed forever after.
    let harnessSessionId = s.harnessSessionId;
    if (profile.sessionId?.mode === "mint" && !harnessSessionId)
      harnessSessionId = crypto.randomUUID();

    const spec = profile.runner({
      binPath,
      cwd,
      prompt: isResume
        ? `Woken: ${triggerDescription(s, store.getState())}. Run \`elan thread\` for current context.`
        : context,
      instructions: shortInstructions(entry.handle),
      model: entry.model,
      sessionId: s.id,
      sessionDir: sessionsDir,
      resume: isResume ? { harnessSessionId: s.harnessSessionId! } : undefined,
      harnessSessionId,
    });
    if (!("argv" in spec)) {
      failSession(s, "spawn-failed", `⚠︎ Can't start @${s.handle}: ${spec.error}`);
      return;
    }
    for (const f of spec.files ?? []) writeFileSync(f.path, f.content);

    const logPath = join(sessionsDir, `${s.id}.log`);
    const env = { ...baseEnv, ...spec.env };
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(spec.argv, {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      failSession(s, "spawn-failed", `⚠︎ Can't start \`${spec.argv[0]}\`: ${String(e)}`, {
        logPath,
      });
      return;
    }

    const ch: ChildInfo = {
      proc,
      threadId: s.threadId,
      handle: s.handle,
      harness: entry.harness,
      extract: profile.extract,
      isResume,
      spawnedAt: nowMs(),
      stdoutLines: [],
      jsonEvents: 0,
      stderrRaw: "",
      logPath,
      timedOut: false,
    };
    children.set(s.id, ch);
    store.upsertSession({
      ...s,
      harnessSessionId, // minted ids persist here; captured ids arrive below
      state: "running",
      procKey: String(proc.pid),
      startedAt: ch.spawnedAt,
      logPath,
      endedAt: undefined,
      exitCode: undefined,
      wakeOn: undefined,
    });
    store.addEvent({
      threadId: s.threadId,
      actor: s.handle,
      type: "session-start",
      payload: { sessionId: s.id, handle: s.handle },
    });
    say(
      `[host] @${s.handle} running (pid ${proc.pid}, cwd ${cwd}${isResume ? ", resume" : ""})`,
    );

    // stdout: tolerant JSONL, logged + broadcast live. Capture-strategy
    // harnesses surface their native session id here (claude/cursor:
    // session_id on every event; pi: the first {"type":"session"} line;
    // opencode: sessionID on every event) — that id is the resume handle.
    const capture =
      profile.sessionId?.mode === "capture" ? profile.sessionId.capture : undefined;
    void pumpLines(proc.stdout, (line) => {
      logLine(logPath, "out", line);
      broadcastSessionLine(s.id, "out", line);
      ch.stdoutLines.push(line);
      if (ch.stdoutLines.length > 2_000) ch.stdoutLines.splice(0, ch.stdoutLines.length - 2_000);
      const msg = parseLine(line);
      if (!msg) return;
      ch.jsonEvents++;
      if (!capture) return;
      const sid = capture(msg);
      if (typeof sid !== "string" || !sid) return;
      const cur = store.getState().sessions.find((x) => x.id === s.id);
      if (cur && cur.harnessSessionId !== sid)
        store.upsertSession({ ...cur, harnessSessionId: sid });
    });

    void pumpLines(proc.stderr, (line) => {
      logLine(logPath, "err", line);
      broadcastSessionLine(s.id, "err", line);
      ch.stderrRaw = (ch.stderrRaw + line + "\n").slice(-8_000);
    });

    void proc.exited.then((code) => {
      try {
        finishChild(s.id, typeof code === "number" ? code : -1);
      } catch (e) {
        console.error("[host] session finish failed:", e);
      }
      reconcile(); // a slot freed even if the session record vanished
    });
  }

  function finishChild(sessionId: string, exitCode: number): void {
    const ch = children.get(sessionId);
    children.delete(sessionId);
    if (!ch || stopped) return;
    const s = store.getState().sessions.find((x) => x.id === sessionId);
    if (!s || s.state === "done" || s.state === "error") return;
    const now = nowMs();
    const stderrTail = stripAnsi(ch.stderrRaw).slice(-1_000).trim();

    if (s.state === "waiting" && s.wakeOn) {
      // wake-me armed mid-run: the process ending IS the wait beginning.
      // endedAt stays the arm time — only later triggers may wake it.
      store.upsertSession({
        ...s,
        procKey: undefined,
        exitCode,
        endedAt: s.endedAt ?? now,
      });
      emitSessionEnd(s, "waiting");
      say(`[host] @${s.handle} waiting on ${JSON.stringify(s.wakeOn)}`);
      return;
    }

    if (ch.timedOut) {
      failSession(
        s,
        "timeout",
        `⚠︎ Session timed out after ${Math.round(sessionTimeoutMs / 60_000)} min and was killed.` +
          (stderrTail ? `\n\`\`\`\n${stderrTail}\n\`\`\`` : ""),
        { exitCode },
      );
      return;
    }

    // A resume that dies instantly without emitting a single stream event is
    // a broken --resume (expired harness session etc.) — fall back ONCE to a
    // fresh spawn with the full context. Clearing harnessSessionId makes the
    // retry a fresh run, so this can never loop.
    if (
      ch.isResume &&
      exitCode !== 0 &&
      now - ch.spawnedAt < RESUME_FALLBACK_WINDOW_MS &&
      ch.jsonEvents === 0
    ) {
      store.upsertSession({
        ...s,
        state: "queued",
        queuedAt: now,
        harnessSessionId: undefined,
        reason: "resume-fell-back",
        procKey: undefined,
        exitCode,
        endedAt: undefined,
      });
      say(`[host] @${s.handle} resume died instantly — falling back to a fresh spawn`);
      return;
    }

    const outcome = extractOutcome(ch.extract, ch.stdoutLines, exitCode);
    if (outcome.ok) {
      store.upsertSession({
        ...s,
        state: "done",
        procKey: undefined,
        exitCode,
        endedAt: now,
      });
      emitSessionEnd(s, "done");
      // Silent-success fallback: a summoned agent that ends ok having made
      // ZERO board mutations would otherwise vanish — its answer lived only
      // in the stream (weak models answer in-band instead of running elan).
      // Work must never vanish: post the extracted final message on its
      // behalf. Agents that used elan are left alone.
      const spoke =
        store.getState().posts.some(
          (p) => p.threadId === s.threadId && p.author === s.handle && p.createdAt >= s.startedAt,
        ) ||
        store.getState().events.some(
          (e) =>
            e.threadId === s.threadId && e.actor === s.handle &&
            e.at >= s.startedAt && e.type !== "session-start" && e.type !== "session-end",
        );
      if (!spoke && outcome.text?.trim()) {
        // suppressTags: a ventriloquized post must never summon anyone.
        store.addPost({
          threadId: s.threadId,
          author: s.handle,
          body: outcome.text.trim(),
          suppressTags: true,
        });
        say(`[host] @${s.handle} never used elan — posted its final message as fallback`);
      }
      say(`[host] @${s.handle} session done`);
      return;
    }

    // Rule 3: the extracted stream message leads; the ANSI-stripped stderr
    // tail is a fenced afterthought.
    failSession(
      s,
      exitCode !== 0 ? "nonzero-exit" : "error-result",
      `⚠︎ ${outcome.text || `Session exited with code ${exitCode}.`}` +
        (stderrTail ? `\n\`\`\`\n${stderrTail}\n\`\`\`` : ""),
      { exitCode },
    );
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
          matchWakes(now);
          enforceTimeouts(now);
          spawnQueued();
        } catch (e) {
          console.error("[host] reconciler pass failed:", e);
        }
      } while (passPending);
    } finally {
      inPass = false;
    }
  }

  // ── boot recovery (rule 2) ─────────────────────────────────────────────────
  // Runs before the subscription: no live children can exist yet, so every
  // "spawning"/"running" record is a lie left by a crash. Waiting records are
  // untouched — no process is their normal state.
  for (const s of store.getState().sessions) {
    if (s.state === "spawning" || s.state === "running") {
      say(`[host] @${s.handle} session ${s.id} orphaned by restart`);
      failSession(s, "orphaned-by-restart", undefined);
    }
  }

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
    `[host] limits: ${maxSessions} concurrent, ${threadBudget} starts/${Math.round(
      BUDGET_WINDOW_MS / 60_000,
    )}min/thread, ${Math.round(sessionTimeoutMs / 60_000)}min timeout`,
  );

  reconcile(); // pick up queued/stale work persisted before the restart

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
