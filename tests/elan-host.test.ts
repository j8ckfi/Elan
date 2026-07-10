// The Elan host — REST surface + persistence, the durable tag→spawn
// reconciler proven end to end by the mock harness, context rendering,
// wake-on, outcome extraction, the built child env, and /api/doctor.
// No network mocks: every test boots the real host in-process on an
// ephemeral port with a tmp ELAN_STATE_DIR. The mock harness is the ONLY
// spawner — the real claude/codex binaries are never executed (their stream
// formats are covered by recorded fixtures against extractOutcome).

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_PROBE_BEGIN,
  ENV_PROBE_END,
  HARNESSES,
  THREAD_CONTEXT_SEPARATOR,
  buildChildEnv,
  extractOutcome,
  parseClaudeModels,
  parseCodexModelList,
  parseCursorModels,
  parseDevinModels,
  parseGrokModels,
  parseOpencodeModels,
  parsePiModelTable,
  parsePoolModels,
  prependInstructions,
  probeLoginEnv,
  probeVersion,
  renderThreadContext,
  startHost,
  stripAnsi,
  whichOnPath,
  type ElanHost,
  type RunnerCtx,
  type RunnerSpec,
  type StartHostOptions,
} from "../dev/elan-host.ts";
import type {
  AgentSessionRecord,
  BoardEvent,
  BoardState,
  Post,
  Project,
  RosterEntry,
  Thread,
} from "../src/lib/board/types.ts";

