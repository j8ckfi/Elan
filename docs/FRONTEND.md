# FRONTEND.md — Elan's design language

> This file replaces Mari's FRONTEND.md per Mari's own fork instructions.
> Agents building Elan follow **this** document. Mari's motion/token bones
> are inherited deliberately; the surface language is new.

**The reference is Linear.** For the content panel we are 1:1 copying
Linear's issue view — layout, density, hierarchy, glyph vocabulary — until we
have reason to diverge. The sidebar is ours (projects + threads, not Linear's
sidebar). When unsure how something should look, the answer is "how does
Linear render this?", not invention.

## Inherited from Mari (keep, don't relitigate)

- **Tokens** in `src/index.css`: `--background/--foreground/--border/--hover/
  --muted-foreground/--surface-*/--shadow-*`, light+dark via `.dark`. Never
  hard-code colors; extend the token block if a token is missing.
- **Motion**: `--ease-out: cubic-bezier(0.23,1,0.32,1)`, durations < 300ms,
  `:active` scale ~0.97 on pressables, origin-aware popovers, no `scale(0)`
  entrances, no `transition: all`. Hidden interactive elements are also
  non-interactive (`pointer-events-none`, `tabIndex={-1}`, `aria-hidden`).
- **Radius**: `--radius: 6px` cascading to `rounded-*`; "properly square."
- **No pulsing green dots** for liveness — ever. Working state uses label
  shimmer (`.shimmer-run`) or the rose loader.
- Variable-font weight transitions (`src/lib/font-weight.ts`) over weight
  jumps; icon indirection via `src/lib/icon-context.tsx`.
- Base UI + the existing `src/components/ui/*` primitives (dropdown, dialog,
  tooltip, scroll-area, sidebar shell). Build on them.

## Density & type (Linear numbers)

Linear is *dense*. Mari's chat was airy; Elan is not.

- Base UI text: **13px/1.4**; secondary/meta: **12px**; thread title in the
  content panel: **21px semibold**; list rows: **13px**.
- Row heights: sidebar items 30px, thread-list rows 36px, activity lines 28px.
- Paddings in 4px steps; content column max-width ~ **44rem**, properties
  rail fixed **280px**.
- Font stack: keep Mari's (system/Inter-ish). No new fonts.

## The layout

```
┌──────────┬──────────────────────────────────────────────┐
│ Sidebar  │ [ Inbox ][ ◔ tab ][ ⣿ tab ✕ ]   ← tab row    │
│ 244px    ├───────────────────────────────┬──────────────┤
│          │  Content panel                │ Properties   │
│          │  (board tab: thread list;     │ rail 280px   │
│          │   thread tab: thread view     │ (thread view │
│          │   or draft page)              │  only)       │
└──────────┴───────────────────────────────┴──────────────┘
```

### The tab row

FF `TabsSubtle` in `activeLabel` mode (`src/components/board/TabStrip.tsx`),
inline with the traffic lights (h-9, drag region in dead space):

- **One persistent board tab** (index 0, never closable, inbox icon). Its
  label follows the sidebar selection (Inbox / My threads / project name);
  clicking a sidebar item fronts it.
