// End-to-end: the board UI in a real browser against a real Elan host (the
// board is always host-backed now — local mode is gone, 2026-07-12). The host
// runs with ELAN_ALLOW_STATE_REPLACE=1 so the suite can seed/reset the board
// over PUT /api/state; the UI is pointed at it via VITE_ELAN_HOST
// (playwright.config.ts). No agent CLI or credentials: every rostered harness
// in the fixture is `mock`, so tagging drives the credential-free mock agent.
// Detection is stubbed via window.__ELAN_DOCTOR_FIXTURE__ (set in beforeEach)
// so the roster editor never probes real CLIs on the machine.
// The demo is gone from the product (docs/DATA-MODEL.md: "There is no demo
// board in the product"), so tests that need pre-existing data seed their own
// fixture (seedFixture below). Pure product-path tests (first run, project
// creation, the draft flow, delete-project) start from an empty board.
// The assertions come straight from docs/FRONTEND.md: First run, the tab row,
// the draft page, the thread view. Orchestration is covered elsewhere.

import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const HOST_URL = "http://127.0.0.1:4529";

// The fixture's repoPaths must EXIST: when a project's repoPath is missing,
// the host falls back to spawning agents in its own cwd — the source tree —
// and the mock agent would drop its artifacts (mock-plan.md) into the repo.
// Plain dirs are enough (not git repos): the host uses them as the session
// cwd directly, no worktree.
test.beforeAll(() => {
  for (const dir of ["/tmp/e2e-engram", "/tmp/e2e-nimbus"])
    mkdirSync(dir, { recursive: true });
});
// A fresh install: no projects/threads, but the default roster (a real host
// boots emptyState() with these). Harnesses are forced to `mock` so nothing
// can spawn a real CLI even if a test were to tag from this state.
const EMPTY_BOARD = {
  projects: [],
  threads: [],
  roster: [
    { handle: "fable-5", harness: "mock", color: "#7c6df2" },
    { handle: "gpt-5.6", harness: "mock", color: "#0f9d8f" },
    { handle: "grok-4.5", harness: "mock", color: "#d97706" },
    { handle: "demo-bot", harness: "mock", color: "#8b8d98" },
  ],
};

// A deterministic doctor stub — the roster editor renders these rows instead
// of probing the machine's real CLIs (which would be slow and flaky in CI).
const DOCTOR_FIXTURE = {
  harnesses: {
    "claude-code": {
      bin: "claude",
      found: true,
      version: "2.1.0",
      auth: "signed in",
      models: ["claude-fable-5"],
    },
  },
  staggerMs: 0,
  initialDelayMs: 0,
};

// ── Isolation ─────────────────────────────────────────────────────────────
// Board state lives on the shared host, so each test resets it to empty over
// PUT /api/state. Tab/onboarding state still lives in localStorage — clear it
// too. sessionStorage-guarded: addInitScript reruns on every navigation, and
// the tab-restore test reloads mid-test — the guard keeps that reload from
// wiping elan.tabs.v1. The doctor fixture is (re)installed on every
// navigation so mid-test reloads keep deterministic detection.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.put(`${HOST_URL}/api/state`, { data: EMPTY_BOARD });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__e2e_cleared")) {
      localStorage.clear();
      sessionStorage.setItem("__e2e_cleared", "1");
    }
  });
  await page.addInitScript((fx) => {
    (window as unknown as { __ELAN_DOCTOR_FIXTURE__: unknown }).__ELAN_DOCTOR_FIXTURE__ = fx;
  }, DOCTOR_FIXTURE);
  await page.goto("/");
});

// ── Fixture ───────────────────────────────────────────────────────────────
// A compact hand-rolled BoardState: two projects, four threads, a resolved
// agent-vs-agent exchange, and a bare thread with nothing but its "created"
// event. Ids are stable slugs (not uuids) so the
// tests below can reference them directly. Kept in sync with the shapes in
// src/lib/board/types.ts by hand — this file doesn't import app source.
const FLAGSHIP = "Design the engram geometry experiment"; // ENG-1, resolved exchange
const SECOND_THREAD = "Ship the CLI similarity command"; // ENG-2
const BARE_THREAD = "Write onboarding doc for engram schema"; // ENG-3, bare feed
const FIXTURE_THREAD_COUNT = "4";

