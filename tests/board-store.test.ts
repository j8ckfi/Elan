// Board store contract — the rules docs/DATA-MODEL.md says the store (not
// callers) enforces: status events, reply flattening, mention tagging,
// updatedAt bumps, and localStorage hydrate-or-seed persistence.

import { beforeEach, describe, expect, test } from "bun:test";
import { createBoardStore, createLocalStore } from "@/lib/board/store";
import { seedState } from "@/lib/board/seed";
import { toExchanges } from "@/lib/board/types";

// bun:test runs outside a DOM — createLocalStore talks to the bare global
// `localStorage`, so stub a minimal in-memory one before any test runs.
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

const memoryStorage = new MemoryStorage();
globalThis.localStorage = memoryStorage as unknown as Storage;

// Every test starts from a clean slate. createLocalStore() now boots EMPTY
// (first-run Welcome); tests that need board data load the demo explicitly.
beforeEach(() => {
  memoryStorage.clear();
});

// The demo was removed from the product; seedState survives as a rich test
// fixture, loaded directly through the rules module.
function seededStore() {
  return createBoardStore({ initial: seedState(), persist: () => {} });
}

describe("updateThread", () => {
  test("a status change emits the status event itself", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    store.updateThread(thread.id, { status: "in_progress" }, "user");

    const events = store
      .getState()
      .events.filter((e) => e.threadId === thread.id && e.type === "status");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "user",
      payload: { from: "todo", to: "in_progress" },
    });
    expect(store.getState().threads.find((t) => t.id === thread.id)?.status).toBe(
      "in_progress",
    );
  });

  test("a no-op patch (same status) emits nothing", () => {
    const store = seededStore();
    const project = store.getState().projects[0];
    const thread = store.createThread({ projectId: project.id, title: "t", body: "b" });

    store.updateThread(thread.id, { status: "todo" }, "user");

    expect(
      store.getState().events.filter((e) => e.threadId === thread.id && e.type === "status"),
    ).toHaveLength(0);
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
    expect(thread.status).toBe("in_progress");

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

describe("createProject", () => {
  test("derives a key from the name and de-dupes against existing keys", () => {
    const store = createLocalStore();
    const a = store.createProject({ name: "Elan Orchestrator", repoPath: "/x" });
    expect(a.key).toBe("EO");
    const b = store.createProject({ name: "engram", repoPath: "/y" });
    expect(b.key).toBe("ENG");
    const c = store.createProject({ name: "Engram Redux Extra", repoPath: "/z", key: "eng" });
    expect(c.key).toBe("ENG2"); // explicit keys are de-duped too
  });

  test("assigns rotating colors and returns a usable project", () => {
    const store = createLocalStore();
    const p = store.createProject({ name: "Solo", repoPath: "/s" });
    expect(p.color).toMatch(/^#/);
    const thread = store.createThread({ projectId: p.id, title: "first", body: "" });
    expect(thread.number).toBe(1);
    expect(store.getState().projects).toHaveLength(1);
  });
});

describe("setRoster", () => {
  test("replaces the roster, dropping invalid and duplicate handles", () => {
    const store = createLocalStore();
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

describe("localStorage persistence", () => {
  test("round-trips mutations through localStorage (debounced) on the next hydrate", async () => {
    const store = createLocalStore();
    const project = store.createProject({ name: "Persist", repoPath: "/p" });
    const thread = store.createThread({ projectId: project.id, title: "persisted", body: "b" });

    await new Promise((r) => setTimeout(r, 250)); // let the debounce flush

    const raw = localStorage.getItem("elan.board.v3");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { threads: Array<{ id: string }> };
    expect(parsed.threads.some((t) => t.id === thread.id)).toBe(true);

    const rehydrated = createLocalStore();
    expect(rehydrated.getState().threads.some((t) => t.id === thread.id)).toBe(true);
  });

  test("falls back to emptyState on corrupt JSON without throwing", () => {
    localStorage.setItem("elan.board.v3", "{not valid json at all");

    let store: ReturnType<typeof createLocalStore> | undefined;
    expect(() => {
      store = createLocalStore();
    }).not.toThrow();

    // Empty, not demo: a corrupt board must not resurrect as fiction.
    expect(store!.getState().projects).toHaveLength(0);
    expect(store!.getState().threads).toHaveLength(0);
    expect(store!.getState().roster.length).toBeGreaterThan(0); // default roster
  });

  test("boots empty (first run) when the key is absent", () => {
    const store = createLocalStore();
    expect(store.getState().projects).toHaveLength(0);
    expect(store.getState().threads).toHaveLength(0);
    expect(store.getState().roster.map((r) => r.handle)).toContain("fable-5");
  });

  test("deleteProject cascades and can empty the board back to first-run", () => {
    const store = createLocalStore();
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

  // Regression: a mid-refactor dev build once persisted posts without
  // `attachments` and event types this build no longer knows — hydration
  // must normalize (drop/default), never crash the render downstream.
  test("normalizes stale-shaped records on hydrate instead of crashing", () => {
    const t = { id: "t1", projectId: "p1", number: 1, title: "stale", body: "b",
      status: "in_progress", labels: ["x"], createdBy: "user", createdAt: 1, updatedAt: 2 };
    localStorage.setItem(
      "elan.board.v3",
      JSON.stringify({
        projects: [{ id: "p1", key: "ENG", name: "Engram", repoPath: "/x", color: "#fff", createdAt: 1 }],
        roster: [{ handle: "gpt-5.6", harness: "codex", color: "#0f9d8f" }, { broken: true }],
        threads: [t, { id: "half-a-thread" }, { ...t, id: "t2", status: "priority-era" }],
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
      }),
    );

    let store: ReturnType<typeof createLocalStore> | undefined;
    expect(() => {
      store = createLocalStore();
    }).not.toThrow();
    const state = store!.getState();

    // Valid records survive; malformed ones drop; missing fields default.
    expect(state.threads.map((x) => x.id)).toEqual(["t1"]);
    expect(state.roster).toHaveLength(1);
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].attachments).toEqual([]); // the crash vector
    expect(state.posts[0].kind).toBe("comment");
    expect(state.events.map((e) => e.id)).toEqual(["ev1", "ev2"]); // stale type kept, payload defaulted
    expect(state.events[1].payload).toEqual({});
    expect(state.sessions).toHaveLength(1);
  });
});
