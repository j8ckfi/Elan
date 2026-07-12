// The Elan host — REST surface + persistence, the HOT-SESSION orchestrator
// (one record per (thread, handle) forever; every ping is a turn) proven end
// to end by the resident mock harness, the boot migration that collapses
// legacy record piles, context rendering, outcome extraction, the built
// child env, and /api/doctor. No network mocks: every test boots the real
// host in-process on an ephemeral port with a tmp ELAN_STATE_DIR. The mock
// harness is the ONLY spawner — the real claude/codex binaries are never
// executed (their stream formats are covered by recorded fixtures against
// extractOutcome).

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
  TURN_PING_SEPARATOR,
  buildChildEnv,
  extractOutcome,
  migrateSessions,
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

const CLI_PATH = join(import.meta.dir, "..", "dev", "elan-cli.ts");

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

async function tag(host: ElanHost, threadId: string, body: string): Promise<Post> {
  return req<Post>(host, "POST", "/api/posts", { threadId, author: "user", body });
}

/** ALL records for a (thread, handle) — the invariant says this is ≤ 1. */
const recordsFor = (state: BoardState, threadId: string, handle: string): AgentSessionRecord[] =>
  state.sessions.filter((s) => s.threadId === threadId && s.handle === handle);

const turnsOf = (r: AgentSessionRecord | undefined) => r?.turns ?? [];

/** Add @ghost-9 (harness with NO registry row) to the roster — the honest
 *  runner-not-found path. Every registry harness names a real bin (grok etc.
 *  exist on dev machines), so an unrunnable handle must use an unknown
 *  harness id, never a real one. */
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

  test("DELETE /api/projects/:id removes the project, threads, and resident children", async () => {
    const host = boot();
    const { project, thread } = await makeThread(host, "Doomed");
    // Summon the resident mock so a LIVE child exists when the delete lands.
    await tag(host, thread.id, "@demo-bot get comfortable");
    const record = await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "demo-bot")[0];
      return r?.state === "idle" && r.procKey ? r : undefined;
    }, "the resident mock to idle");
    const pid = Number(record.procKey);
    expect(Number.isFinite(pid)).toBe(true);
    // The resident child is alive while idle (hot!).
    expect(() => process.kill(pid, 0)).not.toThrow();

    await req(host, "DELETE", `/api/projects/${project.id}`);

    const state = await getState(host);
    expect(state.projects.some((p) => p.id === project.id)).toBe(false);
    expect(state.threads.some((t) => t.id === thread.id)).toBe(false);
    expect(state.posts.some((p) => p.threadId === thread.id)).toBe(false);
    expect(state.sessions.some((s) => s.threadId === thread.id)).toBe(false);

    // The resident child died with its project.
    await pollUntil(async () => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, "the resident child to die with the project");

    const missing = await fetch(`${host.url}/api/projects/nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  }, 40_000);

  test("PUT /api/state is 403 without the env gate, replaces + normalizes with it", async () => {
    const host = boot();
    const project = await req<Project>(host, "POST", "/api/projects", {
      name: "Wipe me",
      repoPath: "/tmp/elan-nowhere",
    });
    expect((await getState(host)).projects.some((p) => p.id === project.id)).toBe(true);

    const put = (body: unknown) =>
      fetch(`${host.url}/api/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // Ungated: refused, state untouched.
    delete process.env.ELAN_ALLOW_STATE_REPLACE;
    const forbidden = await put({ projects: [], threads: [] });
    expect(forbidden.status).toBe(403);
    expect((await getState(host)).projects.some((p) => p.id === project.id)).toBe(true);

    // Gated on: replaced, and missing arrays normalize to [].
    process.env.ELAN_ALLOW_STATE_REPLACE = "1";
    try {
      const ok = await put({ projects: [], threads: [] });
      expect(ok.status).toBe(200);
      const state = await getState(host);
      expect(state.projects).toHaveLength(0);
      expect(state.threads).toHaveLength(0);
      expect(state.roster).toHaveLength(0);
      expect(state.posts).toHaveLength(0);
    } finally {
      delete process.env.ELAN_ALLOW_STATE_REPLACE;
    }
  });
});

// ── 2. ping → turn: the full mock loop on ONE hot record ────────────────────

