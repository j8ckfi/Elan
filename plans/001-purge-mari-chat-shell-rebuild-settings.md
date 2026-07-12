# Plan 001: Purge the orphaned Mari chat shell and rebuild Settings as Elan's

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP updating `plans/README.md` — your reviewer
> maintains the index.
>
> **Drift check (run first)**: `git diff --stat 84100c3..HEAD -- src/components/chat src/hooks src/lib/settings.ts src/App.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `84100c3`, 2026-07-12

## Why this matters

Elan is a fork of Mari (a chat-shell desktop frontend for agent CLIs) that
replaced the chat shell with a board UI. The chat-shell components were left
behind: six components and two hooks with **zero live importers**, plus a
Settings dialog that still says "Mari" in four user-visible strings, links to
the Mari repo, and renders three whole sections (Models / Pi runtime /
Sessions) whose settings keys are consumed by **nothing** except the orphaned
hook being deleted here. After this plan, the settings dialog contains only
controls that do something, and every user-visible string says Elan.

## Current state

Repo: Vite + React 19 + TypeScript + Tailwind v4, Tauri 2 desktop shell.
Package manager is **bun**. Fork policy (from `AGENTS.md`): Mari's *core*
(`src/lib/agent/`, `src/lib/adapters/`, `src-tauri/src/pi.rs`) is deliberately
kept intact — those files mention Mari in comments and that is fine. This plan
removes only the orphaned chat *shell* and dead settings.

### Orphaned files (verified zero importers at 84100c3)

- `src/components/chat/Conversation.tsx` — Mari's chat transcript view
- `src/components/chat/ComposerControls.tsx` — Mari's composer footer (imports ContextRing + ModelPicker)
- `src/components/chat/ContextRing.tsx` — imported only by ComposerControls
- `src/components/chat/ModelPicker.tsx` — imported only by ComposerControls
- `src/components/chat/ProjectBreadcrumb.tsx` — falls back to the title "Mari"
- `src/components/chat/SessionSidebar.tsx` — persists `mari.projectOrder` / `mari.collapsedProjects` localStorage keys
- `src/hooks/useAgentSession.ts` — Mari's chat-session hook; the ONLY consumer of settings keys `defaultModel`, `defaultThinking`, `piBinPath`, `extraPathDirs`
- `src/hooks/useChatScroll.ts` — chat scroll pinning, zero importers

**Files in `src/components/chat/` that are LIVE and must stay**:
`Markdown.tsx` (imported by `src/components/board/thread/ExchangeBlock.tsx`,
`ThreadView.tsx`) and `SettingsDialog.tsx` (imported by `src/App.tsx`).

### Settings keys and their consumers (verified at 84100c3)

| Key | Consumers outside settings.ts/SettingsDialog | Verdict |
|---|---|---|
| `theme` | `applyTheme` in settings.ts | KEEP |
| `glassSidebar` | `src/App.tsx:84` | KEEP |
| `defaultCwd` | none | DELETE |
| `defaultModel` | only `useAgentSession.ts:101` (being deleted) | DELETE |
| `defaultThinking` | only `useAgentSession.ts:183` (being deleted) | DELETE |
| `piBinPath` | only `useAgentSession.ts:102` (being deleted) | DELETE |
| `extraPathDirs` | only `useAgentSession.ts:103` (being deleted) | DELETE |
| `warmPoolSize` | none anywhere | DELETE |
| `autoCheckUpdates` | none — the "check on launch" toggle is wired to nothing | DELETE |

`parsePathDirs()` in `src/lib/settings.ts` is exported solely for
`useAgentSession` → delete it too. The `ThinkingLevel` import in settings.ts
dies with `defaultThinking`.

### settings.ts excerpt as it exists today (src/lib/settings.ts:23-54)

```ts
export interface Settings {
  theme: ThemePref;
  defaultCwd: string | null;
  defaultModel: string;
  defaultThinking: ThinkingLevel | null;
  piBinPath: string;
  extraPathDirs: string;
  warmPoolSize: number;
  autoCheckUpdates: boolean;
  glassSidebar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  defaultCwd: null,
  defaultModel: "openai-codex/gpt-5.5",
  ...
};
```

`load()` (settings.ts:58-68) merges `{ ...DEFAULT_SETTINGS, ...parsed }` —
after the prune it must **pick known keys explicitly** so stale keys in a
user's persisted `elan.settings` blob don't ride along forever.

### SettingsDialog.tsx — what changes (src/components/chat/SettingsDialog.tsx)

- Line 2 comment: "Grouped into General / Models / Pi / Sessions / About" — update to the new grouping.
- Line 24: `const REPO_URL = "https://github.com/j8ckfi/Mari";` → `"https://github.com/j8ckfi/Elan"` (verified: `git remote get-url origin` → `https://github.com/j8ckfi/Elan.git`).
- Lines 100–139: entire **Models** section (Default model, Default thinking level) — DELETE.
- Lines 141–167: entire **Pi runtime** section ("Override where Mari finds pi…") — DELETE.
- Lines 169–187: entire **Sessions** section ("…before Mari reaps them") — DELETE.
- Lines 190–219 **About** section: delete the "Automatic updates" toggle field (lines 191–199, key is dead); keep the working `UpdatesControl` (manual check — it works via `useUpdater`); line 202 desc "Mari updates from signed GitHub Releases." → "Elan updates from signed GitHub Releases."; line 208 `Mari <span…>v{__APP_VERSION__}` → `Elan …`.
- Keep: General section (Theme, Glass sidebar, **but DELETE the "Default working directory" field** — `defaultCwd` is dead), Agents section (RosterEditor), the reset button, all layout helpers (`Section`, `Field`, `Segmented`, `Toggle`), `UpdatesControl`.
- After deleting the Models section, the now-unused imports (`ThinkingLevel`, `THINKING_LABELS`) must go.

