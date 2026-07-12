// Board store contract — the rules docs/DATA-MODEL.md says the store (not
// callers) enforces: reply flattening, mention tagging, updatedAt bumps, and
// hostile-input normalization (normalizeState).

import { describe, expect, test } from "bun:test";
import { createBoardStore, normalizeState } from "@/lib/board/store";
import { emptyState, seedState } from "@/lib/board/seed";
import { toExchanges, type BoardState } from "@/lib/board/types";

// The board is always host-backed now (local mode is gone, 2026-07-12), so
// these unit tests drive the rules module directly with a no-op persist.
// seedState survives only as a rich test fixture.
function seededStore() {
  return createBoardStore({ initial: seedState(), persist: () => {} });
}

// A first-run (empty) store — the default roster, no projects or threads.
function emptyStore() {
  return createBoardStore({ initial: emptyState(), persist: () => {} });
}

describe("updateThread", () => {
  test("patches fields and emits no events (statuses were removed 2026-07-11)", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });
    const eventsBefore = store.getState().events.length;

    store.updateThread(thread.id, { title: "renamed", labels: ["x"] }, "user");

    const updated = store.getState().threads.find((t) => t.id === thread.id)!;
    expect(updated.title).toBe("renamed");
    expect(updated.labels).toEqual(["x"]);
    expect(store.getState().events).toHaveLength(eventsBefore);
  });
});

describe("deleteThread", () => {
  test("removes the thread and all its posts/events/sessions", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    store.addPost({ threadId: thread.id, author: "user", body: "hello" });
    store.addEvent({ threadId: thread.id, actor: "fable-5", type: "tagged", payload: { handle: "fable-5" } });

    store.deleteThread(thread.id);

    const state = store.getState();
    expect(state.threads.some((t) => t.id === thread.id)).toBe(false);
    expect(state.posts.some((p) => p.threadId === thread.id)).toBe(false);
    expect(state.events.some((e) => e.threadId === thread.id)).toBe(false);
    expect(state.sessions.some((s) => s.threadId === thread.id)).toBe(false);
  });

  test("leaves other threads' data untouched", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const keep = store.createThread({ projectId: project.id, title: "keep", body: "b" });
    const gone = store.createThread({ projectId: project.id, title: "gone", body: "b" });
    store.addPost({ threadId: keep.id, author: "user", body: "still here" });

    store.deleteThread(gone.id);

    const state = store.getState();
    expect(state.threads.some((t) => t.id === keep.id)).toBe(true);
    expect(state.posts.some((p) => p.threadId === keep.id)).toBe(true);
  });
});

describe("addPost", () => {
  test("replyTo chains are flattened to the top-level post", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    const root = store.addPost({ threadId: thread.id, author: "user", body: "root" });
    const reply1 = store.addPost({
      threadId: thread.id,
      author: "fable-5",
      body: "reply1",
      replyTo: root.id,
    });
    const reply2 = store.addPost({
      threadId: thread.id,
      author: "gpt-5.6",
      body: "reply2, deeper",
      replyTo: reply1.id,
    });

    expect(reply1.replyTo).toBe(root.id);
    expect(reply2.replyTo).toBe(root.id); // re-parented past reply1
  });

  test("mentions emit tagged events, skipping self-mentions", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    store.addPost({
      threadId: thread.id,
      author: "fable-5",
      body: "hey @gpt-5.6 and @fable-5 look at this, also @not-a-handle",
    });

    const tagged = store
      .getState()
      .events.filter((e) => e.threadId === thread.id && e.type === "tagged");
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ actor: "fable-5", payload: { handle: "gpt-5.6" } });
  });

  test("no mentions means no tagged events", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    store.addPost({ threadId: thread.id, author: "user", body: "no mentions here" });

    expect(
      store.getState().events.filter((e) => e.threadId === thread.id && e.type === "tagged"),
    ).toHaveLength(0);
  });

  test("bumps the thread's updatedAt", async () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });
    const before = store.getState().threads.find((t) => t.id === thread.id)!.updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    store.addPost({ threadId: thread.id, author: "user", body: "hello" });

    const after = store.getState().threads.find((t) => t.id === thread.id)!.updatedAt;
    expect(after).toBeGreaterThan(before);
  });
});

