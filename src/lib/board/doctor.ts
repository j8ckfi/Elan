// The doctor client: fetch + cache for GET /api/doctor (doctor v2 — see
// docs/ORCHESTRATION.md "The harness registry"), read through useDoctor().
// Module-level singleton like host-store's status: there is one host, one
// doctor report, and any number of readers (Settings, onboarding).
//
// Local mode (no host) has nothing to probe — useDoctor() returns null and
// the roster editor renders its connect-a-host note instead of detection.
//
// The wire shape is the doc's, not the host's current code: per harness
// {bin, found, path?, version?, auth?, models: string[] | null,
// discoveryError?, lastFailure?}. v1 hosts that predate discovery simply
// omit `models`/`auth` — rows degrade to found/version and nothing breaks.

import { useSyncExternalStore } from "react";

// ── Wire + row types ───────────────────────────────────────────────────────

/** One harness's probe result, as reported by GET /api/doctor. */
export interface DoctorHarness {
  /** Executable the runner resolves ("claude", "codex", …); null = unknown. */
  bin: string | null;
  /** undefined = probe hasn't landed yet (fixture staging only). */
  found?: boolean;
  path?: string;
  version?: string;
  /** Auth probe verdict, human-readable ("signed in", "not signed in", …). */
  auth?: string;
  /** Discovered model ids; null = the CLI has no programmatic discovery.
   *  undefined = discovery hasn't landed (v1 host, or probe in flight). */
  models?: string[] | null;
  discoveryError?: string;
  lastFailure?: { reason?: string; at?: number; message?: string };
}

/** A harness row the UI renders: the wire entry + its registry id + whether
 *  more data may still land for it (drives the row's gradient-spin). */
export interface DoctorRow extends DoctorHarness {
  id: string;
  pending: boolean;
}

export interface DoctorSnapshot {
  /** "probing" while any fetch is in flight; rows may already be present. */
  status: "probing" | "ready" | "error";
  rows: DoctorRow[];
}

// ── Host resolution ────────────────────────────────────────────────────────
// Mirrors useBoard.ts's resolveHostUrl (not exported there; duplicated like
// host-store duplicates the color palette — the two must agree on the URL
// grammar, nothing else).

const DEFAULT_HOST_URL = "http://127.0.0.1:4519";

function resolveHostUrl(): string | null {
  const envHost = import.meta.env.VITE_ELAN_HOST;
  if (envHost) return envHost;
  if (typeof window === "undefined") return null;
  const param = new URLSearchParams(window.location.search).get("host");
  if (param == null) return null;
  return param === "1" || param === "" ? DEFAULT_HOST_URL : param;
}

// ── Dev-only fixture escape hatch ──────────────────────────────────────────
// Set BEFORE the editor opens to preview the detection list with no host:
//
//   window.__ELAN_DOCTOR_FIXTURE__ = {
//     harnesses: {
//       "claude-code": { bin: "claude", found: true, version: "2.1.197",
//                        auth: "signed in", models: ["claude-fable-5"] },
//       devin: { bin: "devin", found: false, models: null },
//     },
//     staggerMs: 250,   // per-row resolve delay (default 250)
//     initialDelayMs: 200,
//   };
//
// Rows appear immediately as spinners and resolve one by one — the same
// choreography a slow discovery-inclusive doctor response produces. The
// fixture also forces host-mode rendering, so a plain `bun run dev` page
// can exercise the full editor. Never set in production code.

interface DoctorFixture {
  harnesses: Record<string, DoctorHarness>;
  staggerMs?: number;
  initialDelayMs?: number;
}

declare global {
  interface Window {
    __ELAN_DOCTOR_FIXTURE__?: DoctorFixture;
  }
}

function fixture(): DoctorFixture | undefined {
  return typeof window === "undefined" ? undefined : window.__ELAN_DOCTOR_FIXTURE__;
}

// ── The cache ──────────────────────────────────────────────────────────────

const hostUrl = resolveHostUrl();

let snapshot: DoctorSnapshot = { status: "probing", rows: [] };
let loadedOnce = false;
let inFlight = false;
const subscribers = new Set<() => void>();