- **One tab per open thread.** Unselected tabs collapse to their icon; the
  selected tab expands its title (FF's animated label collapse).
- **The tab icon is the working grid** — the brand's 3×3 matrix. Still and
  grey (`StillGrid`, currentColor at low opacity) while nothing runs; the
  animated `gradient-spin` while any session in that thread is running. The
  strip doubles as the fleet monitor, and it is the ONLY place the gradient
  appears — everything else in the app is system monochrome.
- Close: the selected tab carries ✕ after its label; unselected (icon-only)
  tabs close via middle-click or select-then-✕ — the pinned-tab pattern.
  (Hover-✕-replaces-icon was tried and rejected: it covers a collapsed
  tab's whole visible center, so clicking to select closed it.) Esc closes
  the active thread tab unless focus is in a field.
- Open tabs + active tab persist across launches (`elan.tabs.v1`); tabs
  whose thread no longer exists are dropped on hydrate.

### First run (Welcome)

A fresh board (`projects.length === 0`) never shows demo data — it shows
**Welcome**, centered in the content pane (sidebar renders normally with
"No projects yet" under Projects; tab row shows just the board tab):

```
                    Elan

     An issue tracker where the assignees
         are your model subscriptions.

   File a thread, tag an agent, watch it work.
   Agents plan, argue, review, and merge on a
   shared board — you only see the surface.

              [ Open a project… ]
```

- Wordmark 15px medium; pitch line 21px semibold foreground; the two
  supporting lines 13px muted, max-w ~26rem, centered.
- **Open a project…** — primary button. Desktop: the Tauri folder picker
  (`@tauri-apps/plugin-dialog`, dynamic import — crib
  `ProjectBreadcrumb.tsx`); browser dev: swaps inline to a small path
  input + Add. Creates the project (name = folder basename, key derived),
  selects it, fronts the board tab: the empty thread list's "No threads
  yet + New thread" takes it from there — the existing draft flow is the
  rest of onboarding.
- No demo button (the demo was removed from the product), no carousel, no
  tour, no checklists. The product teaches itself through
  the empty states; Welcome's only job is the first project or the demo.

### The roster editor ("Agents")

One component, two dressings: a section in SettingsDialog (always
available) and the onboarding step (below). Built on the host's doctor v2 +
`PUT /api/roster`; in local mode (no host) it renders the roster list as
editable rows but shows "connect a host to detect CLIs" in place of
detection.

- **Your team** (top): current roster entries as rows — harness mark ·
  editable handle (13px, inline text input styled as text until focused) ·
  harness displayName 12px muted · model pin (12px muted, editable, empty =
  "harness default") · hover ✕ to remove. "user" cannot exist as a handle;
  duplicates refuse inline (red hairline + 12px note).
- **Available on this machine** (below): one row per registry harness,
  populating PROGRESSIVELY as doctor probes land — this is the magic and it
  must feel alive without being noisy: each row starts as mark + name +
  small shimmer-text "Probing…" label, resolves to version +
  auth state ("v2.1.197 · signed in" 12px muted, or "not installed" /
  "not signed in" muted with the CLI's fix-it hint as a title tooltip).
  When a harness supports discovery, its row expands (chevron) to the
  discovered model list — each model row has a quiet "Add" affordance that
  creates a roster entry (handle prefilled from the model id's last
  segment, slugified; immediately editable). No "Scan" button anywhere —
  detection just happens on open, `?refresh` on reopen.
- Adding from a harness with NO discovery (null) shows one "Add agent" row
  with a free-text model field ("uses the CLI's default when empty").

### Onboarding, step 2 — "Assemble your team"

After the first project is created (Welcome step 1), the empty board shows
the roster editor in onboarding dress instead of the bare empty state, one
time: heading "Assemble your team" 21px semibold, subline "These CLIs are
on your machine. Pick the models you want on the board." 13px muted, the
same detection list, and a primary "Start working" button (skippable —
defaults remain if untouched). Dismissal is remembered
(`elan.onboarding.roster.v1` in localStorage); the same editor lives in
Settings forever after.

### Session telemetry (the turn block)

The activity feed's `session-start` event IS the **turn block** when
telemetry exists — one byline, work and speech in one grammar (2026-07-11):

- **The byline**: agent mark (18px) + handle (13px medium) + the worked
  chip. The chip is the `ThinkingSteps` trigger — clicking it opens the
  timeline in place, indented under the byline. There is no separate
  "started a session" line when the block renders.
- **Live turn**: the chip is the shimmering current-step label
  (`.shimmer-run`, monochrome — no gradient outside the tab bar), fed by
  the WS `session-line` stream folded through the harness adapter + core
  reducer. Collapsed by default (growing timelines drag the reader).
- **Resting turn**: the chip reads "worked 42s · 12 steps ▸"; expanding
  lazily fetches `GET /api/sessions/:id/log`, folds once, and renders the
  same timeline. Error sessions keep the ⚠︎ post as the headline; the
  block is the work detail.
- Harnesses without a stream adapter render the raw log tail in a fenced
  block instead — honest fallback, same affordance.
- Local mode / logless session: the block yields to its fallback — the
  plain "started a session" event line.

### Sidebar (ours, not Linear's)

Top→bottom: an empty header strip (NO wordmark — the user knows what app
they're in; it only keeps the traffic-light inset, handled as in Mari's
App.tsx) · **Inbox** · **My threads** · a **Projects** section — each
project expandable to its threads (title only, truncated) · footer:
settings gear. Project rows are **text only** — no color swatches. Selected
row: `bg-sidebar-accent` full-row pill (5px radius); hover: `--hover`.
Section labels: 12px medium muted ("Projects"), like Linear — no ALL-CAPS.
Clicking a thread opens/focuses its tab; clicking a project fronts the board
tab.

### Thread list (content panel, board tab)

Linear's issue list, 1:1:

- Header row (below the tab row): view name + count, right side
  "＋ New thread" button.
- One flat list, recency-ordered (updatedAt desc) — **no status grouping**;
  statuses do not exist in Elan (removed 2026-07-11: they confused agents,
  and long-lived threads have no lifecycle).
- Row anatomy, left→right: `KEY-N` in 12px muted mono-ish · title (13px,
  truncates) · spacer · agent avatar stack (18px) · updated-at (12px
  muted). **No priority** — priority does not exist either (the human
  arbitrates; agents read policy files, not columns).
- Whole row clickable → opens the thread's tab; hover `--hover`.

### New thread (draft page, Notion-style)

"New thread" opens a **new tab** with a draft surface
(`src/components/board/thread/DraftThread.tsx`), never a dialog:

- Quiet project picker (12px muted, top-left; locked to `KEY-N` breadcrumb
  once created) · ghost title (21px semibold, "New thread", autofocused,
  Enter → body) · ghost description (13px, "Description…").
- The thread is **created on the first title keystroke** and live-synced
  (debounced) after; closing the tab with an empty title discards it.
- Once real, the Activity section + composer fade in below (≤250ms,
  `--ease-out`) — the draft is just a thread you're still titling.

### Thread view (content panel, thread tab) — the Linear issue view

- No top bar — the tab row owns navigation. Content starts at the title.
- Title: 21px semibold, editable-looking (v1: static text).
- Body: markdown (reuse `src/components/chat/Markdown.tsx`), 13px.
- **Activity section** ("Activity" 13px medium header): the merged,
  time-ordered feed of events + posts — **the turn ledger** (2026-07-11).
  Three rhythm passes run over the merged list: consecutive `caught-up`
  events fold into one quiet line, a same-author agent exchange within 3
  minutes of a bare (replyless, unresolved) predecessor tucks under its
  byline (compact — no header, body aligned), and **day dividers** (11px
  uppercase, hairlines both sides; Today/Yesterday/"Mon, Jul 7") land where
  the calendar turns. The reader gets three speeds: skim the ledger, expand
  a post, open the telemetry.
  - **Events** render as single 28px lines: actor avatar (14px) + muted text
    ("**user** tagged @fable-5 · 2m"). **User events have
    no avatar and no actor name** — they read in the agentless voice
    ("Created the thread · 3d", first letter capitalized): the human is the
    board's implicit narrator.
  - **Quiet turns**: a turn that (correctly) posted nothing files a
    `caught-up` event — rendered as one extra-muted line ("✓ grok-4.5 and
    laguna-m.1 caught up — nothing needed · 2m"), consecutive ones merged.
    Silence is an answer; the line shows the ping was heard.
  - **Agent posts** render as comment cards: 24px avatar (brand mark),
    author name 13px medium, markdown body. No bubbles — flat, divided by
    whitespace, like Linear comments (subtle 1px border card on hover only).
    Reply/Resolve float in the card's top-right on hover — an in-flow row
    would reserve height under every post and bloat the ledger's rhythm.
    **Timestamps ride the hover** (opacity 0 → 100 on the card) — the ledger
    reads by rhythm, not clock. **Long posts fold**: bodies over ~6 lines
    (132px, measured with 40px slack) clamp with a fade-to-background and a
    "Show more"/"Show less" toggle; resolutions and user bubbles never fold.
  - **Addressed to you**: an agent post whose body mentions `@user` carries
    the ledger's ONLY emphasis — a 2px foreground left rail on the card and
    a small "→ you" chip in the byline. These are what Inbox will aggregate.
    (`@user` also bolds like a roster mention in markdown.)
  - **User posts are bubbles** — the human and the agents are different
    sides of the product, and the feed shows it: left-aligned bubble
    (`--secondary` bg, 10px radius, max-width 85%), **no avatar, no name,
    no "You" anywhere**, timestamp 12px muted outside the bubble's bottom
    right. Inside an exchange, the bubble slots into the reply rail
    chronologically like any reply. A user ⚑ resolution is the same bubble
    in `--accent` with a small flag + "Resolved" header. The bubble shape
    deliberately rhymes with the composer.
  - **Exchanges** (post + replies): replies indent 32px under the parent.
    Resolved ⇒ collapsed to one 28px line: `▸ 14 replies · fable-5 ⇄ gpt-5.6`
    followed by the ⚑ resolution text in 13px. Click expands in place
    (height auto animation ≤ 250ms, `--ease-out`). Unresolved exchanges
    render expanded.
  - **⚑ resolution posts** get a small flag glyph + slightly emphasized
    background tint (`--accent`).
- **Composer** docked at the bottom of the activity feed (not floating):
  quiet card with "Send a message…" placeholder and a "Send" button, `@`
  triggers the mention popover (roster entries: avatar + handle + harness
  subtitle), Cmd+Enter submits. The look is Linear's comment box: 1px
  border, 6px radius, no glow. You message the room; you don't "comment."
  **The composer is summon-aware**: mentions are load-bearing (a mention IS
  a spawn), so draft @handles — plus reply mode's implicit ping to the
  exchange root's author — surface as a dashed "summons fable-5" chip on
  the send row before the user commits.

### Properties rail (thread view only)

Right-aligned 280px column, 12/13px rows with muted labels, exactly Linear:
Agents (roster members with sessions in this thread; avatar + handle +
session state) · Project (text only) · Labels · Created/Updated meta at the
bottom in 12px muted. Display only in v1.

## Glyph vocabulary

There is **no status glyph and no priority glyph** — both were deliberately
deleted from the product (priority 2026-07-10, statuses 2026-07-11). Don't
reintroduce either. The glyph vocabulary is: agent marks (below), the tab
bar's working grid, and the ⚑ resolution flag.

## Avatars

- **Agents wear their brand mark, bare** (the Synara pattern, minus the
  chrome): no disc, no border, no tint — just the mark in the **system
  color** (`text-foreground`: dark on light, light on dark). The marks are
  the *product* icons, not the company wordmarks: the **Claude starburst**
  for claude-code (never the Anthropic "A\\"), the **OpenAI blossom** for
  codex, **Grok's black hole** for grok. Sourced from LobeHub's mono icon
  set and generated into `src/components/board/harness-icons.ts` by
  `bun dev/gen-harness-icons.ts` — bundled with the app, no runtime
  fetches. New harness → add the mapping in the generator and rerun.
  Unknown harness → initials-circle fallback; mock → the `›_` prompt glyph.
- **The human has no avatar in the feed** — user posts are bubbles, user
  events are agentless lines, the composer has no gutter. Where a user mark
  is unavoidable (mention popovers etc.) it's a bare monochrome person
  silhouette (`UserGlyph`), same register as the agent marks — never a
  colored or gradient disc.
- Sizes: 18px in lists, 24px on comment roots, 20px on replies, 14px on
  event lines; marks render at 85% of the slot. `AvatarStack` is a tight
  gap-1 row (bare marks don't overlap legibly the way discs do).

## Liveness on the board

One grammar, two signals:

- **`gradient-spin`** (the matrix spinner) = "a harness process is live right
  now." It appears in exactly ONE place: the thread tab's icon slot, where
  the still grey grid ignites. Everywhere else, liveness is monochrome.
- **`.shimmer-run`** / **`.shimmer-text`** on text = "this object contains
  live work" (list rows, sidebar thread rows, the rail's Running chip,
  session-block headers, roster probing labels).
- The running agent's avatar gets a 2px `--ring` outline. Waiting = hollow
  clock glyph · Done/Error = muted text. Never a pulsing dot, anywhere.

## House rules

1. Match the file you're editing: comment density, naming, idiom.
2. When Linear has an answer, copy it; when it doesn't, Mari's restraint
   rules apply (remove chrome rather than add).
3. Empty states are designed, not left over (empty project → "No threads
   yet" + New thread button, centered, 13px muted).
4. Both states of anything that appears/disappears are designed; hidden ⇒
   non-interactive.
5. All timestamps relative ("2m", "3h", "Jul 9") via one shared helper.
6. The board must render fine with zero sessions/orchestration — it is a
   pure function of `BoardState`.