function buildFixture() {
  const NOW = Date.now();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const ago = (ms: number) => NOW - ms;

  return {
    projects: [
      {
        id: "proj-eng",
        key: "ENG",
        name: "Engram",
        repoPath: "/tmp/e2e-engram",
        color: "#7c6df2",
        createdAt: ago(30 * HOUR),
      },
      {
        id: "proj-eln",
        key: "ELN",
        name: "Nimbus",
        repoPath: "/tmp/e2e-nimbus",
        color: "#5e6ad2",
        createdAt: ago(28 * HOUR),
      },
    ],
    // Against a real host, tagging SPAWNS the rostered harness — so every
    // entry is `mock` (a credential-free local process), never a real CLI.
    // The handles keep their real-looking names; only the harness is mock.
    roster: [
      { handle: "fable-5", harness: "mock", color: "#7c6df2" },
      { handle: "gpt-5.6", harness: "mock", color: "#0f9d8f" },
      { handle: "grok-4.5", harness: "mock", color: "#d97706" },
      { handle: "demo-bot", harness: "mock", color: "#8b8d98" },
    ],
    threads: [
      {
        id: "thread-eng-1",
        projectId: "proj-eng",
        number: 1,
        title: FLAGSHIP,
        body: "",
        labels: [],
        createdBy: "user",
        createdAt: ago(3 * HOUR),
        updatedAt: ago(30 * MIN),
      },
      {
        id: "thread-eng-2",
        projectId: "proj-eng",
        number: 2,
        title: SECOND_THREAD,
        body: "",
        labels: [],
        createdBy: "user",
        createdAt: ago(6 * HOUR),
        updatedAt: ago(5 * HOUR),
      },
      {
        id: "thread-eng-3",
        projectId: "proj-eng",
        number: 3,
        title: BARE_THREAD,
        body: "",
        labels: [],
        createdBy: "user",
        createdAt: ago(1 * HOUR),
        updatedAt: ago(1 * HOUR),
      },
      {
        id: "thread-eln-1",
        projectId: "proj-eln",
        number: 1,
        title: "Pick roster avatar colors",
        body: "",
        labels: [],
        createdBy: "user",
        createdAt: ago(2 * HOUR),
        updatedAt: ago(2 * HOUR),
      },
    ],
    posts: [
      {
        id: "eng1-root",
        threadId: "thread-eng-1",
        author: "fable-5",
        body: "Plan ready for review.",
        createdAt: ago(50 * MIN),
        kind: "comment",
        attachments: [],
      },
      {
        id: "eng1-reply1",
        threadId: "thread-eng-1",
        author: "gpt-5.6",
        body: "One nit: retries need a cap.",
        replyTo: "eng1-root",
        createdAt: ago(40 * MIN),
        kind: "comment",
        attachments: [],
      },
      {
        id: "eng1-resolution",
        threadId: "thread-eng-1",
        author: "fable-5",
        body: "Capped at 3 — approved.",
        replyTo: "eng1-root",
        createdAt: ago(30 * MIN),
        kind: "resolution",
        attachments: [],
      },
    ],
    events: [
      { id: "eng1-ev1", threadId: "thread-eng-1", actor: "user", type: "created", payload: {}, at: ago(3 * HOUR) },
      { id: "eng2-ev1", threadId: "thread-eng-2", actor: "user", type: "created", payload: {}, at: ago(6 * HOUR) },
      { id: "eng3-ev1", threadId: "thread-eng-3", actor: "user", type: "created", payload: {}, at: ago(1 * HOUR) },
      { id: "eln1-ev1", threadId: "thread-eln-1", actor: "user", type: "created", payload: {}, at: ago(2 * HOUR) },
    ],
    sessions: [],
  };
}

/** Seeds the fixture onto the host over PUT /api/state, then reloads so the
 *  UI picks it up from the host's full-state push, and waits for the flagship
 *  thread to render. */
async function seedFixture(page: Page) {
  await page.request.put(`${HOST_URL}/api/state`, { data: buildFixture() });
  await page.reload();
  await expect(page.getByText(FLAGSHIP)).toBeVisible();
}

/** Click a thread row on the board and wait for its thread view. */
async function openThread(page: Page, title: string) {
  await page.getByText(title).click();
  await expect(page.locator("h1")).toHaveText(title);
}

const composer = (page: Page) => page.getByPlaceholder("Send a message…");
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]');

// ── 1 · First run ─────────────────────────────────────────────────────────