// ── recorded harness fixtures (captured live 2026-07-10; never the real CLIs) ──
const FIXTURES = join(import.meta.dir, "fixtures", "harness");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const fixtureLines = (name: string): string[] =>
  fixture(name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const hosts: ElanHost[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const h of hosts.splice(0)) h.stop();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function boot(stateDir = newDir("elan-state-"), opts: StartHostOptions = {}): ElanHost {
  // probeVersions/probeDiscovery: false — /api/doctor must never exec the
  // real harness CLIs from the suite; parsers are covered by fixtures.
  const host = startHost({
    port: 0, stateDir, log: false, probeVersions: false, probeDiscovery: false, ...opts,
  });
  hosts.push(host);
  return host;
}

async function req<T>(host: ElanHost, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${host.url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const getState = (host: ElanHost): Promise<BoardState> =>
  req<BoardState>(host, "GET", "/api/state");

// The one waiting primitive: no fixed sleeps anywhere. Generous timeout —
// the suite may run under parallel load.
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A tmp repo with one commit, so `git worktree add -b …` has a HEAD. */
const hasGit = Bun.which("git") != null;
function initRepo(): string {
  const repo = newDir("elan-repo-");
  Bun.spawnSync(["git", "init", repo]);
  Bun.spawnSync([
    "git", "-C", repo, "-c", "user.name=elan-test", "-c", "user.email=elan@test",
    "commit", "--allow-empty", "-m", "init",
  ]);
  return repo;
}

async function makeThread(host: ElanHost, name: string): Promise<{ project: Project; thread: Thread }> {
  const project = await req<Project>(host, "POST", "/api/projects", {
    name,
    repoPath: newDir("elan-repo-"),
  });
  const thread = await req<Thread>(host, "POST", "/api/threads", {
    projectId: project.id,
    title: "a thread",
    body: "the body",
  });
  return { project, thread };
}

/** Add @ghost-9 (harness with NO registry row) to the roster — the honest
 *  runner-not-found path. Every registry harness now names a real bin
 *  (grok etc. exist on dev machines), so an unrunnable handle must use an
 *  unknown harness id, never a real one. */
async function addGhostToRoster(host: ElanHost): Promise<void> {
  const state = await getState(host);
  await req(host, "PUT", "/api/roster", {
    roster: [
      ...state.roster,
      { handle: "ghost-9", harness: "ghost-harness", color: "#999999" },
    ],
  });
}

// ── 1. REST round-trip + persistence ────────────────────────────────────────

describe("REST + persistence", () => {
  test("mutations round-trip through /api/state and survive a restart", async () => {
    const stateDir = newDir("elan-state-");
    const host = boot(stateDir);
    const project = await req<Project>(host, "POST", "/api/projects", {
      name: "Roundtrip",
      repoPath: "/tmp/elan-nowhere",
    });
    const thread = await req<Thread>(host, "POST", "/api/threads", {
      projectId: project.id,
      title: "First thread",
      body: "the body",
    });
    const posted = await req<Post>(host, "POST", "/api/posts", {
      threadId: thread.id,
      author: "user",
      body: "hello board", // no mentions — nothing spawns
    });

    const state = await getState(host);
    expect(state.projects.map((p) => p.id)).toContain(project.id);
    expect(state.threads.map((t) => t.id)).toContain(thread.id);
    expect(state.posts.map((p) => p.id)).toContain(posted.id);

    host.stop(); // flushes the debounced persist
    const file = join(stateDir, "board.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as BoardState;
    expect(onDisk.posts.some((p) => p.id === posted.id)).toBe(true);

    const revived = boot(stateDir); // same dir → same board
    const state2 = await getState(revived);
    expect(state2.threads.some((t) => t.id === thread.id)).toBe(true);
    expect(state2.posts.some((p) => p.id === posted.id)).toBe(true);
  });

  test("bad JSON → 400, unknown thread → 404, /api/demo is gone", async () => {
    const host = boot();
    const bad = await fetch(`${host.url}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${host.url}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "nope", author: "user", body: "hi" }),
    });
    expect(missing.status).toBe(404);

    const ctx = await fetch(`${host.url}/api/thread-context/nope`);
    expect(ctx.status).toBe(404);

    // The demo board no longer exists anywhere.
    const demo = await fetch(`${host.url}/api/demo`, { method: "POST" });
    expect(demo.status).toBe(404);
  });

  test("DELETE /api/projects/:id removes the project and its threads", async () => {
    const host = boot();
    const { project, thread } = await makeThread(host, "Doomed");
    await req<Post>(host, "POST", "/api/posts", {
      threadId: thread.id,
      author: "user",
      body: "some content",
    });
    await req(host, "DELETE", `/api/projects/${project.id}`);

    const state = await getState(host);
    expect(state.projects.some((p) => p.id === project.id)).toBe(false);
    expect(state.threads.some((t) => t.id === thread.id)).toBe(false);
    expect(state.posts.some((p) => p.threadId === thread.id)).toBe(false);

    const missing = await fetch(`${host.url}/api/projects/nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

// ── 2. mention → spawn → the full mock loop ─────────────────────────────────

describe("tag → spawn (mock harness)", () => {
  test(
    "@demo-bot runs the full loop: queued→done, posts, artifact, status, worktree, log",
    async () => {
      const host = boot();
      const repo = hasGit ? initRepo() : newDir("elan-repo-");
      const project = await req<Project>(host, "POST", "/api/projects", {
        name: "Mock Loop",
        repoPath: repo,
      });
      const thread = await req<Thread>(host, "POST", "/api/threads", {
        projectId: project.id,
        title: "Do the thing",
        body: "please do the thing",
      });
      await req<Post>(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "@demo-bot please do the thing",
      });

      const done = await pollUntil(async () => {
        const s = await getState(host);
        return s.sessions.find(
          (x) => x.threadId === thread.id && x.handle === "demo-bot" && x.state === "done",
        );
      }, "demo-bot session to finish");

      const state = await getState(host);
      // Durable intent: the session carries the tag's event id as its claim.
      const tag = state.events.find(
        (e) => e.threadId === thread.id && e.type === "tagged",
      )!;
      expect(done.triggerEventId).toBe(tag.id);
      expect(done.queuedAt).toBeDefined();
      expect(done.exitCode).toBe(0);
      // The full transcript landed on disk.
      expect(done.logPath).toBeDefined();
      expect(existsSync(done.logPath!)).toBe(true);
      expect(readFileSync(done.logPath!, "utf8")).toContain("[out]");

      const events = state.events.filter((e) => e.threadId === thread.id);
      expect(
        events.some((e) => e.type === "session-start" && e.payload.handle === "demo-bot"),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === "session-end" &&
            e.payload.handle === "demo-bot" &&
            e.payload.outcome === "done",
        ),
      ).toBe(true);
      expect(
        events.some(
          (e) =>
            e.type === "artifact" &&
            (e.payload.attachment as { path?: string } | undefined)?.path === "mock-plan.md",
        ),
      ).toBe(true);

      const bodies = state.posts
        .filter((p) => p.threadId === thread.id && p.author === "demo-bot")
        .map((p) => p.body);
      expect(bodies.some((b) => b.startsWith("Looking at this now."))).toBe(true);
      expect(bodies.some((b) => b.startsWith("Done —"))).toBe(true);
      // Success is silent from the host's side: no ⚠︎ post.
      expect(bodies.some((b) => b.startsWith("⚠︎"))).toBe(false);

      const t = state.threads.find((x) => x.id === thread.id)!;
      expect(t.status).toBe("in_review");

      if (hasGit) {
        expect(t.worktreePath).toBeDefined();
        expect(existsSync(t.worktreePath!)).toBe(true);
        expect(existsSync(join(t.worktreePath!, "mock-plan.md"))).toBe(true);
        expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".elan/");
      }
    },
    40_000,
  );

  test(
    "wake-me --on post: session waits, a later post resumes it to completion",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Wake Loop");
      let armed: AgentSessionRecord;
      process.env.ELAN_MOCK_WAKE = "1";
      try {
        await req<Post>(host, "POST", "/api/posts", {
          threadId: thread.id,
          author: "user",
          body: "@demo-bot hold for my go-ahead",
        });
        armed = await pollUntil(async () => {
          const s = await getState(host);
          return s.sessions.find(
            (x) =>
              x.threadId === thread.id && x.handle === "demo-bot" && x.state === "waiting",
          );
        }, "demo-bot to arm its wake");
        expect(armed.wakeOn).toEqual({ event: "post" });
      } finally {
        delete process.env.ELAN_MOCK_WAKE;
      }

      // The wake trigger: a new post by someone else (no mention needed).
      await req<Post>(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "go ahead",
      });
      // One record, two lives: the SAME session resumes to completion.
      const done = await pollUntil(async () => {
        const s = await getState(host);
        return s.sessions.find((x) => x.id === armed.id && x.state === "done");
      }, "the woken session to finish", 45_000); // wake rides two spawn cycles — generous under parallel-suite CPU contention

      const state = await getState(host);
      const outcomes = state.events
        .filter(
          (e) =>
            e.threadId === thread.id &&
            e.type === "session-end" &&
            e.payload.sessionId === done.id,
        )
        .map((e) => e.payload.outcome);
      // One record, two lives. The waiting end always precedes the done end
      // (events append in time order), but a slow first exit can merge into
      // the wake — assert the invariant parts order-independently.
      expect(outcomes[outcomes.length - 1]).toBe("done");
      expect(outcomes).toContain("waiting");
      // Durable wake consumption: the trigger post's id became the claim.
      const goAhead = state.posts.find((p) => p.body === "go ahead")!;
      expect(done.triggerEventId).toBe(goAhead.id);
      expect(
        state.posts.some(
          (p) => p.threadId === thread.id && p.author === "demo-bot" && p.body.startsWith("Done —"),
        ),
      ).toBe(true);
    },
    40_000,
  );

  test(
    "a tag while a session is live is absorbed durably, not respawned",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Absorb");
      process.env.ELAN_MOCK_WAKE = "1"; // arm-and-exit keeps the loop quick
      try {
        await req<Post>(host, "POST", "/api/posts", {
          threadId: thread.id,
          author: "user",
          body: "@demo-bot first tag @demo-bot second mention same post is one tag",
        });
        await pollUntil(async () => {
          const s = await getState(host);
          return s.sessions.find(
            (x) => x.threadId === thread.id && x.handle === "demo-bot" && x.state === "waiting",
          );
        }, "the first session to arm");
      } finally {
        delete process.env.ELAN_MOCK_WAKE;
      }

      const state = await getState(host);
      const tags = state.events.filter(
        (e) => e.threadId === thread.id && e.type === "tagged",
      );
      // Every tagged event is claimed by exactly one session record.
      for (const tag of tags) {
        expect(
          state.sessions.filter((s) => s.triggerEventId === tag.id).length,
        ).toBe(1);
      }
    },
    40_000,
  );
});

// ── 3. durability: restarts recover exactly the unhandled work ──────────────

describe("durable intent across restarts", () => {
  test(
    "restart mid-run: exactly one session per triggerEventId, orphan errors cleanly",
    async () => {
      const stateDir = newDir("elan-state-");
      const hostA = boot(stateDir);
      const { thread } = await makeThread(hostA, "Restart");
      await req<Post>(hostA, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "@demo-bot do the durable thing",
      });
      // The claim + spawn happen synchronously in the mutation's reconciler
      // pass — stop immediately, mid-run, before the mock can finish.
      hostA.stop();

      const disk = JSON.parse(readFileSync(join(stateDir, "board.json"), "utf8")) as BoardState;
      const tag = disk.events.find((e) => e.type === "tagged")!;
      expect(disk.sessions.filter((s) => s.triggerEventId === tag.id).length).toBe(1);
      expect(["queued", "spawning", "running"]).toContain(
        disk.sessions.find((s) => s.triggerEventId === tag.id)!.state,
      );

      const hostB = boot(stateDir);
      const recovered = await pollUntil(async () => {
        const s = await getState(hostB);
        return s.sessions.find(
          (x) =>
            x.triggerEventId === tag.id && (x.state === "done" || x.state === "error"),
        );
      }, "the claimed session to settle after restart");
      // It was running when the host died → orphaned, never silently re-run.
      expect(recovered.state).toBe("error");
      expect(recovered.reason).toBe("orphaned-by-restart");

      // Give the reconciler ticks a chance to misbehave, then re-assert:
      // still exactly one session for the tag — no duplicate spawn, ever.
      await pollUntil(async () => {
        const s = await getState(hostB);
        return s.events.some(
          (e) =>
            e.type === "session-end" &&
            e.payload.sessionId === recovered.id &&
            e.payload.outcome === "error",
        )
          ? true
          : undefined;
      }, "the orphan session-end event");
      await new Promise((r) => setTimeout(r, 2_500)); // > one 2s tick
      const s = await getState(hostB);
      expect(s.sessions.filter((x) => x.triggerEventId === tag.id).length).toBe(1);
    },
    40_000,
  );

  test(
    "boot marks fake running sessions orphaned and stale tags skipped",
    async () => {
      const stateDir = newDir("elan-state-");
      const hostA = boot(stateDir);
      const { thread } = await makeThread(hostA, "Orphanage");
      hostA.stop();

      // Forge a crash: a "running" session and a >24h-old unhandled tag.
      const file = join(stateDir, "board.json");
      const disk = JSON.parse(readFileSync(file, "utf8")) as BoardState;
      const fakeSession: AgentSessionRecord = {
        id: "fake-running",
        threadId: thread.id,
        handle: "demo-bot",
        state: "running",
        procKey: "99999",
        startedAt: Date.now() - 60_000,
      };
      const staleTag: BoardEvent = {
        id: "stale-tag",
        threadId: thread.id,
        actor: "user",
        type: "tagged",
        payload: { handle: "demo-bot" },
        at: Date.now() - 25 * 60 * 60 * 1000,
      };
      disk.sessions.push(fakeSession);
      disk.events.push(staleTag);
      writeFileSync(file, JSON.stringify(disk));

      const hostB = boot(stateDir);
      const orphan = await pollUntil(async () => {
        const s = await getState(hostB);
        const x = s.sessions.find((r) => r.id === "fake-running");
        return x?.state === "error" ? x : undefined;
      }, "the fake running session to be orphaned", 10_000);
      expect(orphan.reason).toBe("orphaned-by-restart");

      const state = await getState(hostB);
      expect(
        state.events.some(
          (e) =>
            e.type === "session-end" &&
            e.payload.sessionId === "fake-running" &&
            e.payload.outcome === "error",
        ),
      ).toBe(true);

      // The stale tag got a claim marker, not a spawn — and no ⚠︎ post spam.
      const staleClaim = await pollUntil(async () => {
        const s = await getState(hostB);
        return s.sessions.find((r) => r.triggerEventId === "stale-tag");
      }, "the stale tag to be claimed", 10_000);
      expect(staleClaim.state).toBe("error");
      expect(staleClaim.reason).toBe("stale-skipped");
      expect(state.posts.filter((p) => p.body.startsWith("⚠︎")).length).toBe(0);
    },
    40_000,
  );
});

// ── 4. limits: the per-thread budget breaker ────────────────────────────────

describe("per-thread spawn budget", () => {
  test("UNCAPPED by default — agent chains are the product, not a bug", async () => {
    const host = boot(); // no ELAN_THREAD_BUDGET, no threadBudget override
    const { thread } = await makeThread(host, "Uncapped");
    for (let i = 0; i < 3; i++) {
      await req(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: `@demo-bot go ${i}`,
      });
    }
    // Every tag must be claimed by a real session or an absorbed marker —
    // never a budget drop.
    await pollUntil(async () => {
      const s = await getState(host);
      return s.sessions.filter((x) => x.handle === "demo-bot").length >= 3;
    });
    const s = await getState(host);
    expect(s.sessions.some((x) => x.reason === "budget-exceeded")).toBe(false);
    expect(s.posts.some((p) => p.body.includes("spawn budget"))).toBe(false);
  });

  test(
    "the tag past the budget is dropped with an error session + one ⚠︎ post",
    async () => {
      process.env.ELAN_THREAD_BUDGET = "2";
      let host: ElanHost;
      try {
        host = boot(); // reads ELAN_THREAD_BUDGET at boot
      } finally {
        delete process.env.ELAN_THREAD_BUDGET;
      }
      const { thread } = await makeThread(host, "Budget");
      await addGhostToRoster(host);

      // ghost-9's harness has no registry row → each tag becomes a start
      // attempt that errors fast (runner-not-found), which still counts as a
      // start.
      for (let i = 1; i <= 2; i++) {
        await req<Post>(host, "POST", "/api/posts", {
          threadId: thread.id,
          author: "user",
          body: `@ghost-9 attempt ${i}`,
        });
        await pollUntil(async () => {
          const s = await getState(host);
          const errs = s.sessions.filter(
            (x) =>
              x.threadId === thread.id &&
              x.handle === "ghost-9" &&
              x.state === "error" &&
              x.reason === "runner-not-found",
          );
          return errs.length >= i ? true : undefined;
        }, `attempt ${i} to error`);
      }

      await req<Post>(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "@ghost-9 attempt 3 — over budget",
      });
      const dropped = await pollUntil(async () => {
        const s = await getState(host);
        return s.sessions.find(
          (x) =>
            x.threadId === thread.id &&
            x.handle === "ghost-9" &&
            x.reason === "budget-exceeded",
        );
      }, "the third tag to hit the budget");
      expect(dropped.state).toBe("error");

      const state = await getState(host);
      const budgetPosts = state.posts.filter(
        (p) =>
          p.threadId === thread.id &&
          p.body.startsWith("⚠︎") &&
          p.body.includes("budget"),
      );
      expect(budgetPosts.length).toBe(1);
      // Exactly three sessions: two real attempts + one budget drop.
      expect(
        state.sessions.filter(
          (s) => s.threadId === thread.id && s.handle === "ghost-9",
        ).length,
      ).toBe(3);
    },
    40_000,
  );
});