describe("ping → turn (resident mock)", () => {
  test(
    "@demo-bot runs the full loop: one record, turn done, idle, posts, artifact, worktree, log",
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
      await tag(host, thread.id, "@demo-bot please do the thing");

      const done = await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
      }, "demo-bot's first turn to finish");

      const state = await getState(host);
      // THE invariant: one record for the pair; the turn carries the claim.
      expect(recordsFor(state, thread.id, "demo-bot")).toHaveLength(1);
      const tagEv = state.events.find(
        (e) => e.threadId === thread.id && e.type === "tagged",
      )!;
      expect(turnsOf(done).map((t) => t.eventId)).toEqual([tagEv.id]);
      expect(done.queuedAt).toBeDefined();
      // The resident child is still alive — hot, never killed for idling.
      expect(done.procKey).toBeDefined();
      expect(() => process.kill(Number(done.procKey), 0)).not.toThrow();
      // The full transcript landed on disk (one log per RECORD).
      expect(done.logPath).toBeDefined();
      expect(existsSync(done.logPath!)).toBe(true);
      expect(readFileSync(done.logPath!, "utf8")).toContain("[out]");

      const events = state.events.filter((e) => e.threadId === thread.id);
      // session-start once per record; session-end NEVER on success.
      expect(
        events.filter((e) => e.type === "session-start" && e.payload.handle === "demo-bot"),
      ).toHaveLength(1);
      expect(events.some((e) => e.type === "session-end")).toBe(false);
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
    "THE clone regression: back-to-back pings → ONE record forever, turns in order",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Clone Bug");
      // Two tags back to back: the second lands while the first turn runs
      // (the mock's script takes ~1s). The old wake model cloned agents
      // here; the hot model just queues turn 2.
      await tag(host, thread.id, "@demo-bot go one");
      await tag(host, thread.id, "@demo-bot go two");

      await pollUntil(async () => {
        const s = await getState(host);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.author === "demo-bot" && p.body.startsWith("turn 2 ack:"),
        )
          ? true
          : undefined;
      }, "turn 2 to be acked");

      let state = await getState(host);
      // Exactly ONE session record for (thread, demo-bot), ever.
      const records = recordsFor(state, thread.id, "demo-bot");
      expect(records).toHaveLength(1);
      const tagEvents = state.events.filter(
        (e) => e.threadId === thread.id && e.type === "tagged",
      );
      expect(tagEvents).toHaveLength(2);
      // Both pings claimed as turns on THE record, run in order.
      expect(turnsOf(records[0]).map((t) => t.eventId)).toEqual(tagEvents.map((e) => e.id));
      expect(turnsOf(records[0]).every((t) => t.state === "done")).toBe(true);
      // The script ran once — turn 2 was an injected message, not a clone.
      expect(
        state.posts.filter(
          (p) => p.threadId === thread.id && p.body.startsWith("Looking at this now."),
        ),
      ).toHaveLength(1);
      expect(
        state.events.filter((e) => e.threadId === thread.id && e.type === "session-start"),
      ).toHaveLength(1);
      const pidBefore = records[0].procKey;
      expect(pidBefore).toBeDefined();

      // Assert again via a 3rd tag after idle: same record, same child.
      await tag(host, thread.id, "@demo-bot go three");
      await pollUntil(async () => {
        const s = await getState(host);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.body.startsWith("turn 3 ack:"),
        )
          ? true
          : undefined;
      }, "turn 3 to be acked");

      state = await getState(host);
      const after = recordsFor(state, thread.id, "demo-bot");
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(records[0].id);
      expect(turnsOf(after[0])).toHaveLength(3);
      expect(turnsOf(after[0]).every((t) => t.state === "done")).toBe(true);
      // Same resident child across turns — resurrection was not needed.
      expect(after[0].procKey).toBe(pidBefore);
      expect(state.events.some((e) => e.type === "session-end")).toBe(false);
    },
    40_000,
  );

  test(
    "a reply to the agent's exchange IS a ping: a turn on the SAME record",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Reply Ping");
      await tag(host, thread.id, "@demo-bot do the thing");
      await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
      }, "the first turn to finish");

      // Reply to the agent's root post — no @mention anywhere in the body.
      const state0 = await getState(host);
      const root = state0.posts.find(
        (p) => p.threadId === thread.id && p.author === "demo-bot" && !p.replyTo,
      )!;
      await req<Post>(host, "POST", "/api/posts", {
        threadId: thread.id,
        author: "user",
        body: "actually, please also check the flake",
        replyTo: root.id,
      });

      await pollUntil(async () => {
        const s = await getState(host);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.body.startsWith("turn 2 ack:"),
        )
          ? true
          : undefined;
      }, "the reply-ping turn to be acked");

      const state = await getState(host);
      const records = recordsFor(state, thread.id, "demo-bot");
      expect(records).toHaveLength(1);
      expect(turnsOf(records[0])).toHaveLength(2);
      expect(turnsOf(records[0]).every((t) => t.state === "done")).toBe(true);
      // The implicit tag event exists and is claimed by the same record.
      const tags = state.events.filter(
        (e) => e.threadId === thread.id && e.type === "tagged",
      );
      expect(tags).toHaveLength(2);
      expect(tags[1].actor).toBe("user");
    },
    40_000,
  );

  test(
    "residency: the resident child survives across two turns (same pid)",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Residency");
      await tag(host, thread.id, "@demo-bot turn one");
      const afterOne = await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
      }, "turn 1 to finish");
      const pid = afterOne.procKey;
      expect(pid).toBeDefined();

      await tag(host, thread.id, "@demo-bot turn two");
      const afterTwo = await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return turnsOf(r).length === 2 && turnsOf(r)[1].state === "done" ? r : undefined;
      }, "turn 2 to finish");
      // The child was NOT respawned: same pid, still alive.
      expect(afterTwo.procKey).toBe(pid);
      expect(() => process.kill(Number(pid), 0)).not.toThrow();
      expect((await getState(host)).sessions).toHaveLength(1);
    },
    40_000,
  );

  test(
    "resurrection: a dead resident child is replaced on the next ping — same record",
    async () => {
      const host = boot();
      const { thread } = await makeThread(host, "Resurrection");
      await tag(host, thread.id, "@demo-bot live once");
      const idle = await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
      }, "turn 1 to finish");
      const pid = Number(idle.procKey);

      // Kill the hot child between turns (SIGKILL — no goodbye).
      process.kill(pid, "SIGKILL");
      await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.procKey === undefined ? true : undefined;
      }, "the host to notice the child died");
      // Idle death is NOT an ending: no session-end, no error, still idle.
      let state = await getState(host);
      expect(recordsFor(state, thread.id, "demo-bot")[0].state).toBe("idle");
      expect(state.events.some((e) => e.type === "session-end")).toBe(false);

      await tag(host, thread.id, "@demo-bot rise");
      await pollUntil(async () => {
        const s = await getState(host);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.body.startsWith("turn 2 ack:"),
        )
          ? true
          : undefined;
      }, "the resurrected turn to be acked");

      state = await getState(host);
      const records = recordsFor(state, thread.id, "demo-bot");
      expect(records).toHaveLength(1); // resurrection, not duplication
      expect(records[0].id).toBe(idle.id);
      expect(turnsOf(records[0])).toHaveLength(2);
      expect(turnsOf(records[0])[1].state).toBe("done");
      expect(records[0].procKey).not.toBe(String(pid)); // a NEW child
      // Still exactly one session-start, ever (first spawn only).
      expect(
        state.events.filter(
          (e) => e.threadId === thread.id && e.type === "session-start",
        ),
      ).toHaveLength(1);
    },
    40_000,
  );
});