test("first run shows Welcome, one board tab, no demo data", async ({ page }) => {
  // The pitch + the one call to action — the demo button is gone.
  await expect(
    page.getByText("An issue tracker where the assignees are your model subscriptions."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open a project…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explore the demo" })).toHaveCount(0);
  await expect(page.getByText("Explore the demo")).toHaveCount(0);

  // Exactly one tab — the persistent board tab, following the Inbox selection.
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Inbox" })).toBeVisible();

  // A fresh board has no projects and no threads.
  await expect(page.getByText("No projects yet.")).toBeVisible();
  await expect(page.getByText(FLAGSHIP)).toHaveCount(0);
});

// ── 2 · Fixture board renders ─────────────────────────────────────────────

test("a seeded board renders: flat list, key chips, both projects", async ({ page }) => {
  await seedFixture(page);

  // No status grouping (statuses were removed 2026-07-11) — all four rows
  // render in one flat, recency-ordered list.
  await expect(page.getByText(SECOND_THREAD)).toBeVisible();
  await expect(page.getByText(BARE_THREAD)).toBeVisible();

  // Inbox rows carry project key chips (inbox is cross-project).
  await expect(page.getByText("ENG", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("ELN", { exact: true }).first()).toBeVisible();

  // The flagship row, and both projects in the sidebar.
  await expect(page.getByText(FLAGSHIP)).toBeVisible();
  await expect(sidebar(page).getByText("Engram", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText("Nimbus", { exact: true })).toBeVisible();
});

// ── 3 · Add a project (browser fallback) ─────────────────────────────────

test("Open a project… creates a project via the inline path input", async ({ page }) => {
  await page.getByRole("button", { name: "Open a project…" }).click();

  // Browser dev has no native picker — the button swaps to a path input.
  const input = page.getByPlaceholder("/path/to/repo");
  await expect(input).toBeVisible();
  await input.fill("/tmp/e2e-repo");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The first project lands on onboarding step 2 first — "Assemble your
  // team" (docs/FRONTEND.md): the default roster as editable rows and the
  // host-backed detection list. The doctor fixture (beforeEach) resolves a
  // deterministic Claude Code row under "Available on this machine".
  await expect(page.getByRole("heading", { name: "Assemble your team" })).toBeVisible();
  await expect(page.getByText("Available on this machine")).toBeVisible();
  await expect(page.getByText("Claude Code").first()).toBeVisible();
  await expect(page.getByLabel("Agent handle").first()).toHaveValue("fable-5");
  await page.getByRole("button", { name: "Start working" }).click();

  // …then the new project's empty board; name = folder basename.
  await expect(page.locator("h1")).toHaveText("e2e-repo");
  await expect(page.getByText("No threads yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New thread", exact: true }).first()).toBeVisible();

  // And the sidebar now lists it.
  await expect(sidebar(page).getByText("e2e-repo", { exact: true })).toBeVisible();

  // Dismissal persists (elan.onboarding.roster.v1) — a reload goes straight
  // to the board (selection resets to Inbox), the step never comes back.
  await page.reload();
  await expect(page.getByText("No threads yet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assemble your team" })).toHaveCount(0);
});

// ── 4 · Draft flow ────────────────────────────────────────────────────────

test("draft: created on first keystroke, survives close; untouched draft discards", async ({ page }) => {
  await seedFixture(page);
  await expect(page.locator("h1 + span")).toHaveText(FIXTURE_THREAD_COUNT);

  // "New thread" opens a fresh selected tab with the ghost title focused.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /New thread/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const title = page.getByPlaceholder("New thread");
  await expect(title).toBeFocused();

  // First keystroke creates the thread: breadcrumb locks to KEY-N (first
  // project in the fixture is Engram, already at ENG-3), the Activity
  // section + composer fade in below.
  await title.fill("Ship the e2e suite");
  await expect(page.getByText("Engram › ENG-4")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(composer(page)).toBeVisible();

  // Close the tab via its ✕ — the thread survives and shows on the board.
  await page.getByRole("button", { name: "Close Ship the e2e suite" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByText("Ship the e2e suite")).toBeVisible();
  await expect(page.locator("h1 + span")).toHaveText("5");

  // A second draft closed untouched is a discard — nothing new appears.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(page.getByPlaceholder("New thread")).toBeFocused();
  await page.getByRole("button", { name: "Close New thread" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator("h1 + span")).toHaveText("5");
});

// ── 5 · Tabs ──────────────────────────────────────────────────────────────

test("tabs: open, switch, Esc-close with fallback, restore across reload", async ({ page }) => {
  await seedFixture(page);

  // Open a thread → its tab appears, selected, and the view renders.
  await openThread(page, SECOND_THREAD);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: new RegExp(SECOND_THREAD) })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  // The properties rail has no Status row — statuses are gone.
  await expect(page.getByText("Status", { exact: true })).toHaveCount(0);

  // Open a second thread from the board tab → two thread tabs.
  await page.getByRole("tab", { name: "Inbox" }).click();
  await openThread(page, BARE_THREAD);
  await expect(page.getByRole("tab")).toHaveCount(3);

  // Click the first thread tab → switches back. Aim at the tab's padding,
  // not its center: hovering an unselected tab swaps its icon for the ✕
  // (browser-tab pattern), and on a collapsed icon-only tab that ✕ sits
  // exactly at the center — a dead-center click would close, not select.
  await page
    .getByRole("tab", { name: new RegExp(SECOND_THREAD) })
    .click({ position: { x: 6, y: 16 } });
  await expect(page.locator("h1")).toHaveText(SECOND_THREAD);

  // Esc (focus not in a field) closes the active tab and falls back to the
  // neighbor, not the board.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator("h1")).toHaveText(BARE_THREAD);

  // Open tabs + active tab persist across launches (elan.tabs.v1).
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator("h1")).toHaveText(BARE_THREAD);
});

// ── 6 · Messaging ─────────────────────────────────────────────────────────

test("messaging: user bubble with no author name, @mention popover, tagged event", async ({ page }) => {
  await seedFixture(page);
  await openThread(page, BARE_THREAD); // bare feed: only the created event

  // Send a message — it renders as a bubble, and the feed never says "You".
  await composer(page).fill("Board looks solid — shipping the e2e suite now.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page
      .locator('[class*="bg-secondary"]')
      .getByText("Board looks solid — shipping the e2e suite now."),
  ).toBeVisible();
  await expect(page.getByText("You", { exact: true })).toHaveCount(0);

  // "@" opens the mention popover listing the roster.
  await composer(page).click();
  await composer(page).pressSequentially("@");
  const popover = page.getByRole("listbox", { name: "Mention an agent" });
  await expect(popover).toBeVisible();
  for (const handle of ["fable-5", "gpt-5.6", "grok-4.5", "demo-bot"]) {
    await expect(popover.getByRole("option", { name: new RegExp(handle) })).toBeVisible();
  }

  // Arrow keys move the highlight; Enter inserts the highlighted handle.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(composer(page)).toHaveValue("@fable-5 ");
  await expect(popover).toHaveCount(0);

  // Sending the mention emits a tagged event line in the feed.
  await composer(page).pressSequentially("please write the doc");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/tagged @fable-5/).first()).toBeVisible();
});