### Conventions

- Comment style: terse, design-rationale comments (see any file above). Match density.
- Styling: className strings with `cn()` from `@/lib/utils`; no CSS modules.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `bunx tsc --noEmit` | exit 0, no errors |
| Unit tests | `bun test tests` | all pass |
| E2E | `bun run e2e` | all pass (boots its own Vite on :5177) |

E2E requires Playwright browsers; if `bun run e2e` fails with a missing-browser
error, run `bunx playwright install chromium` once.

## Scope

**In scope** (the only files you may modify/delete):
- DELETE: `src/components/chat/Conversation.tsx`, `ComposerControls.tsx`, `ContextRing.tsx`, `ModelPicker.tsx`, `ProjectBreadcrumb.tsx`, `SessionSidebar.tsx`, `src/hooks/useAgentSession.ts`, `src/hooks/useChatScroll.ts`
- EDIT: `src/lib/settings.ts`, `src/components/chat/SettingsDialog.tsx`

**Out of scope** (do NOT touch):
- `src/components/chat/Markdown.tsx`, `src/lib/agent/**`, `src/lib/adapters/**`, `src-tauri/**` — Mari's inherited core, kept by fork policy.
- `src/components/board/**` (RosterEditor renders inside the dialog but is not edited here).
- The `.mari-md` CSS namespace in `src/index.css` — internal naming, by-design.
- `src/lib/board/**`, `e2e/**` — plan 002's territory.
- Docs (`docs/**`, `AGENTS.md`).

## Git workflow

- Branch: `advisor/001-purge-mari-chat-shell`
- Commit per step; message style matches repo (`git log`): short imperative summary line, e.g. "Delete the orphaned Mari chat shell".
- Do NOT push or open a PR.

## Steps

### Step 1: Verify orphanhood, then delete the eight files

For each file to delete, confirm zero importers first:

```sh
for n in Conversation ComposerControls ContextRing ModelPicker ProjectBreadcrumb SessionSidebar useAgentSession useChatScroll; do
  echo "-- $n"; grep -rln "$n" src tests e2e --include='*.ts*' | grep -v "chat/$n\|hooks/$n"
done
```