function publish(next: DoctorSnapshot) {
  snapshot = next;
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function getSnapshot(): DoctorSnapshot {
  return snapshot;
}

/** Parse one doctor response into ordered rows. Registry order = the
 *  response's key order (the host emits its HARNESSES table in order). */
function toRows(payload: unknown, probing: boolean): DoctorRow[] {
  const harnesses =
    payload != null && typeof payload === "object"
      ? (payload as { harnesses?: unknown }).harnesses
      : undefined;
  if (harnesses == null || typeof harnesses !== "object") return [];
  return Object.entries(harnesses as Record<string, unknown>).map(([id, v]) => {
    const h = (v != null && typeof v === "object" ? v : {}) as DoctorHarness;
    return {
      ...h,
      id,
      // More data can still land only while a fetch is in flight, and only
      // for found (or unprobed) harnesses whose discovery hasn't reported.
      pending: probing && h.found !== false && h.models === undefined,
    };
  });
}

async function fetchDoctor(refresh: boolean): Promise<unknown> {
  const res = await fetch(`${hostUrl}/api/doctor${refresh ? "?refresh=1" : ""}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** Two-phase load: a fast pass paints rows from the registry list embedded
 *  in the response, then the (possibly slow) discovery-inclusive ?refresh=1
 *  pass resolves them. v1 hosts ignore the param and answer twice with the
 *  same payload — harmless. `refreshOnly` skips the fast pass (reopen). */
async function load(refreshOnly: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  publish({ status: "probing", rows: snapshot.rows.map((r) => ({ ...r, pending: r.found !== false && r.models === undefined })) });
  try {
    if (!refreshOnly) {
      publish({ status: "probing", rows: toRows(await fetchDoctor(false), true) });
    }
    publish({ status: "ready", rows: toRows(await fetchDoctor(true), false) });
  } catch (err) {
    console.error("[doctor] GET /api/doctor failed:", err);
    // Keep any rows a successful pass already delivered; error only when
    // there is nothing at all to show.
    publish({
      status: snapshot.rows.length > 0 ? "ready" : "error",
      rows: snapshot.rows.map((r) => ({ ...r, pending: false })),
    });
  } finally {
    inFlight = false;
  }
}

/** Fixture playback: skeleton rows first, then per-row staggered resolves —
 *  honest choreography for previews, same snapshot shape as the real path. */
function loadFixture(fx: DoctorFixture): void {
  if (inFlight) return;
  inFlight = true;
  const ids = Object.keys(fx.harnesses);
  const stagger = fx.staggerMs ?? 250;
  const skeleton: DoctorRow[] = ids.map((id) => ({
    id,
    bin: fx.harnesses[id].bin ?? null,
    pending: true,
  }));
  const resolved = new Set<string>();
  const emit = () =>
    publish({
      status: resolved.size === ids.length ? "ready" : "probing",
      rows: ids.map((id) =>
        resolved.has(id)
          ? { ...fx.harnesses[id], id, pending: false }
          : skeleton.find((r) => r.id === id)!,
      ),
    });
  setTimeout(() => {
    emit();
    ids.forEach((id, i) => {
      setTimeout(() => {
        resolved.add(id);
        emit();
        if (resolved.size === ids.length) inFlight = false;
      }, stagger * (i + 1));
    });
  }, fx.initialDelayMs ?? 200);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Kick detection off (editor open). First open = full load; reopen =
 *  `?refresh=1` re-probe, per FRONTEND.md — no Scan button anywhere. */
export function openDoctor(): void {
  const fx = fixture();
  if (fx) {
    loadFixture(fx);
    return;
  }
  if (hostUrl == null) return;
  void load(loadedOnce);
  loadedOnce = true;
}

/** Force a discovery re-probe (retry affordances). */
export function refreshDoctor(): void {
  const fx = fixture();
  if (fx) {
    loadFixture(fx);
    return;
  }
  if (hostUrl == null) return;
  void load(true);
  loadedOnce = true;
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

/** The doctor report, or null in local mode (no host, no fixture) — the
 *  roster editor swaps detection for its connect-a-host note on null. */
export function useDoctor(): DoctorSnapshot | null {
  const available = hostUrl != null || fixture() != null;
  return useSyncExternalStore(
    available ? subscribe : noopSubscribe,
    available ? getSnapshot : nullSnapshot,
  );
}
