# Plan 002: Obliterate local demo mode — the board is always host-backed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP updating `plans/README.md` — your reviewer
> maintains the index.
>
> **Drift check (run first)**: `git diff --stat 84100c3..HEAD -- src/lib/board src/components/board/RosterEditor.tsx src/components/board/ConnectionBanner.tsx e2e playwright.config.ts dev/elan-host.ts package.json .gitignore AGENTS.md docs/ORCHESTRATION.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (file-disjoint from 001 and 003)
- **Category**: tech-debt / dx
- **Planned at**: commit `84100c3`, 2026-07-12

## Why this matters

Today the UI silently picks between two stores at boot: a real host client
(HTTP + WS to the Elan host on :4519) when `VITE_ELAN_HOST` or `?host=` is
set, or a **localStorage demo store** otherwise — in which tagging agents
records events but *spawns nothing*. The Tauri desktop app hits the fallback,
so the flagship build is a demo shell that looks alive and isn't, and the
roster editor shows the dead-end copy "Connect a host to detect CLIs and
models" with no affordance. The maintainer's decision: **local mode must not
exist.** After this plan, the UI always connects to a host, the connection
lifecycle is visible and actionable, and the e2e suite drives the real host.

## Current state

Repo: Vite + React 19 + TS + Tailwind v4; package manager **bun**. The host
is `dev/elan-host.ts` (Bun, port 4519, env `ELAN_HOST_PORT` / `ELAN_STATE_DIR`
/ `ELAN_MAX_SESSIONS`…, state file `${ELAN_STATE_DIR}/board.json`). It reuses
the same `createBoardStore` rules module as the browser store and serves
`GET /api/state`, WS `/api/subscribe` (full-state push), REST mutations,
`GET /api/doctor`. The host boots in-process in its own tests via an exported
`startHost()` (auto-start only under `import.meta.main`).

### Store selection — src/lib/board/useBoard.ts:37-65

```ts
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
export function boardMode(): "local" | "host" {  // zero importers — delete
  return hostUrl ? "host" : "local";
}
```

`useHostStatus()` (useBoard.ts:74-82) returns `HostStatus | null` — null in
local mode via noop subscribe functions. Later in the same file,
`useSessionTelemetry` guards with `if (!hostUrl || …)` at lines ~136, ~173,
~194.

### The local store — src/lib/board/store.ts:401-417

```ts
export function createLocalStore(): BoardStore {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  return createBoardStore({
    initial: loadState(),
    persist(state) { /* debounced localStorage.setItem(STORAGE_KEY = "elan.board.v3", …) */ },
  });
}
```

`createBoardStore` / `normalizeState` are the shared rules module — the host
and unit tests use them. Only `createLocalStore` + its `loadState()`/
`STORAGE_KEY`/`PERSIST_DEBOUNCE_MS` localStorage plumbing die.
`src/lib/board/seed.ts` stays: `emptyState()` is used by store.ts and
host-store.ts; `seedState()` is used by `tests/board-store.test.ts` as a rich
fixture ("The demo was removed from the product; seedState survives as a rich
test fixture" — tests/board-store.test.ts:37).

### The doctor — src/lib/board/doctor.ts

Duplicates `resolveHostUrl` (doctor.ts:~55-62, same grammar, documented as a
deliberate duplication that "must agree on the URL grammar, nothing else").
When `hostUrl` is null, `useDoctor()` returns null forever. There is a
dev-only fixture escape hatch `window.__ELAN_DOCTOR_FIXTURE__` (doctor.ts:64-97)
that forces host-mode rendering with scripted rows — the e2e suite will use it.

### The dead-end copy — src/components/board/RosterEditor.tsx:156-159 and 204-206

```tsx
{doctor == null ? (
  <p className="py-1.5 text-[12px] text-muted-foreground">
    Connect a host to detect CLIs and models.
  </p>
) : doctor.status === "error" ? ( /* "Couldn't reach the host's doctor." + Retry */ )
```

and the onboarding subline:

```tsx
{doctor == null
  ? "Pick the agents you want on the board."
  : "These CLIs are on your machine. Pick the models you want on the board."}
```

### ConnectionBanner — src/components/board/ConnectionBanner.tsx

Display-only banner; renders ONLY when `useHostStatus() === "disconnected"`
("Host disconnected — retrying…"). `HostStatus` is
`"connecting" | "connected" | "disconnected"` (host-store.ts:35), module-level
in host-store.ts; a drop sets "disconnected" and stays there across backoff
retries; host-store reconnects on its own (RECONNECT_MIN_MS 500 →
RECONNECT_MAX_MS 5000). "connecting" is only the pre-first-contact default.

House rules (docs/FRONTEND.md, quoted in the file): no pulsing liveness dots;
hidden ⇒ non-interactive; unmounted rather than faded.

### E2E — e2e/board.spec.ts + playwright.config.ts

9 tests drive the UI against the **local store**: `seedFixture(page)` writes a
hand-rolled `BoardState` to `localStorage["elan.board.v3"]` via
`addInitScript` + reload; `test.beforeEach` clears localStorage
(sessionStorage-guarded so mid-test reloads don't wipe state). One assertion
depends on local mode existing (board.spec.ts:235-237):

```ts
// local mode, the connect-a-host note in place of the detection list.
await expect(page.getByText("Connect a host to detect CLIs and models.")).toBeVisible();
```

playwright.config.ts boots one webServer: `bun run dev -- --port 5177
--strictPort`, baseURL `http://localhost:5177`. Playwright's `webServer`
accepts an **array** of servers.

### Docs that describe local mode (update the specific lines only)

- `AGENTS.md` "Dev loops": "**No backend at all:** open `/?agent=mock` — …"
  bullet also implies the board works hostless; and the UI-only bullet.
- `docs/ORCHESTRATION.md:36-44`: "The UI picks its store at boot: … otherwise
  the localStorage store (browser-only demo mode — tagging records events but
  nothing spawns)."

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Unit tests | `bun test tests` | all pass |
| E2E | `bun run e2e` | all pass |
| Host (manual) | `bun dev/elan-host.ts` | listens on :4519 |

E2E requires Playwright browsers (`bunx playwright install chromium` once if
missing).

## Scope

**In scope**:
- `src/lib/board/useBoard.ts`, `src/lib/board/store.ts`, `src/lib/board/doctor.ts`
- `src/components/board/RosterEditor.tsx`, `src/components/board/ConnectionBanner.tsx`
- `dev/elan-host.ts` (ONLY to add the test-gated `PUT /api/state` endpoint)
- `e2e/board.spec.ts`, `playwright.config.ts`, `.gitignore`, `package.json` (scripts only)
- `AGENTS.md`, `docs/ORCHESTRATION.md` (the specific local-mode lines above)
- `tests/` — a new unit test for the state-replace endpoint if feasible (see Test plan)

**Out of scope**:
- `src/components/chat/**`, `src/lib/settings.ts` — plan 001's territory.
- `src-tauri/**` — plan 003's territory.
- `src/lib/board/seed.ts`, `host-store.ts`'s optimistic-mutation logic, the
  orchestrator/hot-session machinery in `dev/elan-host.ts`.
- `src/lib/board/types.ts`, `telemetry.ts`.

## Git workflow

- Branch: `advisor/002-obliterate-local-mode`
- Commit per step; short imperative messages matching `git log` style.
- Do NOT push or open a PR.

## Steps

### Step 1: Make the host URL unconditional

In `src/lib/board/useBoard.ts`: `resolveHostUrl(): string` — `VITE_ELAN_HOST`
wins; else `?host=<url>` overrides (keep for dev flexibility; `?host=1` maps
to the default); else **return `DEFAULT_HOST_URL`** (no null path). Then:

- `getStore()` always calls `createHostStore(hostUrl)`; delete the
  `createLocalStore` import and `boardMode()` (zero importers — verify with
  `grep -rn "boardMode" src tests e2e` first).
- `useHostStatus(): HostStatus` — drop the null branch and the
  noop/null subscribe pair; always read host-store's status.
- Simplify the `if (!hostUrl …)` guards in `useSessionTelemetry` (hostUrl is
  always truthy now; keep the other conditions).

Apply the same unconditional resolution to the duplicated `resolveHostUrl` in
`src/lib/board/doctor.ts` (keep the duplication itself — it's documented as
deliberate). `useDoctor()` no longer has a null-forever path; update its
return type if it was `DoctorSnapshot | null` and fix the comment block that
documents local mode ("Local mode (no host) has nothing to probe…").

**Verify**: `bunx tsc --noEmit` → errors ONLY in `RosterEditor.tsx` /
`ConnectionBanner.tsx` (if types narrowed) and `store.ts` consumers you
haven't touched yet; note them for Steps 2–3. If errors appear in unexpected
files, STOP.

### Step 2: Delete the local store

In `src/lib/board/store.ts`: delete `createLocalStore`, `loadState`,
`STORAGE_KEY`, `PERSIST_DEBOUNCE_MS` (grep first: `grep -rn
"createLocalStore\|elan.board.v3" src tests` → only store.ts + useBoard.ts at
84100c3; e2e references are rewritten in Step 5). Keep `createBoardStore`,
`normalizeState`, `emptyState` import — the host and tests use them.

**Verify**: `bunx tsc --noEmit` → exit 0 (after Step 1's edits). `bun test
tests` → all pass.

### Step 3: Connection lifecycle UX

- `ConnectionBanner.tsx`: render two states from `useHostStatus()`:
  - `"connecting"` → quiet neutral bar (muted-foreground, border-border):
    "Connecting to the Elan host…"
  - `"disconnected"` → the existing destructive bar, upgraded to actionable
    copy: `Can't reach the Elan host — retrying. Start one with `bun
    dev/elan-host.ts`, or relaunch the desktop app.` Keep it display-only
    (house rule: the banner is the whole affordance; no buttons, no spinner).
  - `"connected"` → `return null` (unmounted, as today).
- `RosterEditor.tsx`: delete the `doctor == null` branches (lines 156-159 and
  the onboarding subline ternary at 204-206 — keep the "These CLIs are on
  your machine…" copy). The error state ("Couldn't reach the host's doctor."
  + Retry) already covers an unreachable host — keep it. Update the file's
  header comment ("Local mode swaps the detection list for a connect-a-host
  note." is no longer true).

**Verify**: `bunx tsc --noEmit` → exit 0. `grep -rn "Connect a host" src` →
no matches.

### Step 4: Test-gated state replacement on the host

In `dev/elan-host.ts`, add `PUT /api/state`, enabled ONLY when
`process.env.ELAN_ALLOW_STATE_REPLACE === "1"` (otherwise respond 403):
body = full `BoardState` JSON → run through the same `normalizeState` used at
boot → replace the store's state → persist → push to WS subscribers (reuse
whatever full-state push path mutations already use). Match the file's
existing route/handler style. This exists so e2e tests can reset/seed the
board; it must never be reachable in a normally-launched host.

**Verify**: `ELAN_ALLOW_STATE_REPLACE=1 ELAN_HOST_PORT=4531 ELAN_STATE_DIR=$(mktemp -d) bun dev/elan-host.ts &` then
`curl -s -X PUT localhost:4531/api/state -d '{"projects":[],"threads":[]}' -o /dev/null -w '%{http_code}'` → `200`,
and `curl -s localhost:4531/api/state | head -c 200` shows a normalized empty
board. Re-run without the env var → `403`. Kill the host after.

### Step 5: Rewire e2e to the real host

- `playwright.config.ts`: `webServer` becomes an array:
  1. `ELAN_HOST_PORT=4529 ELAN_STATE_DIR=.elan-e2e ELAN_ALLOW_STATE_REPLACE=1 bun dev/elan-host.ts`, url `http://127.0.0.1:4529/api/state`
  2. `VITE_ELAN_HOST=http://127.0.0.1:4529 bun run dev -- --port 5177 --strictPort`, url `http://localhost:5177`
- Add `.elan-e2e/` to `.gitignore`.
- `e2e/board.spec.ts`:
  - `test.beforeEach`: PUT an empty `BoardState` to
    `http://127.0.0.1:4529/api/state` (use Playwright's `request` fixture)
    instead of relying on fresh localStorage for board state. Keep clearing
    localStorage (tab state `elan.tabs.v1` still lives there).
  - `seedFixture(page)`: PUT `buildFixture()` to the host, then reload and
    wait for the flagship thread — replacing the `addInitScript` localStorage
    write.
  - **Critical**: every roster entry in `buildFixture()` must use
    `harness: "mock"` — with a real host, tagging SPAWNS the rostered harness,
    and a non-mock harness would launch a real CLI (or fail probing for one)
    mid-test. Inspect `buildFixture()`'s roster and force `mock`.
  - The connect-a-host assertion (board.spec.ts:235-237): replace with a
    deterministic detection assertion using the doctor fixture — in that test,
    `addInitScript` set `window.__ELAN_DOCTOR_FIXTURE__ = { harnesses: {
    "claude-code": { bin: "claude", found: true, version: "2.1.0", models:
    ["claude-fable-5"] } } }` before load, then assert "Available on this
    machine" section shows the Claude Code row. (The fixture short-circuits
    real probing — doctor.ts:64-97.)
  - The first-run test ("first run shows Welcome, one board tab, no demo
    data") now depends on the beforeEach reset producing an empty board.

**Verify**: `bun run e2e` → all 9 tests pass. Run it twice back-to-back →
passes both times (catches state leakage between runs).

### Step 6: Docs truth pass

- `docs/ORCHESTRATION.md:36-44`: rewrite the store-selection paragraph — the
  UI always connects to a host (`VITE_ELAN_HOST` > `?host=` > default
  `127.0.0.1:4519`); the dev loop is `bun dev/elan-host.ts` + `bun run dev`.
- `AGENTS.md` "Dev loops": update the UI-only bullet to include the host, and
  reword the "No backend at all" bullet — the mock **adapter** path
  (`/?agent=mock`) still exists for chat-session work, but the **board**
  always needs a host.
- `package.json`: add script `"host": "bun dev/elan-host.ts"`.

**Verify**: `grep -rn "browser-only demo\|localStorage store" docs/ORCHESTRATION.md AGENTS.md` → no stale matches.

## Test plan

- E2E is the main net (Step 5) — all 9 existing tests rewired, no test
  deleted, assertions preserved or strengthened (connect-a-host → doctor
  fixture rows).
- If `dev/elan-host.ts` has an existing test file under `tests/` that boots
  `startHost()` in-process, add one test there for `PUT /api/state`: 403
  without the env gate, 200 + normalized state with it (model after the
  neighboring host tests). If no such harness exists, the curl verification
  in Step 4 stands and note it in your report.
- `bun test tests` must stay green throughout — the unit suite exercises the
  shared rules module this plan must not break.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test tests` exits 0
- [ ] `bun run e2e` exits 0, twice in a row
- [ ] `grep -rn "createLocalStore\|boardMode\|elan.board.v3" src/` → no matches
- [ ] `grep -rn "Connect a host" src e2e/board.spec.ts` → no matches (except the doctor-fixture test's new assertion text, which must not reuse that copy)
- [ ] `curl` verification of Step 4 passes (both 200-gated and 403-ungated)
- [ ] `git status` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- `dev/elan-host.ts` has no full-state push path reusable for `PUT /api/state`
  (i.e., the endpoint would require restructuring the host's store wiring).
- Any e2e test cannot be expressed against the host (e.g. the tab-restore
  test's mid-test reload interacts badly with WS reconnect) after 2 attempts.
- `buildFixture()`'s shape has drifted from `normalizeState`'s expectations
  (PUT returns 4xx/5xx on the fixture).
- Tagging in e2e spawns anything other than the mock harness.
- You find a real (non-test) importer of `createLocalStore` beyond
  useBoard.ts.

## Amendment (2026-07-12, revision round 1)

Execution surfaced a real bug local mode had been masking: `hydrateTabs()`
(src/App.tsx:59-66) prunes persisted tab ids against board state
synchronously at mount; host-backed state arrives async, so every reload
wiped open thread tabs and persisted the loss. Scope EXPANDED to fix it:

- `src/App.tsx` (tab hydration/prune/persist logic only)
- `src/lib/board/host-store.ts` (additive module-level "first state loaded"
  signal, mirroring the hostStatus pattern)
- `src/lib/board/useBoard.ts` (expose the signal as a hook)

Required behavior: no tab pruning before the host's first full state
(initial GET or first WS push — not `connected`, not "threads non-empty").
Also added: e2e runs must not write into the source tree (executor observed
the mock agent dropping `mock-plan.md` in the repo root because the
fixture's `repoPath` doesn't exist — create real temp repo dirs or run the
e2e host from a temp cwd). Done criteria now: e2e 8/8 twice in a row (the
spec file has 8 tests, not 9 as originally written) + `git status` clean
after runs.

## Maintenance notes

- Plan 003 makes the Tauri app spawn/adopt the host on :4519 — this plan is
  what makes the desktop webview actually connect to it (default URL). The
  full desktop experience needs both merged.
- `PUT /api/state` is a test-only surface; if the host ever becomes
  network-exposed beyond loopback, the env gate must become a hard compile-out.
- Reviewer should scrutinize: e2e flake (run the suite twice), the WS
  full-state push after PUT (a stale UI after seed = missed push), and that
  the "connecting" banner doesn't flash on fast connects (host-store sets
  "connected" on first WS open — if a flash is visible, gate the connecting
  banner on a ~300ms delay, noted as an acceptable documented deviation).