// ── 5. preflight: unknown harness / missing runner fails honestly ───────────

describe("runner preflight", () => {
  test("@ghost-9 (unknown harness) → runner-not-found session, session-end(error), ⚠︎ post", async () => {
    const host = boot();
    const { thread } = await makeThread(host, "No Adapter");
    await addGhostToRoster(host);
    await req<Post>(host, "POST", "/api/posts", {
      threadId: thread.id,
      author: "user",
      body: "@ghost-9 hi",
    });

    const errored = await pollUntil(async () => {
      const s = await getState(host);
      return s.sessions.find(
        (x) => x.threadId === thread.id && x.handle === "ghost-9" && x.state === "error",
      );
    }, "ghost-9 session to error", 10_000);
    expect(errored.reason).toBe("runner-not-found");
    expect(errored.triggerEventId).toBeDefined();

    const state = await getState(host);
    expect(
      state.events.some(
        (e) =>
          e.threadId === thread.id &&
          e.type === "session-end" &&
          e.payload.handle === "ghost-9" &&
          e.payload.outcome === "error",
      ),
    ).toBe(true);
    expect(
      state.posts.some(
        (p) =>
          p.threadId === thread.id &&
          p.author === "ghost-9" &&
          p.body.startsWith("⚠︎") &&
          p.body.includes("ghost-harness"),
      ),
    ).toBe(true);
  });

  test("whichOnPath resolves against an explicit PATH only", () => {
    const dir = newDir("elan-bin-");
    const fake = join(dir, "fake-runner");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);

    expect(whichOnPath("fake-runner", `/nonexistent:${dir}`)).toBe(fake);
    expect(whichOnPath("fake-runner", "/nonexistent:/usr/bin")).toBeNull();
    expect(whichOnPath("definitely-not-a-real-binary-xyz", dir)).toBeNull();
    // Absolute candidates bypass PATH scanning.
    expect(whichOnPath(fake, "")).toBe(fake);
  });
});

// ── 6. outcome extraction (recorded fixtures — never the real CLIs) ─────────
// Every fixture under tests/fixtures/harness/ is a raw stream captured live
// on 2026-07-10 (the hand-crafted ones say so inline).

