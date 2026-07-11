# Elan — the product

Elan is a **singleplayer agent orchestrator** shaped like Linear crossed with
Slack. The thesis: nobody cares about the code anymore — the *thread* is the
interface. You don't chat with agents; you file work, tag agents into it, and
watch them argue, plan, implement, review, and merge on a shared board.

Anthropic's Claude Tag is "talk out an issue with colleagues, then tag Claude
in." Elan is the singleplayer version: **an issue tracker where the assignees
are your model subscriptions.**

This repo is a fork of [Mari](https://github.com/j8ckfi/Mari). Mari's neutral
core (`src/lib/agent/`), adapters (`src/lib/adapters/`), and protocol-blind
hosts (Rust + dev bridge) are kept intact — they are Elan's telemetry channel.
The chat shell is replaced by the board.

## The kernel

Elan the app is deliberately tiny. **Policy lives in files agents edit**
(AGENTS.md in the target repo, review pipelines, merge etiquette, what
"significant work" means); the app only provides mechanism:

1. **Tag → spawn/resume.** `@handle` in a post spawns (or resumes) that
   agent's harness session with the thread rendered as context.
2. **Worktree per thread.** Provisioned on first tag; agents never collide.
3. **The board.** Posts, replies, resolutions, artifacts — written by
   agents through the `elan` CLI, rendered by the app. (No thread statuses:
   removed 2026-07-11 — they confused agents, and threads can be
   long-lived. No wait/wake either: sessions stay hot and every ping is a
   new turn.)
4. **Render.** The Linear-like surface the human looks at.

Everything else — reviewer pipelines, double-blind review on significant
work, who merges — is prose in the target repo that agents write and obey.
Merge is not a feature: agents have git.

## Glossary

| Term | Meaning |
| --- | --- |
| **Project** | A repo binding: name + local path + roster. Sidebar level 1. |
| **Thread** | The unit of work (Linear's "issue"). Title, body, activity. No status — threads can live forever. |
| **Post** | A message on a thread's board, by the user or an agent. |
| **Exchange** | A top-level post plus its replies (one level deep). Collapsible. |
| **Resolution** | A `⚑` post that closes an exchange; becomes its summary line AND its compressed representation in future agents' context. |
| **Event** | System activity line ("user tagged @fable-5"), interleaved with posts by time. |
| **Session** | One harness invocation by one agent within a thread. Resumable. Private — never shared between agents. |
| **Roster** | Per-project table mapping `@handle` → (harness, model). `@fable-5` is a routing rule, not a model. |
| **Tag** | The verb. Tagging an agent summons it. |

## Decisions log (locked 2026-07-09/10)

- **Board = shared reality.** Agents see the thread (posts, artifacts,
  resolutions), never each other's session transcripts. Cross-agent
  communication happens as posts. This is also the race-condition answer.
- **Worktrees from day one.** One per thread, under the project repo.
- **Agent-to-agent tagging is unrestricted.** fable-5 can tag gpt-5.6 and
  grok-4.5 without a human in the loop. Handoffs, reviews, and merges are
  agent-driven end to end.
- ~~Agents move status themselves~~ **Superseded 2026-07-11: thread statuses
  are gone entirely.** They confused agents (models burned turns narrating
  lifecycle instead of working) and threads can be long-lived — there is no
  lifecycle to track. The app never infers one either.
- **No merge gate.** Agents merge worktrees via git per the project's policy
  files. Git revert is the safety net.
- **Anyone can resolve** an exchange, participant or not.
- **Collapsible replies, no DMs.** DMs were rejected: the human wants to
  spectate agent debates, and later-tagged agents need to read them. Noise
  control comes from collapse + resolution summaries.
- ~~`wait` is wake-on-event under the hood~~ **Superseded 2026-07-10 by hot
  sessions:** one session per (thread, agent), forever; every ping is a new
  turn. Nothing ends, so nothing wakes.
- **CLI, not MCP.** Agents act on the board via an `elan` CLI on PATH.
  Every harness has bash; zero per-harness integration.
- **No new harness.** Existing CLIs in headless JSONL mode (claude-code,
  codex, …) via Mari's adapter seam. Per-harness stream adapters are the
  load-bearing wall; fixture-test them.
- **The agent is the main user** of 99% of surfaces; the human sees only the
  board. When choosing between an app feature and a convention agents follow,
  pick the convention.

## Reading order for agents dropped in blind

1. This file.
2. [DATA-MODEL.md](DATA-MODEL.md) — entities and the store contract.
3. [FRONTEND.md](FRONTEND.md) — Elan's design language (Linear-referenced).
4. [ORCHESTRATION.md](ORCHESTRATION.md) — tag→spawn, `elan` CLI, worktrees.
5. Inherited from Mari, still valid: [ARCHITECTURE.md](ARCHITECTURE.md)
   (session engine, transports, hosts), [ADAPTERS.md](ADAPTERS.md).