// ── 3. boot migration + durable turns across restarts ───────────────────────

describe("boot migration (legacy → hot)", () => {
  test("migrateSessions collapses a legacy pile to ONE record per (thread, handle)", () => {
    const now = Date.now();
    const mk = (over: Partial<AgentSessionRecord>): AgentSessionRecord => ({
      id: crypto.randomUUID(),
      threadId: "t1",
      handle: "grok-4.5",
      state: "done",
      startedAt: now - 1_000_000,
      ...over,
    });
    const sessions: AgentSessionRecord[] = [
      mk({ id: "s1", state: "waiting", wakeOn: { event: "post" }, triggerEventId: "e1", startedAt: now - 600_000 }),
      mk({ id: "s2", state: "done", triggerEventId: "e2", startedAt: now - 500_000 }),
      mk({ id: "s3", state: "error", reason: "timeout", triggerEventId: "e3", startedAt: now - 400_000 }),
      mk({ id: "s4", state: "done", reason: "absorbed-by-live-session", triggerEventId: "e4", startedAt: now - 300_000 }),
      mk({ id: "s5", state: "done", reason: "superseded-by-wake", triggerEventId: "e5", startedAt: now - 200_000 }),
      mk({ id: "s6", state: "running", harnessSessionId: "hs-keep", triggerEventId: "e6", logPath: "/tmp/s6.log", startedAt: now - 100_000 }),
      // A second (thread, handle): markers only.
      mk({ id: "s7", handle: "ghost-9", state: "error", reason: "unknown-handle", triggerEventId: "e7", startedAt: now - 250_000 }),
      mk({ id: "s8", handle: "ghost-9", state: "error", reason: "unknown-handle", triggerEventId: "e8", startedAt: now - 150_000 }),
    ];
    const state: BoardState = {
      projects: [], roster: [], threads: [], posts: [], events: [], sessions,
    };

    const { state: migrated, changed, notes } = migrateSessions(state, now);
    expect(changed).toBe(true);
    expect(migrated.sessions).toHaveLength(2);

    const grok = migrated.sessions.find((s) => s.handle === "grok-4.5")!;
    // Survivor = the record WITH a harnessSessionId; the id is preserved.
    expect(grok.id).toBe("s6");
    expect(grok.harnessSessionId).toBe("hs-keep");
    expect(grok.logPath).toBe("/tmp/s6.log");
    // running at shutdown → idle + orphaned-by-restart, never error.
    expect(grok.state).toBe("idle");
    expect(grok.reason).toBe("orphaned-by-restart");
    expect(grok.wakeOn).toBeUndefined();
    expect(grok.triggerEventId).toBeUndefined();
    // EVERY legacy claim became a done turn — nothing can respawn.
    expect(turnsOf(grok).map((t) => t.eventId).sort()).toEqual([
      "e1", "e2", "e3", "e4", "e5", "e6",
    ]);
    expect(turnsOf(grok).every((t) => t.state === "done")).toBe(true);

    const ghost = migrated.sessions.find((s) => s.handle === "ghost-9")!;
    expect(turnsOf(ghost).map((t) => t.eventId).sort()).toEqual(["e7", "e8"]);
    expect(ghost.state).toBe("idle"); // markers-only group → idle bookkeeping

    // The merge is loud: one note per collapsed group.
    expect(notes.some((n) => n.includes("merged 6 session records"))).toBe(true);
    expect(notes.some((n) => n.includes("merged 2 session records"))).toBe(true);
  });

  test(
    "a legacy state file (6 + 2 records) boots to exactly 1 + 1 with no spawns",
    async () => {
      const stateDir = newDir("elan-state-");
      const hostA = boot(stateDir);
      const { thread } = await makeThread(hostA, "Legacy Pile");
      hostA.stop();

      const file = join(stateDir, "board.json");
      const disk = JSON.parse(readFileSync(file, "utf8")) as BoardState;
      const now = Date.now();
      // Recent (not stale) tagged events, every one already claimed by a
      // legacy record's triggerEventId.
      for (let i = 1; i <= 8; i++) {
        disk.events.push({
          id: `e${i}`,
          threadId: thread.id,
          actor: "user",
          type: "tagged",
          payload: { handle: i <= 6 ? "demo-bot" : "ghost-9" },
          at: now - 60_000 * i,
        });
      }
      const mk = (over: Partial<AgentSessionRecord>): AgentSessionRecord =>
        ({
          id: crypto.randomUUID(),
          threadId: thread.id,
          handle: "demo-bot",
          state: "done",
          startedAt: now - 1_000_000,
          ...over,
        }) as AgentSessionRecord;
      disk.sessions.push(
        mk({ id: "s1", state: "waiting", wakeOn: { event: "post" }, triggerEventId: "e1", startedAt: now - 600_000 }),
        mk({ id: "s2", state: "done", triggerEventId: "e2", startedAt: now - 500_000 }),
        mk({ id: "s3", state: "error", reason: "timeout", triggerEventId: "e3", startedAt: now - 400_000 }),
        mk({ id: "s4", state: "done", reason: "absorbed-by-live-session", triggerEventId: "e4", startedAt: now - 300_000 }),
        mk({ id: "s5", state: "done", reason: "superseded-by-wake", triggerEventId: "e5", startedAt: now - 200_000 }),
        mk({ id: "s6", state: "spawning", harnessSessionId: "hs-keep", triggerEventId: "e6", startedAt: now - 100_000 }),
        mk({ id: "s7", handle: "ghost-9", state: "error", reason: "unknown-handle", triggerEventId: "e7", startedAt: now - 250_000 }),
        mk({ id: "s8", handle: "ghost-9", state: "error", reason: "unknown-handle", triggerEventId: "e8", startedAt: now - 150_000 }),
      );
      writeFileSync(file, JSON.stringify(disk));

      const hostB = boot(stateDir);
      const state = await getState(hostB);
      expect(recordsFor(state, thread.id, "demo-bot")).toHaveLength(1);
      expect(recordsFor(state, thread.id, "ghost-9")).toHaveLength(1);
      const demo = recordsFor(state, thread.id, "demo-bot")[0];
      expect(demo.id).toBe("s6");
      expect(demo.harnessSessionId).toBe("hs-keep");
      expect(demo.state).toBe("idle");
      expect(turnsOf(demo)).toHaveLength(6);
      expect(turnsOf(demo).every((t) => t.state === "done")).toBe(true);

      // Give the reconciler ticks a chance to misbehave: no spawns for the
      // already-claimed events, no new records, ever.
      await new Promise((r) => setTimeout(r, 2_500)); // > one 2s tick
      const after = await getState(hostB);
      expect(after.sessions).toHaveLength(2);
      expect(after.events.some((e) => e.type === "session-start")).toBe(false);
      expect(turnsOf(recordsFor(after, thread.id, "demo-bot")[0]).every((t) => t.state === "done")).toBe(true);

      // The collapse landed on DISK at boot, before any mutation.
      hostB.stop();
      const persisted = JSON.parse(readFileSync(file, "utf8")) as BoardState;
      expect(persisted.sessions).toHaveLength(2);
    },
    40_000,
  );

  test(
    "restart mid-turn: the record survives as idle/orphaned, the NEXT ping runs",
    async () => {
      const stateDir = newDir("elan-state-");
      const hostA = boot(stateDir);
      const { thread } = await makeThread(hostA, "Restart");
      await tag(hostA, thread.id, "@demo-bot do the durable thing");
      // Wait for the turn to be IN FLIGHT (child spawned), then die mid-run.
      await pollUntil(async () => {
        const s = await getState(hostA);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "running" && r.procKey ? r : undefined;
      }, "the turn to be in flight");
      hostA.stop();

      const disk = JSON.parse(readFileSync(join(stateDir, "board.json"), "utf8")) as BoardState;
      const tagEv = disk.events.find((e) => e.type === "tagged")!;
      expect(disk.sessions).toHaveLength(1);
      expect(turnsOf(disk.sessions[0]).map((t) => t.eventId)).toEqual([tagEv.id]);

      const hostB = boot(stateDir);
      const recovered = await pollUntil(async () => {
        const s = await getState(hostB);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return r?.state === "idle" ? r : undefined;
      }, "the orphaned record to settle idle");
      // NOT an error, no session-end — the interrupted turn is failed and
      // the record is simply idle.
      expect(recovered.reason).toBe("orphaned-by-restart");
      expect(turnsOf(recovered)[0].state).toBe("failed");
      expect(
        (await getState(hostB)).events.filter(
          (e) => e.type === "session-end" && e.at > recovered.startedAt,
        ),
      ).toHaveLength(0);

      // The next ping simply runs a turn — on the SAME record.
      await tag(hostB, thread.id, "@demo-bot carry on");
      await pollUntil(async () => {
        const s = await getState(hostB);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.body.startsWith("turn 2 ack:"),
        )
          ? true
          : undefined;
      }, "the post-restart turn to be acked");
      const state = await getState(hostB);
      expect(recordsFor(state, thread.id, "demo-bot")).toHaveLength(1);
      expect(recordsFor(state, thread.id, "demo-bot")[0].id).toBe(recovered.id);
    },
    40_000,
  );

  test(
    "stale (>24h) tags at boot are claimed as done turns — no spawn, no post",
    async () => {
      const stateDir = newDir("elan-state-");
      const hostA = boot(stateDir);
      const { thread } = await makeThread(hostA, "Archaeology");
      hostA.stop();

      const file = join(stateDir, "board.json");
      const disk = JSON.parse(readFileSync(file, "utf8")) as BoardState;
      const staleTag: BoardEvent = {
        id: "stale-tag",
        threadId: thread.id,
        actor: "user",
        type: "tagged",
        payload: { handle: "demo-bot" },
        at: Date.now() - 25 * 60 * 60 * 1000,
      };
      disk.events.push(staleTag);
      writeFileSync(file, JSON.stringify(disk));

      const hostB = boot(stateDir);
      const claimed = await pollUntil(async () => {
        const s = await getState(hostB);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return turnsOf(r).some((t) => t.eventId === "stale-tag") ? r : undefined;
      }, "the stale tag to be claimed", 10_000);
      expect(turnsOf(claimed).find((t) => t.eventId === "stale-tag")!.state).toBe("done");
      expect(claimed.state).toBe("idle"); // settled, nothing pending

      const state = await getState(hostB);
      expect(recordsFor(state, thread.id, "demo-bot")).toHaveLength(1);
      expect(state.events.some((e) => e.type === "session-start")).toBe(false); // no spawn
      expect(state.posts.filter((p) => p.body.startsWith("⚠︎"))).toHaveLength(0);
    },
    40_000,
  );
});