describe("extractOutcome", () => {
  test("claude-stream: 'Not logged in' rides the stdout result event, exit 1", () => {
    // Verified live 2026-07-10: stderr is EMPTY in this failure mode.
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Not logged in · Please run /login",
        session_id: "abc",
      }),
    ];
    const out = extractOutcome("claude-stream", lines, 1);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("Not logged in · Please run /login");
  });

  test("claude-stream: the recorded capture — subtype success but is_error true", () => {
    // The nasty real shape: claude reports subtype:"success" with
    // is_error:true for the not-logged-in outcome. is_error must win, even
    // on exit 0.
    const lines = fixtureLines("claude-not-logged-in.jsonl");
    const out = extractOutcome("claude-stream", lines, 1);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("Not logged in · Please run /login");
    expect(extractOutcome("claude-stream", lines, 0).ok).toBe(false);
  });

  test("claude-stream: success result with exit 0", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", subtype: "success", result: "All done.", session_id: "abc" }),
    ];
    expect(extractOutcome("claude-stream", lines, 0)).toEqual({ ok: true, text: "All done." });
    // exit≠0 is a failure even when the result event looks fine.
    expect(extractOutcome("claude-stream", lines, 1).ok).toBe(false);
    expect(extractOutcome("claude-stream", lines, 1).text).toBe("All done.");
  });

  test("claude-stream: cursor-agent speaks the same dialect (recorded capture)", () => {
    const lines = fixtureLines("cursor-ping.jsonl");
    expect(extractOutcome("claude-stream", lines, 0)).toEqual({ ok: true, text: "PONG" });
    // Cursor CLI errors are PLAIN TEXT on stderr with exit 1 — no result
    // event at all → honest failure with no stream text.
    expect(extractOutcome("claude-stream", [], 1)).toEqual({ ok: false, text: "" });
  });

  test("codex-events: turn.failed with a nested JSON message unwraps", () => {
    // Verified live 2026-07-10: the fatal message is a stdout turn.failed
    // while stderr fills with non-fatal ANSI-colored rmcp/MCP noise.
    const lines = [
      JSON.stringify({ type: "session.created", session_id: "x" }),
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: JSON.stringify({
            message: "The 'gpt-6.1-pro' model requires a newer version of Codex",
          }),
        },
      }),
    ];
    const out = extractOutcome("codex-events", lines, 1);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("The 'gpt-6.1-pro' model requires a newer version of Codex");
  });

  test("codex-events: plain turn.failed message and agent_message success", () => {
    const failed = extractOutcome(
      "codex-events",
      [JSON.stringify({ type: "turn.failed", error: { message: "boom" } })],
      1,
    );
    expect(failed).toEqual({ ok: false, text: "boom" });

    const ok = extractOutcome(
      "codex-events",
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "pong" } }),
      ],
      0,
    );
    expect(ok).toEqual({ ok: true, text: "pong" });
  });

  test("codex-events: leading advisory error items are tolerated (recorded captures)", () => {
    // User-config deprecation advisories ride item.completed type:"error"
    // BEFORE turn.started; they must not fail a run that then completes.
    const ok = extractOutcome("codex-events", fixtureLines("codex-advisory-ok.ndjson"), 0);
    expect(ok).toEqual({ ok: true, text: "pong" });

    // …and when the turn DOES fail, the nested envelope unwraps.
    const failed = extractOutcome(
      "codex-events",
      fixtureLines("codex-advisory-failed.ndjson"),
      1,
    );
    expect(failed.ok).toBe(false);
    expect(failed.text).toBe(
      "The 'gpt-5.6-sol' model requires a newer version of Codex. " +
        "Please upgrade to the latest app or CLI and try again.",
    );
  });

  test("pi-stream: EXIT CODE IS MEANINGLESS — provider failure with exit 0 (recorded capture)", () => {
    // pi exits 0 after 3 silent auto-retries all failed. The stream is the
    // only signal: turn_end stopReason:"error" + auto_retry_end success:false.
    const lines = fixtureLines("pi-runtime-err.jsonl");
    const out = extractOutcome("pi-stream", lines, 0);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("Connection error.");
  });

  test("pi-stream: success text is the last turn_end's text blocks (recorded capture)", () => {
    const lines = fixtureLines("pi-ping.jsonl");
    const out = extractOutcome("pi-stream", lines, 0);
    expect(out.ok).toBe(true);
    expect(out.text).toBe("pong"); // thinking blocks filtered out
  });

  test("pi-stream: an empty stream is a failure regardless of exit code", () => {
    expect(extractOutcome("pi-stream", [], 0).ok).toBe(false);
  });

  test("opencode-events: success text is the last text part (recorded captures)", () => {
    expect(extractOutcome("opencode-events", fixtureLines("opencode-ping.jsonl"), 0)).toEqual({
      ok: true,
      text: "pong",
    });
    // A tool-using run: the final text event wins, not the tool output.
    expect(extractOutcome("opencode-events", fixtureLines("opencode-tool.jsonl"), 0)).toEqual({
      ok: true,
      text: "elan-probe-ok",
    });
  });

  test("opencode-events: the error event carries the failure detail (recorded capture)", () => {
    const lines = fixtureLines("opencode-error.jsonl");
    const out = extractOutcome("opencode-events", lines, 1);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("Unexpected server error. Check server logs for details.");
    // An error event poisons the run even if the exit code lies.
    expect(extractOutcome("opencode-events", lines, 0).ok).toBe(false);
  });

  test("pool-events: the answer is the last thought that isn't a reasoning twin (recorded captures)", () => {
    // pool mirrors every reasoning block as a thought; the actual reply is
    // the thought with no reasoning twin ("pong"), NOT the last thought.
    for (const f of ["pool-ping.ndjson", "pool-pong.ndjson", "pool-xs.ndjson"]) {
      const out = extractOutcome("pool-events", fixtureLines(f), 0);
      expect(out.ok).toBe(true);
      expect(out.text).toBe("pong");
    }
  });

  test("pool-events: exit 4 = agent-declared failure, message still extracted", () => {
    // Hand-crafted from the recorded shape: exit toolCall success:false +
    // process exit 4.
    const lines = [
      JSON.stringify({ type: "reasoning", reasoning: "\nCannot do this.\n" }),
      JSON.stringify({ type: "thought", thought: "\nI could not complete the task.\n" }),
      JSON.stringify({ type: "thought", thought: "\nCannot do this.\n" }),
      JSON.stringify({ type: "toolCall", name: "exit", args: { success: false } }),
      JSON.stringify({ type: "toolCallResult", result: "" }),
    ];
    const out = extractOutcome("pool-events", lines, 4);
    expect(out.ok).toBe(false);
    expect(out.text).toBe("I could not complete the task.");
    // Even exit 0 can't bless an agent-declared failure.
    expect(extractOutcome("pool-events", lines, 0).ok).toBe(false);
  });

  test("grok-stream: the 403 entitlement failure unwraps the nested JSON (recorded capture)", () => {
    const lines = fixtureLines("grok-403.ndjson");
    const out = extractOutcome("grok-stream", lines, 1);
    expect(out.ok).toBe(false);
    expect(out.text).toStartWith("API error (status 403 Forbidden): permission-denied:");
    expect(out.text).not.toContain("http_status"); // the wrapper is gone
  });

  test("grok-stream: text chunks concatenate into the answer", () => {
    // Hand-crafted from the verified grok profile (no success entitlement on
    // this machine): {"type":"text","data"} chunks + terminal {"type":"end"}.
    const lines = [
      JSON.stringify({ type: "text", data: "po" }),
      JSON.stringify({ type: "text", data: "ng" }),
      JSON.stringify({ type: "end", stopReason: "complete", sessionId: "u-1" }),
    ];
    expect(extractOutcome("grok-stream", lines, 0)).toEqual({ ok: true, text: "pong" });
    expect(extractOutcome("grok-stream", lines, 1).ok).toBe(false);
  });

  test("devin-raw: stdout IS the answer; exit code is the verdict", () => {
    // Hand-crafted from the verified devin profile: no stream, bare text.
    const lines = ["The fix is in auth.rs line 42.", "Done."];
    expect(extractOutcome("devin-raw", lines, 0)).toEqual({
      ok: true,
      text: "The fix is in auth.rs line 42.\nDone.",
    });
    expect(extractOutcome("devin-raw", lines, 101).ok).toBe(false); // panic
    expect(extractOutcome("devin-raw", [], 1)).toEqual({ ok: false, text: "" });
  });

  test("raw (mock): last stdout line; stripAnsi scrubs CSI + OSC sequences", () => {
    expect(extractOutcome("raw", ["first", "last line"], 0)).toEqual({
      ok: true,
      text: "last line",
    });
    expect(extractOutcome("raw", ["only"], 3).ok).toBe(false);

    const noisy =
      "\x1b[2m2026-07-10\x1b[0m \x1b[31mERROR\x1b[39m rmcp::transport: task aborted" +
      "\x1b]0;codex\x07 tail";
    expect(stripAnsi(noisy)).toBe("2026-07-10 ERROR rmcp::transport: task aborted tail");
  });
});

// ── 6b. model-discovery parsers (fixtures; the probes themselves never run) ──