describe("seed data — flagship exchange", () => {
  test("the plan exchange resolves via toExchanges", () => {
    const state = seedState();
    const thread = state.threads.find((t) =>
      t.title.startsWith("Memory engram geometry"),
    )!;
    expect(thread).toBeDefined();

    const threadPosts = state.posts.filter((p) => p.threadId === thread.id);
    const exchanges = toExchanges(threadPosts);
    const planExchange = exchanges.find((x) => x.root.body.startsWith("Plan ready"))!;

    expect(planExchange).toBeDefined();
    // critique + 8 back-and-forth + resolution
    expect(planExchange.replies).toHaveLength(10);
    expect(planExchange.resolution).toBeDefined();
    expect(planExchange.resolution?.kind).toBe("resolution");
    expect(planExchange.resolution?.body).toContain("Plan v2");
    expect(planExchange.resolution?.author).toBe("fable-5");
  });

  test("the live decay-curve exchange is unresolved", () => {
    const state = seedState();
    const thread = state.threads.find((t) => t.id === "thread-eng-5")!;
    const threadPosts = state.posts.filter((p) => p.threadId === thread.id);
    const exchanges = toExchanges(threadPosts);
    const live = exchanges.find((x) => x.replies.length > 0)!;

    expect(live).toBeDefined();
    expect(live.replies.length).toBeGreaterThanOrEqual(2);
    expect(live.resolution).toBeUndefined();

    const running = state.sessions.find((s) => s.threadId === thread.id && s.state === "running");
    const waiting = state.sessions.find((s) => s.threadId === thread.id && s.state === "waiting");
    expect(running).toBeDefined();
    expect(waiting?.wakeOn).toEqual({ event: "session-end", handle: "grok-4.5" });
  });
});

describe("addPost — reply pings", () => {
  test("replying to an agent's exchange tags that agent implicitly", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "" });
    const root = store.addPost({ threadId: thread.id, author: "fable-5", body: "plan ready" });

    store.addPost({ threadId: thread.id, author: "user", body: "looks wrong, redo section 2", replyTo: root.id });

    const tags = store.getState().events.filter(
      (e) => e.threadId === thread.id && e.type === "tagged" && e.payload.handle === "fable-5",
    );
    expect(tags).toHaveLength(1);
    expect(tags[0].actor).toBe("user");
  });

  test("no implicit tag for self-replies, human roots, or already-mentioned authors", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "" });

    const humanRoot = store.addPost({ threadId: thread.id, author: "user", body: "my note" });
    store.addPost({ threadId: thread.id, author: "user", body: "self follow-up", replyTo: humanRoot.id });

    const agentRoot = store.addPost({ threadId: thread.id, author: "gpt-5.6", body: "done" });
    store.addPost({ threadId: thread.id, author: "gpt-5.6", body: "addendum", replyTo: agentRoot.id });
    store.addPost({ threadId: thread.id, author: "user", body: "@gpt-5.6 thanks, ship it", replyTo: agentRoot.id });

    const tags = store.getState().events.filter(
      (e) => e.threadId === thread.id && e.type === "tagged",
    );
    // Exactly one: the explicit @gpt-5.6 (implicit reply-ping deduped against it).
    expect(tags).toHaveLength(1);
    expect(tags[0].payload.handle).toBe("gpt-5.6");
  });
});