// ── 4. limits: the per-thread turn budget ───────────────────────────────────

describe("per-thread turn budget", () => {
  test("UNCAPPED by default — agent chains are the product, not a bug", async () => {
    const host = boot(); // no ELAN_THREAD_BUDGET, no threadBudget override
    const { thread } = await makeThread(host, "Uncapped");
    for (let i = 0; i < 3; i++) {
      await tag(host, thread.id, `@demo-bot go ${i}`);
    }
    // Every tag becomes a real turn on THE record — never a budget drop.
    await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "demo-bot")[0];
      return turnsOf(r).length === 3 && turnsOf(r).every((t) => t.state === "done")
        ? true
        : undefined;
    }, "all three turns to finish");
    const s = await getState(host);
    expect(recordsFor(s, thread.id, "demo-bot")).toHaveLength(1);
    expect(s.posts.some((p) => p.body.includes("budget"))).toBe(false);
  }, 40_000);

  test(
    "the ping past the budget is dropped: a failed turn + one ⚠︎ post, still ONE record",
    async () => {
      const host = boot(undefined, { threadBudget: 2 });
      const { thread } = await makeThread(host, "Budget");
      await addGhostToRoster(host);

      // ghost-9's harness has no registry row → each turn errors fast
      // (runner-not-found), which still counts as a turn run.
      for (let i = 1; i <= 2; i++) {
        await tag(host, thread.id, `@ghost-9 attempt ${i}`);
        await pollUntil(async () => {
          const s = await getState(host);
          const r = recordsFor(s, thread.id, "ghost-9")[0];
          const failed = turnsOf(r).filter((t) => t.state === "failed");
          return failed.length >= i ? true : undefined;
        }, `attempt ${i} to fail`);
      }

      await tag(host, thread.id, "@ghost-9 attempt 3 — over budget");
      await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "ghost-9")[0];
        return turnsOf(r).length === 3 ? true : undefined;
      }, "the third ping to be claimed");

      const state = await getState(host);
      // Still ONE record — a budget drop mints no marker records.
      const records = recordsFor(state, thread.id, "ghost-9");
      expect(records).toHaveLength(1);
      expect(turnsOf(records[0])).toHaveLength(3);
      expect(turnsOf(records[0]).every((t) => t.state === "failed")).toBe(true);
      const budgetPosts = state.posts.filter(
        (p) =>
          p.threadId === thread.id &&
          p.body.startsWith("⚠︎") &&
          p.body.includes("budget"),
      );
      expect(budgetPosts).toHaveLength(1);
    },
    40_000,
  );
});