describe("discovery parsers", () => {
  test("pi: fixed-width table → provider/model, header skipped", () => {
    const models = parsePiModelTable(fixture("discovery-pi-list-models.txt"));
    expect(models).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.5",
      "laguna/laguna-spec-nothink",
      "google/gemini-3.1-pro",
    ]);
  });

  test("opencode: one provider/model per line, no header", () => {
    const models = parseOpencodeModels(fixture("discovery-opencode-models.txt"));
    expect(models).toContain("opencode/deepseek-v4-flash-free");
    expect(models).toContain("lmstudio/qwen4-coder-30b");
    expect(models.length).toBe(6);
  });

  test("cursor: '<id> - <Display Name>' lines; header + Tip skipped", () => {
    const models = parseCursorModels(fixture("discovery-cursor-models.txt"));
    expect(models).toEqual([
      "auto",
      "composer-2.5",
      "gpt-5.6-sol",
      "claude-fable-5-thinking-high",
      "grok-4.5-medium",
    ]);
  });

  test("grok: banner skipped; '- id' and '* id (default)' entries parsed", () => {
    const models = parseGrokModels(fixture("discovery-grok-models.txt"));
    expect(models).toEqual(["grok-4-fast", "grok-4.5"]);
  });

  test("devin: comma list after 'Available:' on stderr", () => {
    const models = parseDevinModels(fixture("discovery-devin-available.txt"));
    expect(models.length).toBe(24);
    expect(models).toContain("devin-max");
    expect(models).toContain("auto");
    // The alternate spelling some builds use.
    expect(parseDevinModels("Cannot use this model: x. Available models: a, b, c")).toEqual([
      "a", "b", "c",
    ]);
    expect(parseDevinModels("no list here")).toEqual([]);
  });

  test("codex: app-server model/list JSON-RPC result.data[].id", () => {
    const models = parseCodexModelList(fixture("discovery-codex-model-list.ndjson"));
    expect(models).toEqual(["gpt-5.3-codex", "gpt-5.2", "gpt-5.1-codex-max"]);
  });

  test("claude: control_response models[].value (real shape, captured live)", () => {
    const models = parseClaudeModels(fixture("discovery-claude-control-response.ndjson"));
    expect(models).toEqual(["default", "opus[1m]", "claude-fable-5[1m]"]);
    // Both nestings + the older `model` field spelling are accepted.
    const flat = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", models: [{ model: "m-1" }] },
    });
    expect(parseClaudeModels(flat)).toEqual(["m-1"]);
  });

  test("pool: acp session/new configOptions id:model → options[].value", () => {
    const models = parsePoolModels(fixture("discovery-pool-session-new.ndjson"));
    expect(models).toEqual(["poolside-core-2", "poolside-swe-1.5"]);
  });
});

// ── 6c. the harness registry: runner argv shapes (pure) ─────────────────────

describe("HARNESSES runners", () => {
  const baseCtx: RunnerCtx = {
    binPath: "/bin/fake",
    prompt: "THE CONTEXT",
    instructions: "THE INSTRUCTIONS",
    cwd: "/work/tree",
    sessionId: "sess-1",
    sessionDir: "/state/sessions",
  };
  const spec = (harness: string, ctx: Partial<RunnerCtx> = {}): RunnerSpec => {
    const r = HARNESSES[harness].runner({ ...baseCtx, ...ctx });
    if (!("argv" in r)) throw new Error(`runner errored: ${r.error}`);
    return r;
  };

  test("every registry row is complete", () => {
    for (const [id, p] of Object.entries(HARNESSES)) {
      expect(p.id).toBe(id);
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p.bin.length).toBeGreaterThan(0);
      expect(typeof p.runner).toBe("function");
      expect(typeof p.extract).toBe("string");
    }
    // The registry covers exactly the v1 harness set.
    expect(Object.keys(HARNESSES).sort()).toEqual([
      "claude-code", "codex", "cursor", "devin", "grok", "mock", "opencode", "pi", "pool",
    ]);
  });

  test("claude-code: native --append-system-prompt; resume drops context", () => {
    const fresh = spec("claude-code", { model: "claude-fable-5" });
    expect(fresh.argv).toEqual([
      "/bin/fake", "-p", "THE CONTEXT", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "bypassPermissions", "--model", "claude-fable-5",
      "--append-system-prompt", "THE INSTRUCTIONS",
    ]);
    const resumed = spec("claude-code", {
      prompt: "WAKE",
      resume: { harnessSessionId: "hs-1" },
    });
    expect(resumed.argv).toContain("--resume");
    expect(resumed.argv).toContain("hs-1");
    expect(resumed.argv).toContain("WAKE");
    expect(resumed.argv).not.toContain("--append-system-prompt");
  });

  test("codex: instructions prepended under the separator; prompt is last", () => {
    const s = spec("codex", { model: "gpt-5.3-codex" });
    expect(s.argv.slice(0, 4)).toEqual(["/bin/fake", "exec", "--json", "--skip-git-repo-check"]);
    expect(s.argv).toContain("-m");
    const prompt = s.argv[s.argv.length - 1];
    expect(prompt).toStartWith("THE INSTRUCTIONS");
    expect(prompt).toContain(THREAD_CONTEXT_SEPARATOR);
    expect(prompt).toEndWith("THE CONTEXT");
  });

  test("pi: --mode json + native append; resume uses --session-id", () => {
    const fresh = spec("pi", { model: "anthropic/claude-fable-5" });
    expect(fresh.argv).toEqual([
      "/bin/fake", "-p", "THE CONTEXT", "--mode", "json",
      "--model", "anthropic/claude-fable-5",
      "--append-system-prompt", "THE INSTRUCTIONS",
    ]);
    const resumed = spec("pi", { prompt: "WAKE", resume: { harnessSessionId: "pi-sess" } });
    expect(resumed.argv).toContain("--session-id");
    expect(resumed.argv).toContain("pi-sess");
  });

  test("opencode: -m is mandatory — unpinned roster entries fail honestly", () => {
    const r = HARNESSES.opencode.runner(baseCtx); // no model
    expect("error" in r && r.error).toContain("model");

    const s = spec("opencode", { model: "opencode/deepseek-v4-flash-free" });
    expect(s.argv.slice(0, 4)).toEqual(["/bin/fake", "run", "--format", "json"]);
    expect(s.argv).toContain("-m");
    expect(s.argv[s.argv.length - 1]).toContain(THREAD_CONTEXT_SEPARATOR);

    const resumed = spec("opencode", {
      model: "m", prompt: "WAKE", resume: { harnessSessionId: "ses_x" },
    });
    expect(resumed.argv).toContain("-s");
    expect(resumed.argv).toContain("ses_x");
  });

  test("cursor: --force --trust, prompt as argv, instructions prepended", () => {
    const s = spec("cursor", { model: "composer-2.5" });
    expect(s.argv).toContain("--force");
    expect(s.argv).toContain("--trust");
    expect(s.argv[s.argv.length - 1]).toContain(THREAD_CONTEXT_SEPARATOR);
    const resumed = spec("cursor", { prompt: "WAKE", resume: { harnessSessionId: "chat-1" } });
    expect(resumed.argv).toContain("--resume");
    expect(resumed.argv).toContain("chat-1");
  });

  test("devin: context goes through a prompt FILE; empty prompt refused", () => {
    const s = spec("devin", { model: "devin-max" });
    expect(s.argv).toEqual([
      "/bin/fake", "--permission-mode", "dangerous",
      "--prompt-file", "/state/sessions/sess-1.prompt.md",
      "--model", "devin-max",
    ]);
    expect(s.files).toHaveLength(1);
    expect(s.files![0].path).toBe("/state/sessions/sess-1.prompt.md");
    expect(s.files![0].content).toContain(THREAD_CONTEXT_SEPARATOR);
    expect(s.files![0].content).toEndWith("THE CONTEXT");

    const empty = HARNESSES.devin.runner({ ...baseCtx, prompt: "  " });
    expect("error" in empty).toBe(true); // devin panics (exit 101) without a prompt
  });

  test("pool: POOLSIDE_STANDALONE_MODEL env is the only model pin; -d is the worktree", () => {
    const s = spec("pool", { model: "poolside-core-2" });
    expect(s.env).toEqual({ POOLSIDE_STANDALONE_MODEL: "poolside-core-2" });
    expect(s.argv).toContain("-d");
    expect(s.argv[s.argv.indexOf("-d") + 1]).toBe("/work/tree");
    expect(s.argv[s.argv.indexOf("-p") + 1]).toContain(THREAD_CONTEXT_SEPARATOR);
    expect(spec("pool").env).toBeUndefined(); // unpinned → no env pin
  });

  test("grok: minted -s id always passed; --rules carries the instructions", () => {
    const s = spec("grok", { harnessSessionId: "uuid-1", model: "grok-4.5" });
    expect(s.argv[s.argv.indexOf("-s") + 1]).toBe("uuid-1");
    expect(s.argv[s.argv.indexOf("--rules") + 1]).toBe("THE INSTRUCTIONS");
    expect(s.argv[s.argv.indexOf("--cwd") + 1]).toBe("/work/tree");
    // The prompt is NOT prepended — --rules is the native injection.
    expect(s.argv[s.argv.indexOf("-p") + 1]).toBe("THE CONTEXT");
    // No minted id = a host bug, refused loudly.
    expect("error" in HARNESSES.grok.runner(baseCtx)).toBe(true);
  });

  test("session-id strategies: capture predicates match the real stream shapes", () => {
    const cap = (h: string, msg: Record<string, unknown>): string | undefined => {
      const strat = HARNESSES[h].sessionId;
      return strat && strat.mode === "capture" ? strat.capture(msg) : undefined;
    };
    expect(cap("claude-code", { type: "system", session_id: "cc-1" })).toBe("cc-1");
    expect(cap("cursor", { type: "result", session_id: "cu-1" })).toBe("cu-1");
    expect(cap("pi", { type: "session", id: "pi-1" })).toBe("pi-1");
    expect(cap("pi", { type: "agent_start", id: "nope" })).toBeUndefined();
    expect(cap("opencode", { type: "text", sessionID: "oc-1" })).toBe("oc-1");
    expect(HARNESSES.grok.sessionId).toEqual({ mode: "mint" });
    for (const h of ["codex", "devin", "pool", "mock"])
      expect(HARNESSES[h].sessionId).toBeNull();
  });

  test("prependInstructions is the shared separator contract", () => {
    const p = prependInstructions("INSTR", "CTX");
    expect(p).toBe(`INSTR\n\n${THREAD_CONTEXT_SEPARATOR}\n\nCTX`);
  });
});

