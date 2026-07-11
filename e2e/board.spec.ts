// End-to-end: the board UI in a real browser against the local (localStorage)
// store — no host, no agent CLI, no credentials. The demo is gone from the
// product (docs/DATA-MODEL.md: "There is no demo board in the product" —
// removed 2026-07-10), so tests that need pre-existing data build their own
// fixture by writing `elan.board.v3` directly before the app boots
// (seedFixture below), the same way a real user's board would already have
// history. Pure product-path tests (first run, project creation, the draft
// flow, delete-project) stay fixture-free — they start from an empty board
// exactly like a fresh install.
// The assertions come straight from docs/FRONTEND.md: First run, the tab row,
// the draft page, the thread view. Orchestration is covered elsewhere.

import { expect, test, type Page } from "@playwright/test";

// ── Isolation ─────────────────────────────────────────────────────────────
// Each test gets a fresh context, but clear storage anyway so a reused
// profile can't leak a board in. sessionStorage-guarded: addInitScript reruns
// on every navigation, and the tab-restore test reloads mid-test — the guard
// keeps that reload from wiping elan.board.v3 / elan.tabs.v1.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__e2e_cleared")) {
      localStorage.clear();
      sessionStorage.setItem("__e2e_cleared", "1");
    }
  });
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
    roster: [
      { handle: "fable-5", harness: "claude-code", color: "#7c6df2" },
      { handle: "gpt-5.6", harness: "codex", color: "#0f9d8f" },
      { handle: "grok-4.5", harness: "grok", color: "#d97706" },
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

/** Writes the fixture to `elan.board.v3` via addInitScript (so it's present
 *  before the app's first render, not raced in after) and reloads to pick it
 *  up. The init script re-fires on any later reload within the same test
 *  too — harmless, since it just re-asserts the same fixture. */
async function seedFixture(page: Page) {
  const state = buildFixture();
  await page.addInitScript((s) => {
    localStorage.setItem("elan.board.v3", JSON.stringify(s));
  }, state);
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
  // team" (docs/FRONTEND.md): the default roster as editable rows and, in
  // local mode, the connect-a-host note in place of the detection list.
  await expect(page.getByRole("heading", { name: "Assemble your team" })).toBeVisible();
  await expect(page.getByText("Connect a host to detect CLIs and models.")).toBeVisible();
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