Expected: each `-- name` prints **no file paths** below it, EXCEPT
`useAgentSession` may show `src/lib/agent/reducer.ts` — that is a **comment
mention only** (reducer.ts:390); confirm with `grep -n "useAgentSession"
src/lib/agent/reducer.ts` that it's inside a comment, and leave reducer.ts
untouched. If any *import* of a to-be-deleted file exists, STOP.

Then delete all eight files.

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 2: Prune settings.ts

In `src/lib/settings.ts`:
1. Reduce `Settings` to `{ theme: ThemePref; glassSidebar: boolean }` (keep the doc comments on the surviving keys).
2. Reduce `DEFAULT_SETTINGS` to match (`theme: "system"`, `glassSidebar: false`).
3. Delete `parsePathDirs` and the now-unused `ThinkingLevel` import.
4. Rewrite `load()` to pick known keys explicitly instead of spreading, so stale persisted keys are dropped:

```ts
const parsed = JSON.parse(raw) as Partial<Settings>;
return {
  theme: parsed.theme ?? DEFAULT_SETTINGS.theme,
  glassSidebar: parsed.glassSidebar ?? DEFAULT_SETTINGS.glassSidebar,
};
```

(Validate `theme` is one of "system" | "light" | "dark", else default —
one-line guard.)

**Verify**: `bunx tsc --noEmit` → errors ONLY in `SettingsDialog.tsx`
(references to deleted keys), nowhere else. If errors appear in any other
file, STOP — an unaccounted consumer exists.

### Step 3: Rebuild SettingsDialog

Apply the changes listed in "Current state → SettingsDialog.tsx". Resulting
section order: **General** (Theme, Glass sidebar) → **Agents** (RosterEditor)
→ **About** (Updates control, "Elan vX.Y.Z", GitHub link). Update the file's
header comment to describe the new grouping.

**Verify**: `bunx tsc --noEmit` → exit 0. Then
`grep -rn "Mari" src/components/chat/SettingsDialog.tsx` → no matches.

### Step 4: Full verification

**Verify**:
- `bun test tests` → all pass
- `bun run e2e` → all pass
- `grep -rn "warmPoolSize\|piBinPath\|extraPathDirs\|defaultModel\|defaultThinking\|defaultCwd\|autoCheckUpdates" src/` → matches ONLY in `src/lib/adapters/` and `src/lib/agent/` (adapter-internal defaults, out of scope), zero matches in `src/lib/settings.ts`, `src/components/`, `src/App.tsx`, `src/hooks/`

## Test plan

No new tests: this plan only deletes dead code and dead UI. The gate is the
existing suites (`bun test tests`, `bun run e2e`) plus the greps above. If any
existing test imports a deleted file, that contradicts Step 1's verification —
STOP rather than editing the test.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test tests` exits 0
- [ ] `bun run e2e` exits 0
- [ ] The 8 orphan files no longer exist
- [ ] `grep -rn "Mari" src/components/chat/ src/lib/settings.ts` → no matches
- [ ] `grep -c "j8ckfi/Elan" src/components/chat/SettingsDialog.tsx` → 1
- [ ] `git status` shows no modified files outside the in-scope list

## STOP conditions

Stop and report back (do not improvise) if:

- Any to-be-deleted file has a real (non-comment) importer.
- After Step 2, typecheck errors appear outside `SettingsDialog.tsx`.
- An e2e test asserts on the Models / Pi runtime / Sessions sections or the
  "Automatic updates" toggle (none did at 84100c3).
- The `Settings` interface has gained new keys since 84100c3 (drift).

## Maintenance notes

- Plan 002 (always-host) touches `RosterEditor`, which renders inside this
  dialog's Agents section — no file overlap, but a reviewer merging both
  should re-open Settings once and glance at the Agents section.
- If a future feature needs per-app settings (e.g. host URL override), extend
  the pruned `Settings` interface — the pick-known-keys `load()` makes adding
  keys safe.
- Reviewer should scrutinize: that `UpdatesControl` still renders and the
  manual check works in the desktop app (browser dev shows "Desktop app only").