// ── 7. the built child environment ──────────────────────────────────────────

describe("child env builder", () => {
  test("probeLoginEnv parses KEY=VALUE lines between markers from a fake shell", () => {
    const dir = newDir("elan-shell-");
    const fakeShell = join(dir, "fake-shell.sh");
    // Emits rc noise around the markers, exactly like a chatty login shell.
    writeFileSync(
      fakeShell,
      `#!/bin/sh
echo "rc noise: welcome to fake shell"
echo "${ENV_PROBE_BEGIN}"
echo "FOO=bar"
echo "PATH=/fixture/bin:/other/bin"
echo "MULTI=first line"
echo "not a key value line"
echo "CLAUDECODE=1"
echo "CLAUDE_CODE_ENTRYPOINT=cli"
echo "ELAN_SNEAKY=x"
echo "${ENV_PROBE_END}"
echo "trailing noise"
`,
    );
    chmodSync(fakeShell, 0o755);

    const probed = probeLoginEnv(fakeShell);
    expect(probed.FOO).toBe("bar");
    expect(probed.PATH).toBe("/fixture/bin:/other/bin");
    expect(probed.MULTI).toBe("first line");
    expect(probed.CLAUDECODE).toBe("1"); // strip happens in buildChildEnv
    expect("not a key value line" in probed).toBe(false);

    const missing = probeLoginEnv(join(dir, "no-such-shell"));
    expect(Object.keys(missing).length).toBe(0);
  });

  test("buildChildEnv strips pollution, builds PATH, adds TERM + our ELAN_*", () => {
    const env = buildChildEnv({
      shimDir: "/state/bin",
      probed: {
        HOME: "/Users/probe",
        FOO: "bar",
        PATH: "/fixture/bin:/usr/bin:/fixture/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        ELAN_SNEAKY: "x",
        TERM: "xterm-256color",
      },
      hostEnv: { HOME: "/Users/host" },
      elan: { ELAN_URL: "http://127.0.0.1:1", ELAN_AGENT: "demo-bot" },
    });

    // Strip list enforced.
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.ELAN_SNEAKY).toBeUndefined();
    // Probe vars survive; ours are added; TERM is forced dumb.
    expect(env.FOO).toBe("bar");
    expect(env.ELAN_URL).toBe("http://127.0.0.1:1");
    expect(env.ELAN_AGENT).toBe("demo-bot");
    expect(env.TERM).toBe("dumb");

    // PATH: shim first, probed PATH, static fallbacks — de-duped.
    const parts = env.PATH.split(":");
    expect(parts[0]).toBe("/state/bin");
    expect(parts[1]).toBe("/fixture/bin");
    expect(parts[2]).toBe("/usr/bin");
    expect(parts.filter((p) => p === "/fixture/bin").length).toBe(1);
    expect(parts.filter((p) => p === "/usr/bin").length).toBe(1);
    expect(parts).toContain("/Users/probe/.local/bin"); // probe HOME wins
    expect(parts).toContain("/Users/probe/.bun/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/bin");
  });

  test("ELAN_SPAWN_ENV_EXTRA passes named vars through (probe first, host env fallback)", () => {
    const env = buildChildEnv({
      shimDir: "/shim",
      probed: { HOME: "/h", PATH: "/usr/bin", CLAUDECODE: "probe-value" },
      hostEnv: { MY_API_KEY: "host-secret", ELAN_SPAWN_ENV_EXTRA: "ignored-when-explicit" },
      extraKeys: ["CLAUDECODE", "MY_API_KEY", "NOWHERE"],
      elan: {},
    });
    expect(env.CLAUDECODE).toBe("probe-value"); // extra overrides the strip list
    expect(env.MY_API_KEY).toBe("host-secret"); // falls back to the host env
    expect("NOWHERE" in env).toBe(false);

    // The env var spelling of the same knob.
    const viaEnvVar = buildChildEnv({
      shimDir: "/shim",
      probed: { HOME: "/h", PATH: "/usr/bin" },
      hostEnv: { ELAN_SPAWN_ENV_EXTRA: "MY_TOKEN", MY_TOKEN: "t" },
      elan: {},
    });
    expect(viaEnvVar.MY_TOKEN).toBe("t");
  });

  test("probeVersion returns a version line for a real binary (bun itself)", () => {
    const v = probeVersion(process.execPath);
    expect(typeof v).toBe("string");
    expect(v!.length).toBeGreaterThan(0);
  });
});

// ── 8. session timeout ──────────────────────────────────────────────────────

describe("session timeout", () => {
  test(
    "an overtime session is killed with reason 'timeout'",
    async () => {
      const host = boot(undefined, { sessionTimeoutMs: 1 });
      const { thread } = await makeThread(host, "Timeout");
      await req<Post>(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "@demo-bot you will be terminated",
      });

      const errored = await pollUntil(async () => {
        const s = await getState(host);
        return s.sessions.find(
          (x) =>
            x.threadId === thread.id &&
            x.handle === "demo-bot" &&
            x.state === "error" &&
            x.reason === "timeout",
        );
      }, "the session to time out");
      expect(errored.endedAt).toBeDefined();

      const state = await getState(host);
      expect(
        state.posts.some(
          (p) =>
            p.threadId === thread.id &&
            p.author === "demo-bot" &&
            p.body.startsWith("⚠︎") &&
            p.body.includes("timed out"),
        ),
      ).toBe(true);
    },
    40_000,
  );
});

// ── 9. /api/doctor ──────────────────────────────────────────────────────────