// ── 5. preflight: unknown harness / missing runner fails the TURN honestly ──

describe("runner preflight", () => {
  test("@ghost-9 (unknown harness) → failed turn, error badge, session-end(error), ⚠︎ post", async () => {
    const host = boot();
    const { thread } = await makeThread(host, "No Adapter");
    await addGhostToRoster(host);
    await tag(host, thread.id, "@ghost-9 hi");

    const errored = await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "ghost-9")[0];
      return r?.state === "error" ? r : undefined;
    }, "ghost-9's turn to fail", 10_000);
    expect(errored.reason).toBe("runner-not-found");
    expect(turnsOf(errored)).toHaveLength(1);
    expect(turnsOf(errored)[0].state).toBe("failed");

    const state = await getState(host);
    // session-end fires ONLY on turn failure — and this is one.
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

    // The error badge never blocks the loop: a repeat ping claims turn 2 on
    // the SAME record and fails it just as honestly.
    await tag(host, thread.id, "@ghost-9 try again");
    await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "ghost-9")[0];
      return turnsOf(r).length === 2 && turnsOf(r)[1].state === "failed" ? true : undefined;
    }, "the repeat ping to fail its turn too", 10_000);
    expect(recordsFor(await getState(host), thread.id, "ghost-9")).toHaveLength(1);
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

  test("raw: last stdout line; stripAnsi scrubs CSI + OSC sequences", () => {
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

// ── 6c. the harness registry: runner argv + residency shapes (pure) ─────────

describe("HARNESSES registry", () => {
  const baseCtx: RunnerCtx = {
    binPath: "/bin/fake",
    prompt: "THE CONTEXT",
    instructions: "THE INSTRUCTIONS",
    cwd: "/work/tree",
    sessionId: "sess-1",
    sessionDir: "/state/sessions",
  };
  const spec = (harness: string, ctx: Partial<RunnerCtx> = {}): RunnerSpec => {
    const r = HARNESSES[harness].runner!({ ...baseCtx, ...ctx });
    if (!("argv" in r)) throw new Error(`runner errored: ${r.error}`);
    return r;
  };

  test("every registry row is complete; runner XOR residency", () => {
    for (const [id, p] of Object.entries(HARNESSES)) {
      expect(p.id).toBe(id);
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p.bin.length).toBeGreaterThan(0);
      expect(typeof p.extract).toBe("string");
      // Exactly one execution strategy per harness.
      expect(Boolean(p.runner) !== Boolean(p.residency)).toBe(true);
    }
    // The registry covers exactly the v1 harness set.
    expect(Object.keys(HARNESSES).sort()).toEqual([
      "claude-code", "codex", "cursor", "devin", "grok", "mock", "opencode", "pi", "pool",
    ]);
    // The resident set is exactly claude-code, pi, and the mock.
    expect(
      Object.entries(HARNESSES)
        .filter(([, p]) => p.residency)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["claude-code", "mock", "pi"]);
  });

  test("claude-code residency: bidirectional stream-json, NO prompt argv, resume on resurrection", () => {
    const res = HARNESSES["claude-code"].residency!;
    expect(
      res.argv({ binPath: "/bin/fake", instructions: "THE INSTRUCTIONS", model: "claude-fable-5" }),
    ).toEqual([
      "/bin/fake", "-p",
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--permission-mode", "bypassPermissions",
      "--append-system-prompt", "THE INSTRUCTIONS",
      "--model", "claude-fable-5",
    ]);
    const resumed = res.argv({
      binPath: "/bin/fake", instructions: "I", resume: "hs-1",
    });
    expect(resumed).toContain("--resume");
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("hs-1");
    // No prompt ever rides argv — turns are stdin messages.
    expect(resumed).not.toContain("THE CONTEXT");

    // The turn wire shape (cribbed from src/lib/adapters/claude-code).
    expect(JSON.parse(res.encodeTurn("do it", 2))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "do it" }] },
    });
    expect(res.isTurnEnd({ type: "result", subtype: "success" })).toBe(true);
    expect(res.isTurnEnd({ type: "assistant" })).toBe(false);
  });

  test("pi residency: --mode rpc, prompt commands, --session-id resurrection", () => {
    const res = HARNESSES.pi.residency!;
    expect(
      res.argv({ binPath: "/bin/fake", instructions: "I", model: "anthropic/claude-fable-5" }),
    ).toEqual([
      "/bin/fake", "--mode", "rpc",
      "--model", "anthropic/claude-fable-5",
      "--append-system-prompt", "I",
    ]);
    const resumed = res.argv({ binPath: "/bin/fake", instructions: "I", resume: "pi-sess" });
    expect(resumed[resumed.indexOf("--session-id") + 1]).toBe("pi-sess");

    // Turns are prompt commands per src/lib/adapters/pi/protocol.ts.
    expect(JSON.parse(res.encodeTurn("hello", 3))).toEqual({
      id: "elan-turn-3",
      type: "prompt",
      message: "hello",
    });
    expect(res.isTurnEnd({ type: "agent_end" })).toBe(true);
    expect(res.isTurnEnd({ type: "response", command: "prompt", success: true })).toBe(true);
    expect(res.isTurnEnd({ type: "turn_end" })).toBe(false);
  });

  test("mock residency: bun + the agent script; turns as {prompt, turn} lines", () => {
    const res = HARNESSES.mock.residency!;
    const argv = res.argv({ binPath: "/bin/bun", instructions: "I" });
    expect(argv[0]).toBe("/bin/bun");
    expect(argv[1]).toEndWith("mock-agent.ts");
    expect(JSON.parse(res.encodeTurn("P", 2))).toEqual({ prompt: "P", turn: 2 });
    expect(res.isTurnEnd({ type: "result" })).toBe(true);
    // The mock speaks the claude-stream dialect for turn ends.
    expect(HARNESSES.mock.extract).toBe("claude-stream");
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

  test("opencode: -m is mandatory — unpinned roster entries fail honestly", () => {
    const r = HARNESSES.opencode.runner!(baseCtx); // no model
    expect("error" in r && r.error).toContain("model");

    const s = spec("opencode", { model: "opencode/deepseek-v4-flash-free" });
    expect(s.argv.slice(0, 4)).toEqual(["/bin/fake", "run", "--format", "json"]);
    expect(s.argv).toContain("-m");
    expect(s.argv[s.argv.length - 1]).toContain(THREAD_CONTEXT_SEPARATOR);

    const resumed = spec("opencode", {
      model: "m", prompt: "TURN", resume: { harnessSessionId: "ses_x" },
    });
    expect(resumed.argv).toContain("-s");
    expect(resumed.argv).toContain("ses_x");
  });

  test("cursor: --force --trust, prompt as argv, instructions prepended", () => {
    const s = spec("cursor", { model: "composer-2.5" });
    expect(s.argv).toContain("--force");
    expect(s.argv).toContain("--trust");
    expect(s.argv[s.argv.length - 1]).toContain(THREAD_CONTEXT_SEPARATOR);
    const resumed = spec("cursor", { prompt: "TURN", resume: { harnessSessionId: "chat-1" } });
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

    const empty = HARNESSES.devin.runner!({ ...baseCtx, prompt: "  " });
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
    expect("error" in HARNESSES.grok.runner!(baseCtx)).toBe(true);
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

// ── 8. the per-TURN timeout ─────────────────────────────────────────────────

describe("per-turn timeout", () => {
  test(
    "a stalled turn is killed and failed; the record idles; the next ping succeeds",
    async () => {
      // Tiny per-turn budget. The mock's stall mode ("[stall]" in the PING,
      // never the history) blocks without settling the turn.
      const host = boot(undefined, { sessionTimeoutMs: 3_000 });
      const { thread } = await makeThread(host, "Timeout");
      await tag(host, thread.id, "@demo-bot do it [stall]");

      const timedOut = await pollUntil(async () => {
        const s = await getState(host);
        const r = recordsFor(s, thread.id, "demo-bot")[0];
        return turnsOf(r)[0]?.state === "failed" && r?.state === "idle" ? r : undefined;
      }, "the stalled turn to time out", 30_000);
      // Turn timeout → turn failed, record IDLE (not error): the next ping
      // resurrects.
      expect(timedOut.reason).toBe("timeout");
      expect(timedOut.procKey).toBeUndefined(); // the child was killed

      let state = await getState(host);
      expect(
        state.posts.some(
          (p) =>
            p.threadId === thread.id &&
            p.author === "demo-bot" &&
            p.body.startsWith("⚠︎") &&
            p.body.includes("timed out"),
        ),
      ).toBe(true);
      // session-end(error) — a turn failure IS the only ending.
      expect(
        state.events.some(
          (e) => e.type === "session-end" && e.payload.outcome === "error",
        ),
      ).toBe(true);

      // The next ping runs a fresh turn on the SAME record and succeeds.
      await tag(host, thread.id, "@demo-bot recover");
      await pollUntil(async () => {
        const s = await getState(host);
        return s.posts.some(
          (p) => p.threadId === thread.id && p.body.startsWith("turn 2 ack:"),
        )
          ? true
          : undefined;
      }, "the recovery turn to be acked", 30_000);
      state = await getState(host);
      const records = recordsFor(state, thread.id, "demo-bot");
      expect(records).toHaveLength(1);
      expect(turnsOf(records[0])[1].state).toBe("done");
      expect(records[0].state).toBe("idle");
      expect(records[0].reason).toBeUndefined(); // the badge cleared
    },
    60_000,
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

  test("lastFailure surfaces the most recent failed turn for the harness", async () => {
    const host = boot();
    const { thread } = await makeThread(host, "Doctor Failure");
    await addGhostToRoster(host);
    await tag(host, thread.id, "@ghost-9 diagnose me");
    await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "ghost-9")[0];
      return r?.state === "error" ? r : undefined;
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
        await tag(host, thread.id, "@demo-bot narrate for the telemetry channel");
        const done = await pollUntil(async () => {
          const s = await getState(host);
          const r = recordsFor(s, thread.id, "demo-bot")[0];
          return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
        }, "the mock turn to finish");

        // The mock's stdout narration line arrived as a session-line frame,
        // keyed by the RECORD id.
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

        // Session logs replay via GET /api/sessions/:id/log (one per record,
        // appended across turns).
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
  const fixtureState: BoardState = {
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
        body: "The replay test flakes.", labels: [],
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
      // A status-era event from stale storage — must degrade, not crash.
      { id: "e3", threadId: "t1", actor: "fable-5", type: "status" as never, payload: { from: "todo", to: "in_progress" }, at: 7000 },
    ],
    sessions: [],
  };

  test("header, roster table, event one-liners", () => {
    const out = renderThreadContext(fixtureState, "t1");
    expect(out).toContain("# ENG-7: Fix the flake");
    expect(out).toContain("Project: Engram (/tmp/engram)");
    expect(out).toContain("The replay test flakes.");
    expect(out).toContain("## Roster");
    expect(out).toContain("| fable-5 | claude-code |");
    expect(out).toContain("| gpt-5.6 | codex |");
    expect(out).toContain("- user tagged @fable-5");
    expect(out).toContain("- fable-5: status"); // stale event type degrades
  });

  test("resolved exchange collapses to its ⚑ line", () => {
    const out = renderThreadContext(fixtureState, "t1");
    expect(out).toContain(
      "- ⚑ [resolved, 2 replies — run `elan read r1` for the full exchange] " +
        "Root cause found: race in the writer.",
    );
    expect(out).not.toContain("On it."); // collapsed away
  });

  test("unresolved exchange renders fully, replies indented, attachments as paths", () => {
    const out = renderThreadContext(fixtureState, "t1");
    expect(out).toContain("**fable-5**: Open question: keep the lock?");
    expect(out).toContain("  **gpt-5.6**: Yes — drop it in v2.");
    expect(out).toContain("(attachment: notes.md)");
  });

  test("## You addresses the tagged handle; hot-session guidance, no wake verbs", () => {
    const out = renderThreadContext(fixtureState, "t1", "fable-5");
    expect(out).toContain("## You");
    expect(out).toContain("You are **@fable-5**");
    expect(out).toContain("/tmp/engram/.elan/worktrees/ENG-7");
    expect(out).toContain("`elan post <text>`");
    expect(out).toContain("AGENTS.md");
    // The hot model replaced wake-me/wait.
    expect(out).toContain("session stays hot");
    expect(out).not.toContain("wake-me");
    // Without a handle there is no You section.
    expect(renderThreadContext(fixtureState, "t1")).not.toContain("## You");
  });
});

// ── 11. wake-on is GONE ─────────────────────────────────────────────────────

describe("wake removal", () => {
  test("POST /api/sessions/:id/wake-on answers 410 with the hot-session message", async () => {
    const host = boot();
    const res = await fetch(`${host.url}/api/sessions/any-id-at-all/wake-on`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "post" }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wake-on is gone: sessions are hot; every ping is a turn");
  });

  test("`elan wait`/`elan wake-me` print the hot message and exit 0", () => {
    for (const verb of ["wait", "wake-me"]) {
      const r = Bun.spawnSync([process.execPath, CLI_PATH, verb, "--on", "post"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(
        "Sessions stay hot — end your turn; new pings arrive as new turns.",
      );
    }
  });
});

// ── 12. silent-success fallback (per turn) ──────────────────────────────────

describe("silent-success fallback", () => {
  test("a turn that never used elan gets its final message posted, tags suppressed", async () => {
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
        const r = recordsFor(s, thread.id, "quiet-bot")[0];
        return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? s : undefined;
      }, "the silent turn to finish");

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
      // A ventriloquized turn is not a quiet turn — no caught-up line.
      expect(
        state.events.some((e) => e.threadId === thread.id && e.type === "caught-up"),
      ).toBe(false);
    } finally {
      if (prevSilent === undefined) delete process.env.ELAN_MOCK_SILENT;
      else process.env.ELAN_MOCK_SILENT = prevSilent;
      if (prevExtra === undefined) delete process.env.ELAN_SPAWN_ENV_EXTRA;
      else process.env.ELAN_SPAWN_ENV_EXTRA = prevExtra;
    }
  }, 40_000);

  test("a quiet turn after the agent has spoken files caught-up, not a post", async () => {
    const host = boot();
    const project = await req<{ id: string }>(host, "POST", "/api/projects", {
      name: "quiet turns", repoPath: newDir("quiet-repo-"),
    });
    const thread = await req<{ id: string }>(host, "POST", "/api/threads", {
      projectId: project.id, title: "quiet turns", body: "",
    });

    // Turn 1: the demo script — the agent speaks on the board.
    await req(host, "POST", "/api/posts", {
      threadId: thread.id, author: "user", body: "@demo-bot do the thing",
    });
    await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "demo-bot")[0];
      return r?.state === "idle" && turnsOf(r)[0]?.state === "done" ? r : undefined;
    }, "the first (speaking) turn to finish");
    const postsBefore = (await getState(host)).posts.filter(
      (p) => p.threadId === thread.id && p.author === "demo-bot",
    ).length;

    // Turn 2: the etiquette no-op — stream-only turn end, zero elan calls.
    await req(host, "POST", "/api/posts", {
      threadId: thread.id, author: "user", body: "@demo-bot [quiet] just fyi",
    });
    const state = await pollUntil(async () => {
      const s = await getState(host);
      const r = recordsFor(s, thread.id, "demo-bot")[0];
      const turns = r ? turnsOf(r) : [];
      return r?.state === "idle" && turns.length === 2 && turns[1].state === "done"
        ? s
        : undefined;
    }, "the quiet turn to finish");

    // Silence stayed silent: the agent has spoken before, so its stream text
    // is NOT ventriloquized — the turn files one caught-up event instead.
    expect(
      state.posts.filter((p) => p.threadId === thread.id && p.author === "demo-bot"),
    ).toHaveLength(postsBefore);
    const quiet = state.events.filter(
      (e) => e.threadId === thread.id && e.type === "caught-up",
    );
    expect(quiet).toHaveLength(1);
    expect(quiet[0].actor).toBe("demo-bot");
  }, 40_000);
});

// ── 13. the turn-prompt seam the mock relies on ─────────────────────────────

describe("turn prompts", () => {
  test("TURN_PING_SEPARATOR is the literal the mock mirrors", () => {
    // dev/mock-agent.ts hardcodes this to find the ping section of a
    // full-context prompt (stall detection must not fire on history).
    expect(TURN_PING_SEPARATOR).toBe("── this turn's ping ──");
  });
});