// ── 7 · Exchanges ─────────────────────────────────────────────────────────

test("exchanges: resolved collapse row expands/collapses; reply lands in the rail", async ({ page }) => {
  await seedFixture(page);
  await openThread(page, FLAGSHIP);

  // Resolved exchange renders collapsed to one summary line.
  const summary = page.getByText("2 replies · fable-5 ⇄ gpt-5.6");
  await expect(summary).toBeVisible();

  // Expand: replies + the Collapse affordance appear.
  await summary.click();
  await expect(page.getByText(/One nit: retries need a cap\./)).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse", exact: true });
  await expect(collapse).toBeVisible();

  // Collapse again: replies hide, the summary line returns.
  await collapse.click();
  await expect(page.getByText(/One nit: retries need a cap\./)).not.toBeVisible();
  await expect(summary).toBeVisible();

  // Reply: hover the root comment → Reply → composer chip → send → the reply
  // renders indented in the exchange rail.
  await summary.click();
  const rootComment = page
    .locator('[class*="group/comment"]')
    .filter({ hasText: "Plan ready for review." })
    .first();
  await rootComment.hover();
  await rootComment.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText(/Replying to fable-5/)).toBeVisible();
  await composer(page).fill("Sounds right — proceed.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.locator('[class*="border-l-2"]').getByText("Sounds right — proceed."),
  ).toBeVisible();
});

// ── 8 · Delete project ────────────────────────────────────────────────────

test("delete project: sidebar ⋯ → confirm → last project gone returns Welcome", async ({ page }) => {
  await page.getByRole("button", { name: "Open a project…" }).click();
  await page.getByPlaceholder("/path/to/repo").fill("/tmp/e2e-delete-me");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // First project ⇒ the roster onboarding step shows; click through it.
  await page.getByRole("button", { name: "Start working" }).click();
  await expect(page.locator("h1")).toHaveText("e2e-delete-me");

  // Hovering the sidebar row reveals the ⋯ button (coexists with "+").
  const row = sidebar(page).getByText("e2e-delete-me", { exact: true });
  await row.hover();
  await page.getByRole("button", { name: "e2e-delete-me actions" }).click();
  await page.getByRole("menuitem", { name: "Delete project…" }).click();

  // Minimal inline confirm — Cancel first to prove it's a real gate.
  await expect(page.getByRole("heading", { name: "Delete e2e-delete-me?" })).toBeVisible();
  await expect(
    page.getByText("Removes the project and all its threads. This can't be undone."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Delete e2e-delete-me?" })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("e2e-delete-me");

  // For real this time: the last project goes, and the board falls back to
  // Welcome automatically (projects.length === 0) with no lingering tab.
  await row.hover();
  await page.getByRole("button", { name: "e2e-delete-me actions" }).click();
  await page.getByRole("menuitem", { name: "Delete project…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page.getByRole("button", { name: "Open a project…" })).toBeVisible();
  await expect(page.getByText("No projects yet.")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Inbox" })).toBeVisible();
});