describe("GET /api/doctor (v2)", () => {
  interface DoctorEntry {
    bin: string | null;
    found: boolean;
    path?: string;
    version?: string;
    auth?: string;
    models: string[] | null;
    discoveryError?: string;
    displayName?: string;
    lastFailure?: { reason: string; at: number; message?: string };
  }
  interface Doctor {
    harnesses: Record<string, DoctorEntry>;
    host: { pid: number; stateFile: string; uptime: number };
  }

  test("v2 shape: every REGISTRY harness appears with bin/found/models", async () => {
    // probeVersions:false + probeDiscovery:false — the real CLIs are never
    // executed; models stays null with no discoveryError.
    const host = boot();
    const doc = await req<Doctor>(host, "GET", "/api/doctor");

    for (const [id, profile] of Object.entries(HARNESSES)) {
      const entry = doc.harnesses[id];
      expect(entry).toBeDefined();
      expect(entry.bin).toBe(profile.bin);
      expect(typeof entry.found).toBe("boolean");
      expect(entry.models).toBeNull(); // discovery disabled in tests
      expect(entry.discoveryError).toBeUndefined();
      expect(entry.auth).toBeUndefined(); // auth probes disabled in tests
      expect(entry.displayName).toBe(profile.displayName);
    }

    // mock → bun, which must resolve on the BUILT child PATH.
    expect(doc.harnesses.mock.bin).toBe("bun");
    expect(doc.harnesses.mock.found).toBe(true);
    expect(doc.harnesses.mock.path).toBeDefined();
    // probeVersions:false in tests — never exec the real harness CLIs.
    expect(doc.harnesses.mock.version).toBeUndefined();

    expect(doc.host.pid).toBe(process.pid);
    expect(typeof doc.host.stateFile).toBe("string");
    expect(typeof doc.host.uptime).toBe("number");

    // ?refresh=1 re-probes (a no-op with discovery disabled, but the param
    // path must answer with the same shape).
    const refreshed = await req<Doctor>(host, "GET", "/api/doctor?refresh=1");
    expect(refreshed.harnesses.mock.found).toBe(true);
  });

  test("roster-only custom harness ids are reported honestly as unrunnable", async () => {
    const host = boot();
    await addGhostToRoster(host);
    const doc = await req<Doctor>(host, "GET", "/api/doctor");
    expect(doc.harnesses["ghost-harness"]).toBeDefined();
    expect(doc.harnesses["ghost-harness"].bin).toBeNull();
    expect(doc.harnesses["ghost-harness"].found).toBe(false);
    expect(doc.harnesses["ghost-harness"].models).toBeNull();
  });

  test("lastFailure surfaces the most recent error session for the harness", async () => {
    const host = boot();
    const { thread } = await makeThread(host, "Doctor Failure");
    await addGhostToRoster(host);
    await req<Post>(host, "POST", "/api/posts", {
      threadId: thread.id,
      author: "user",
      body: "@ghost-9 diagnose me",
    });
    await pollUntil(async () => {
      const s = await getState(host);
      return s.sessions.find((x) => x.handle === "ghost-9" && x.state === "error");
    }, "the ghost failure", 10_000);

    const doc = await req<Doctor>(host, "GET", "/api/doctor");
    expect(doc.harnesses["ghost-harness"].lastFailure).toBeDefined();
    expect(doc.harnesses["ghost-harness"].lastFailure!.reason).toBe("runner-not-found");
    expect(doc.harnesses["ghost-harness"].lastFailure!.message).toContain("ghost");
  });
});

// ── 9b. PUT /api/roster ─────────────────────────────────────────────────────

describe("PUT /api/roster", () => {
  test("round-trips through store.setRoster and /api/state", async () => {
    const host = boot();
    const roster: RosterEntry[] = [
      { handle: "fable-5", harness: "claude-code", model: "claude-fable-5", color: "#7c6df2" },
      { handle: "pi-runner", harness: "pi", model: "anthropic/claude-fable-5", color: "#123456" },
      { handle: "ghost-9", harness: "ghost-harness", color: "#999999" },
    ];
    const res = await req<{ ok: boolean }>(host, "PUT", "/api/roster", { roster });
    expect(res.ok).toBe(true);

    const state = await getState(host);
    expect(state.roster).toHaveLength(3);
    expect(state.roster.map((r) => r.handle)).toEqual(["fable-5", "pi-runner", "ghost-9"]);
    expect(state.roster[1].model).toBe("anthropic/claude-fable-5");

    // Survives a restart (persisted like everything else).
    const stateDir = newDir("elan-state-");
    const hostB = boot(stateDir);
    await req(hostB, "PUT", "/api/roster", { roster });
    hostB.stop();
    const revived = boot(stateDir);
    expect((await getState(revived)).roster.map((r) => r.handle)).toContain("pi-runner");
  });

  test("validation: 400 on non-array; junk entries + dupes + `user` filtered", async () => {
    const host = boot();
    for (const body of [{}, { roster: "nope" }, { roster: 42 }, null]) {
      const res = await fetch(`${host.url}/api/roster`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }

    await req(host, "PUT", "/api/roster", {
      roster: [
        { handle: "a-1", harness: "mock", color: "#111111" },
        { handle: "a-1", harness: "codex", color: "#222222" }, // dupe handle
        { handle: "user", harness: "mock", color: "#333333" }, // reserved
        { handle: "", harness: "mock", color: "#444444" }, // empty
        { notARoster: true }, // junk shape
        "just a string", // junk type
        { handle: "b-2", harness: "pi" }, // color defaulted
      ],
    });
    const state = await getState(host);
    expect(state.roster.map((r) => r.handle)).toEqual(["a-1", "b-2"]);
    expect(state.roster[0].harness).toBe("mock"); // first claim wins
    expect(state.roster[1].color.length).toBeGreaterThan(0);
  });
});

// ── 9c. telemetry: session-line WS broadcast + log replay ──────────────────

describe("session telemetry", () => {
  test(
    "live lines broadcast as {type:'session-line'} frames; the log replays over HTTP",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Telemetry");

      // Subscribe BEFORE spawning so every line is on the wire.
      const frames: { type: string; sessionId?: string; stream?: string; line?: string }[] = [];
      const ws = new WebSocket(`${host.url.replace("http://", "ws://")}/api/subscribe`);
      ws.onmessage = (ev) => {
        try {
          frames.push(JSON.parse(String(ev.data)) as (typeof frames)[number]);
        } catch {
          /* ignore */
        }
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws failed to open"));
      });

      try {
        await req<Post>(host, "POST", "/api/posts", {
          threadId: thread.id,
          author: "user",
          body: "@demo-bot narrate for the telemetry channel",
        });
        const done = await pollUntil(async () => {
          const s = await getState(host);
          return s.sessions.find(
            (x) => x.threadId === thread.id && x.handle === "demo-bot" && x.state === "done",
          );
        }, "the mock session to finish");

        // The mock's stdout narration line arrived as a session-line frame.
        const mine = await pollUntil(
          async () =>
            frames.some(
              (f) =>
                f.type === "session-line" &&
                f.sessionId === done.id &&
                f.stream === "out" &&
                (f.line ?? "").includes('"type":"mock"'),
            )
              ? frames.filter((f) => f.type === "session-line" && f.sessionId === done.id)
              : undefined,
          "the session-line frames to arrive",
        );
        for (const f of mine) {
          expect(f.sessionId).toBe(done.id);
          expect(["out", "err"]).toContain(f.stream!);
          expect(typeof f.line).toBe("string");
        }
        // State pushes still flow on the same channel.
        expect(frames.some((f) => f.type === "state")).toBe(true);

        // Completed sessions replay via GET /api/sessions/:id/log.
        const res = await fetch(`${host.url}/api/sessions/${done.id}/log`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        const log = await res.text();
        expect(log).toContain("[out]");
        expect(log).toContain('"type":"mock"');

        const missing = await fetch(`${host.url}/api/sessions/never-existed/log`);
        expect(missing.status).toBe(404);
      } finally {
        ws.close();
      }
    },
    40_000,
  );
});