describe("createProject", () => {
  test("derives a key from the name and de-dupes against existing keys", () => {
    const store = emptyStore();
    const a = store.createProject({ name: "Elan Orchestrator", repoPath: "/x" });
    expect(a.key).toBe("EO");
    const b = store.createProject({ name: "engram", repoPath: "/y" });
    expect(b.key).toBe("ENG");
    const c = store.createProject({ name: "Engram Redux Extra", repoPath: "/z", key: "eng" });
    expect(c.key).toBe("ENG2"); // explicit keys are de-duped too
  });

  test("assigns rotating colors and returns a usable project", () => {
    const store = emptyStore();
    const p = store.createProject({ name: "Solo", repoPath: "/s" });
    expect(p.color).toMatch(/^oklch\(/);
    const thread = store.createThread({ projectId: p.id, title: "first", body: "" });
    expect(thread.number).toBe(1);
    expect(store.getState().projects).toHaveLength(1);
  });
});

describe("setRoster", () => {
  test("replaces the roster, dropping invalid and duplicate handles", () => {
    const store = emptyStore();
    store.setRoster([
      { handle: "fable-5", harness: "claude-code", color: "#111" },
      { handle: "fable-5", harness: "codex", color: "#222" }, // dup → dropped
      { handle: "user", harness: "mock", color: "#333" },     // reserved → dropped
      { handle: "  ", harness: "mock", color: "#444" },       // empty → dropped
      { handle: "opus-next", harness: "claude-code", model: "opus-next", color: "#555" },
    ]);
    expect(store.getState().roster.map((r) => r.handle)).toEqual(["fable-5", "opus-next"]);
    expect(store.getState().roster[1].model).toBe("opus-next");
  });
});

describe("deleteProject cascade", () => {
  test("cascades and can empty the board back to first-run", () => {
    const store = emptyStore();
    const p = store.createProject({ name: "Only", repoPath: "/o" });
    const t = store.createThread({ projectId: p.id, title: "t", body: "" });
    store.addPost({ threadId: t.id, author: "user", body: "hi" });

    store.deleteProject(p.id);

    const state = store.getState();
    expect(state.projects).toHaveLength(0);
    expect(state.threads).toHaveLength(0);
    expect(state.posts).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});

describe("normalizeState — hostile input", () => {
  // The host loads its state file (and the test-gated PUT /api/state body)
  // through normalizeState: external, possibly-stale input must degrade to a
  // dropped/defaulted record, never a crash downstream.
  test("normalizes stale-shaped records instead of crashing", () => {
    // `status` is a status-era leftover — normalization must shrug it off.
    const t = { id: "t1", projectId: "p1", number: 1, title: "stale", body: "b",
      status: "in_progress", labels: ["x"], createdBy: "user", createdAt: 1, updatedAt: 2 };
    const parsed = {
      projects: [{ id: "p1", key: "ENG", name: "Engram", repoPath: "/x", color: "#fff", createdAt: 1 }],
      roster: [{ handle: "gpt-5.6", harness: "codex", color: "#0f9d8f" }, { broken: true }],
      threads: [t, { id: "half-a-thread" }],
      posts: [
        { id: "po1", threadId: "t1", author: "gpt-5.6", body: "no attachments field", createdAt: 3 },
        { id: "po2", threadId: "gone-thread", author: "user", body: "orphan", createdAt: 4, attachments: [] },
        { id: "truncated" },
      ],
      events: [
        { id: "ev1", threadId: "t1", actor: "user", type: "priority", payload: { from: "none", to: "high" }, at: 5 },
        { id: "ev2", threadId: "t1", actor: "user", type: "created", at: 6 },
      ],
      sessions: [{ id: "s1", threadId: "t1", handle: "gpt-5.6", state: "running", startedAt: 7 }],
    } as unknown as Partial<BoardState>;

    let state: BoardState | undefined;
    expect(() => {
      state = normalizeState(parsed);
    }).not.toThrow();

    // Valid records survive; malformed ones drop; missing fields default.
    expect(state!.threads.map((x) => x.id)).toEqual(["t1"]);
    expect(state!.roster).toHaveLength(1);
    expect(state!.posts).toHaveLength(1);
    expect(state!.posts[0].attachments).toEqual([]); // the crash vector
    expect(state!.posts[0].kind).toBe("comment");
    expect(state!.events.map((e) => e.id)).toEqual(["ev1", "ev2"]); // stale type kept, payload defaulted
    expect(state!.events[1].payload).toEqual({});
    expect(state!.sessions).toHaveLength(1);
  });
});