// ── 10. context rendering ───────────────────────────────────────────────────

describe("renderThreadContext", () => {
  const fixture: BoardState = {
    projects: [
      { id: "p1", key: "ENG", name: "Engram", repoPath: "/tmp/engram", color: "#fff", createdAt: 1 },
    ],
    roster: [
      { handle: "fable-5", harness: "claude-code", color: "#7c6df2" },
      { handle: "gpt-5.6", harness: "codex", color: "#0f9d8f" },
    ],
    threads: [
      {
        id: "t1", projectId: "p1", number: 7, title: "Fix the flake",
        body: "The replay test flakes.", status: "in_progress", labels: [],
        createdBy: "user", createdAt: 1000, updatedAt: 9000,
        worktreePath: "/tmp/engram/.elan/worktrees/ENG-7",
      },
    ],
    posts: [
      { id: "r1", threadId: "t1", author: "user", body: "@fable-5 take a look", createdAt: 2000, kind: "comment", attachments: [] },
      { id: "r1a", threadId: "t1", author: "fable-5", body: "On it.", createdAt: 3000, replyTo: "r1", kind: "comment", attachments: [] },
      { id: "r1b", threadId: "t1", author: "gpt-5.6", body: "Root cause found: race in the writer.", createdAt: 4000, replyTo: "r1", kind: "resolution", attachments: [] },
      { id: "r2", threadId: "t1", author: "fable-5", body: "Open question: keep the lock?", createdAt: 5000, kind: "comment", attachments: [{ name: "notes.md", path: "notes.md" }] },
      { id: "r2a", threadId: "t1", author: "gpt-5.6", body: "Yes — drop it in v2.", createdAt: 6000, replyTo: "r2", kind: "comment", attachments: [] },
    ],
    events: [
      { id: "e1", threadId: "t1", actor: "user", type: "created", payload: {}, at: 1000 },
      { id: "e2", threadId: "t1", actor: "user", type: "tagged", payload: { handle: "fable-5" }, at: 2001 },
      { id: "e3", threadId: "t1", actor: "fable-5", type: "status", payload: { from: "todo", to: "in_progress" }, at: 7000 },
    ],
    sessions: [],
  };

  test("header, roster table, event one-liners", () => {
    const out = renderThreadContext(fixture, "t1");
    expect(out).toContain("# ENG-7: Fix the flake");
    expect(out).toContain("Status: in_progress");
    expect(out).toContain("The replay test flakes.");
    expect(out).toContain("## Roster");
    expect(out).toContain("| fable-5 | claude-code |");
    expect(out).toContain("| gpt-5.6 | codex |");
    expect(out).toContain("- user tagged @fable-5");
    expect(out).toContain("- fable-5 moved todo → in_progress");
  });

  test("resolved exchange collapses to its ⚑ line", () => {
    const out = renderThreadContext(fixture, "t1");
    expect(out).toContain(
      "- ⚑ [resolved, 2 replies — run `elan read r1` for the full exchange] " +
        "Root cause found: race in the writer.",
    );
    expect(out).not.toContain("On it."); // collapsed away
  });

  test("unresolved exchange renders fully, replies indented, attachments as paths", () => {
    const out = renderThreadContext(fixture, "t1");
    expect(out).toContain("**fable-5**: Open question: keep the lock?");
    expect(out).toContain("  **gpt-5.6**: Yes — drop it in v2.");
    expect(out).toContain("(attachment: notes.md)");
  });

  test("## You addresses the tagged handle with worktree + elan verbs", () => {
    const out = renderThreadContext(fixture, "t1", "fable-5");
    expect(out).toContain("## You");
    expect(out).toContain("You are **@fable-5**");
    expect(out).toContain("/tmp/engram/.elan/worktrees/ENG-7");
    expect(out).toContain("`elan post <text>`");
    expect(out).toContain("AGENTS.md");
    // Without a handle there is no You section.
    expect(renderThreadContext(fixture, "t1")).not.toContain("## You");
  });
});

// ── 11. wake-on endpoint ────────────────────────────────────────────────────

describe("POST /api/sessions/:id/wake-on", () => {
  test("flips the session to waiting with wakeOn set", async () => {
    const host = boot();
    const { thread } = await makeThread(host, "Wake Endpoint");
    await addGhostToRoster(host);
    // Any session record will do — the unknown-harness path mints one fast.
    await req<Post>(host, "POST", "/api/posts", {
      threadId: thread.id,
      author: "user",
      body: "@ghost-9 ping",
    });
    const session = await pollUntil(async () => {
      const s = await getState(host);
      return s.sessions.find((x) => x.threadId === thread.id && x.handle === "ghost-9");
    }, "a session record", 10_000);

    await req(host, "POST", `/api/sessions/${session.id}/wake-on`, {
      event: "session-end",
      handle: "fable-5",
    });
    const state = await getState(host);
    const updated = state.sessions.find((x) => x.id === session.id)!;
    expect(updated.state).toBe("waiting");
    expect(updated.wakeOn).toEqual({ event: "session-end", handle: "fable-5" });
    expect(updated.endedAt).toBeDefined(); // arming IS ending

    const missing = await fetch(`${host.url}/api/sessions/nope/wake-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "post" }),
    });
    expect(missing.status).toBe(404);

    const badEvent = await fetch(`${host.url}/api/sessions/${session.id}/wake-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "sunrise" }),
    });
    expect(badEvent.status).toBe(400);
  });
});

describe("silent-success fallback", () => {
  test("a session that never used elan gets its final message posted, tags suppressed", async () => {
    const prevSilent = process.env.ELAN_MOCK_SILENT;
    const prevExtra = process.env.ELAN_SPAWN_ENV_EXTRA;
    process.env.ELAN_MOCK_SILENT = "1";
    process.env.ELAN_SPAWN_ENV_EXTRA = "ELAN_MOCK_SILENT";
    try {
      const host = boot();
      const project = await req<{ id: string }>(host, "POST", "/api/projects", {
        name: "silent", repoPath: newDir("silent-repo-"),
      });
      const thread = await req<{ id: string }>(host, "POST", "/api/threads", {
        projectId: project.id, title: "silent test", body: "",
      });
      // quiet-bot answers only in its stream; fable-5 must NOT get summoned
      // by the mention inside the fallback text.
      await req(host, "PUT", "/api/roster", {
        roster: [
          { handle: "quiet-bot", harness: "mock", color: "#888" },
          { handle: "fable-5", harness: "claude-code", color: "#7c6df2" },
        ],
      });
      await req(host, "POST", "/api/posts", {
        threadId: thread.id, author: "user", body: "@quiet-bot go",
      });

      const state = await pollUntil(async () => {
        const s = await getState(host);
        const done = s.sessions.find((x) => x.handle === "quiet-bot" && x.state === "done");
        return done ? s : undefined;
      }, 20000);

      const fallback = state.posts.find(
        (p) => p.threadId === thread.id && p.author === "quiet-bot",
      );
      expect(fallback?.body).toContain("Streamed answer only");
      // suppressTags: the "@fable-5" inside the fallback text tags no one.
      expect(
        state.events.some(
          (e) => e.type === "tagged" && e.actor === "quiet-bot" &&
            (e.payload as { handle?: string }).handle === "fable-5",
        ),
      ).toBe(false);
      expect(state.sessions.some((x) => x.handle === "fable-5")).toBe(false);
    } finally {
      if (prevSilent === undefined) delete process.env.ELAN_MOCK_SILENT;
      else process.env.ELAN_MOCK_SILENT = prevSilent;
      if (prevExtra === undefined) delete process.env.ELAN_SPAWN_ENV_EXTRA;
      else process.env.ELAN_SPAWN_ENV_EXTRA = prevExtra;
    }
  });
});
