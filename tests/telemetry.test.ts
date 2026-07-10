// Session telemetry fold — per-harness translators over the real captures in
// tests/fixtures/harness/ (live CLI output from 2026-07-10; cursor/grok-run/
// claude-tool-run are hand-crafted from the same wire profiles where no
// capture with that shape existed). The contract under test, per
// docs/FRONTEND.md "Session telemetry":
//   - each stream family folds into the right prose/work ChatItem shapes,
//   - the run ALWAYS ends (even when the terminal event never arrived),
//   - malformed lines never throw,
//   - the incremental fold equals the replay-once fold on the same lines.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFold,
  foldSessionLines,
  parseSessionLog,
  type SessionLine,
} from "@/lib/board/telemetry";
import type {
  AssistantItem,
  ChatItem,
  NoticeItem,
  Step,
} from "@/lib/agent/types";

const FIXTURES = join(import.meta.dir, "fixtures", "harness");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

function outLines(text: string): SessionLine[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ stream: "out" as const, line }));
}
const foldFixture = (harness: string, name: string) =>
  foldSessionLines(harness, outLines(fixture(name)));

// ── shape helpers ──────────────────────────────────────────────────────────
const assistants = (items: ChatItem[]) =>
  items.filter((i): i is AssistantItem => i.type === "assistant");
const notices = (items: ChatItem[]) =>
  items.filter((i): i is NoticeItem => i.type === "notice");
const steps = (items: ChatItem[]): Step[] =>
  assistants(items).flatMap((a) =>
    a.parts.flatMap((p) => (p.kind === "work" ? p.steps : [])),
  );
const toolSteps = (items: ChatItem[]) =>
  steps(items).filter((s) => s.kind === "tool");
const thinkingText = (items: ChatItem[]) =>
  steps(items)
    .filter((s) => s.kind === "thinking")
    .map((s) => s.output ?? "")
    .join("\n");
const proseText = (items: ChatItem[]) =>
  assistants(items)
    .flatMap((a) => a.parts)
    .filter((p) => p.kind === "prose")
    .map((p) => p.text)
    .join("\n");

/** Mari invariant 1: every run settled, every step closed, no streaming. */
function expectRunEnded(items: ChatItem[]) {
  for (const a of assistants(items)) {
    expect(a.streaming).toBe(false);
    for (const p of a.parts)
      if (p.kind === "prose") expect(p.streaming).toBe(false);
  }
  for (const s of steps(items)) expect(s.status).not.toBe("active");
}

/** Reducer timestamps are Date.now()-based — strip them for fold equality. */
const VOLATILE = new Set(["startedAt", "endedAt", "createdAt"]);
function stripTimes(items: ChatItem[]): unknown {
  return JSON.parse(
    JSON.stringify(items, (key, value) =>
      VOLATILE.has(key) ? undefined : value,
    ),
  );
}

// ── claude-stream (claude-code) ────────────────────────────────────────────

describe("claude-stream", () => {
  test("a not-logged-in run folds to errored prose and still ends", () => {
    const { items, raw } = foldFixture("claude-code", "claude-not-logged-in.jsonl");
    expect(raw).toBe(false);
    const runs = assistants(items);
    expect(runs).toHaveLength(1);
    expect(proseText(items)).toContain("Not logged in");
    expect(runs[0].error).toContain("Not logged in");
    expectRunEnded(items);
  });

  test("a tool run folds thinking + step + trailing prose in order", () => {
    const { items } = foldFixture("claude-code", "claude-tool-run.jsonl");
    const [run] = assistants(items);
    expect(run).toBeDefined();
    // Ordered parts: the work chunk (thinking + tool) precedes the answer.
    expect(run.parts[0]?.kind).toBe("work");
    expect(run.parts[run.parts.length - 1]?.kind).toBe("prose");
    expect(thinkingText(items)).toContain("Let me run the probe.");
    const [tool] = toolSteps(items);
    expect(tool.label).toBe("Ran echo elan-ok");
    expect(tool.output).toBe("elan-ok\n");
    expect(tool.status).toBe("complete");
    expect(proseText(items)).toBe("Done — the probe printed elan-ok.");
    expectRunEnded(items);
  });

  test("cursor's standalone thinking deltas accumulate then settle", () => {
    const { items, raw } = foldFixture("cursor", "cursor-ping.jsonl");
    expect(raw).toBe(false);
    expect(thinkingText(items)).toBe(
      "The response will be exactly the word PONG.",
    );
    expect(proseText(items)).toBe("PONG");
    expectRunEnded(items);
  });
});

// ── pi-stream ──────────────────────────────────────────────────────────────

describe("pi-stream", () => {
  test("a tool run folds steps with results and prose", () => {
    const { items, raw } = foldFixture("pi", "pi-tool.jsonl");
    expect(raw).toBe(false);
    const [tool] = toolSteps(items);
    expect(tool.label).toBe("Ran echo elan-probe-ok");
    expect(tool.output).toBe("elan-probe-ok\n");
    expect(proseText(items).length).toBeGreaterThan(0);
    expectRunEnded(items);
  });

  test("a runtime error surfaces as the run's error", () => {
    const { items } = foldFixture("pi", "pi-runtime-err.jsonl");
    expect(assistants(items).some((a) => a.error === "Connection error.")).toBe(
      true,
    );
    expectRunEnded(items);
  });
});

// ── codex-events ───────────────────────────────────────────────────────────

describe("codex-events", () => {
  test("agent_message → prose, advisory errors → notices", () => {
    const { items, raw } = foldFixture("codex", "codex-advisory-ok.ndjson");
    expect(raw).toBe(false);
    expect(proseText(items)).toBe("pong");
    // Two advisory item errors in the capture (deprecation + skills budget).
    expect(notices(items)).toHaveLength(2);
    expectRunEnded(items);
  });

  test("turn.failed carries the authoritative failure", () => {
    const { items } = foldFixture("codex", "codex-advisory-failed.ndjson");
    expect(
      assistants(items).some((a) =>
        a.error?.includes("requires a newer version of Codex"),
      ),
    ).toBe(true);
    expectRunEnded(items);
  });

  test("the run ends even when turn.completed never arrives", () => {
    const lines = outLines(fixture("codex-advisory-ok.ndjson"));
    const truncated = lines.filter((l) => !l.line.includes("turn.completed"));
    const { items } = foldSessionLines("codex", truncated);
    expect(proseText(items)).toBe("pong");
    expectRunEnded(items);
  });
});

// ── opencode-events ────────────────────────────────────────────────────────

describe("opencode-events", () => {
  test("tool_use parts become settled steps; text parts become prose", () => {
    const { items, raw } = foldFixture("opencode", "opencode-tool.jsonl");
    expect(raw).toBe(false);
    // Two step_start/step_finish pairs → two runs (tool turn, answer turn).
    expect(assistants(items)).toHaveLength(2);
    const [tool] = toolSteps(items);
    expect(tool.label).toBe("Ran echo elan-probe-ok");
    expect(tool.output).toBe("elan-probe-ok\n");
    expect(proseText(items)).toBe("elan-probe-ok");
    expectRunEnded(items);
  });

  test("a server error surfaces as the run's error", () => {
    const { items } = foldFixture("opencode", "opencode-error.jsonl");
    expect(
      assistants(items).some((a) =>
        a.error?.includes("Unexpected server error"),
      ),
    ).toBe(true);
    expectRunEnded(items);
  });
});

// ── pool-events ────────────────────────────────────────────────────────────

describe("pool-events", () => {
  test("reasoning → thinking, toolCall/result → step, thought → text", () => {
    const { items, raw } = foldFixture("pool", "pool-ping.ndjson");
    expect(raw).toBe(false);
    expect(thinkingText(items)).toContain(
      "The user wants me to run a shell command",
    );
    const tools = toolSteps(items);
    // The shell call only — `exit` is the run's end, not a step (and its
    // empty toolCallResult must not close anything).
    expect(tools).toHaveLength(1);
    expect(tools[0].label).toBe("Ran echo elan-ok");
    expect(tools[0].output).toContain("elan-ok");
    expect(proseText(items)).toContain("pong");
    expectRunEnded(items);
  });

  test("a minimal thought→exit run is just prose", () => {
    const { items } = foldFixture("pool", "pool-xs.ndjson");
    expect(proseText(items)).toBe("pong");
    expect(toolSteps(items)).toHaveLength(0);
    expectRunEnded(items);
  });
});

// ── grok-stream ────────────────────────────────────────────────────────────

describe("grok-stream", () => {
  test("thought/text data chunks accumulate; end settles the run", () => {
    const { items, raw } = foldFixture("grok", "grok-run.jsonl");
    expect(raw).toBe(false);
    expect(thinkingText(items)).toBe("Considering the request.");
    expect(proseText(items)).toBe("pong");
    expectRunEnded(items);
  });

  test("an API error surfaces as the run's error", () => {
    const { items } = foldFixture("grok", "grok-403.ndjson");
    expect(assistants(items).some((a) => a.error?.includes("403"))).toBe(true);
    expectRunEnded(items);
  });
});

// ── raw fallback ───────────────────────────────────────────────────────────

describe("raw fallback", () => {
  test.each(["devin", "mock", "some-future-harness"])(
    "%s folds to raw with no items",
    (harness) => {
      const { items, raw } = foldSessionLines(harness, [
        { stream: "out", line: '{"anything": true}' },
        { stream: "err", line: "stderr noise" },
      ]);
      expect(raw).toBe(true);
      expect(items).toHaveLength(0);
    },
  );
});

// ── durability ─────────────────────────────────────────────────────────────

const ALL_STREAM_HARNESSES = [
  "claude-code",
  "cursor",
  "pi",
  "codex",
  "opencode",
  "pool",
  "grok",
];

describe("durability", () => {
  test("malformed lines never throw and never derail the fold", () => {
    const garbage: SessionLine[] = [
      { stream: "out", line: "not json at all" },
      { stream: "out", line: '{"type":' },
      { stream: "out", line: "{}" },
      { stream: "out", line: "[]" },
      { stream: "out", line: '{"type":123}' },
      { stream: "out", line: '"just a string"' },
      { stream: "out", line: '{"type":"message_update"}' },
      { stream: "out", line: '{"type":"item.completed","item":42}' },
      { stream: "err", line: "Error: some stack trace" },
    ];
    for (const harness of ALL_STREAM_HARNESSES) {
      expect(() => foldSessionLines(harness, garbage)).not.toThrow();
    }
    // Garbage interleaved with a real capture still folds the real events.
    const lines = outLines(fixture("codex-advisory-ok.ndjson"));
    const mixed = lines.flatMap((l, i) => [l, garbage[i % garbage.length]]);
    const { items } = foldSessionLines("codex", mixed);
    expect(proseText(items)).toBe("pong");
    expectRunEnded(items);
  });

  test("stderr lines never feed a translator", () => {
    // The same JSON on the err channel must fold to nothing.
    const errOnly = outLines(fixture("pool-xs.ndjson")).map((l) => ({
      ...l,
      stream: "err" as const,
    }));
    const { items } = foldSessionLines("pool", errOnly);
    expect(items).toHaveLength(0);
  });

  const INCREMENTAL_CASES: Array<[string, string]> = [
    ["claude-code", "claude-tool-run.jsonl"],
    ["cursor", "cursor-ping.jsonl"],
    ["pi", "pi-tool.jsonl"],
    ["codex", "codex-advisory-failed.ndjson"],
    ["opencode", "opencode-tool.jsonl"],
    ["pool", "pool-ping.ndjson"],
    ["grok", "grok-run.jsonl"],
  ];

  test.each(INCREMENTAL_CASES)(
    "incremental fold === batch fold (%s)",
    (harness, name) => {
      const lines = outLines(fixture(name));
      const fold = createFold(harness);
      for (const l of lines) {
        fold.push(l);
        fold.snapshot(); // mid-stream snapshots must not perturb the fold
      }
      fold.finish();
      const incremental = fold.snapshot();
      const batch = foldSessionLines(harness, lines);
      expect(incremental.raw).toBe(batch.raw);
      expect(stripTimes(incremental.items)).toEqual(stripTimes(batch.items));
    },
  );

  test("finish() is idempotent", () => {
    const fold = createFold("grok");
    fold.push({ stream: "out", line: '{"type":"text","data":"hi"}' });
    fold.finish();
    fold.finish();
    const { items } = fold.snapshot();
    expect(proseText(items)).toBe("hi");
    expectRunEnded(items);
  });
});

// ── the on-disk log format ─────────────────────────────────────────────────

describe("parseSessionLog", () => {
  test("strips the timestamp+channel prefix and keeps channels", () => {
    const text = [
      "2026-07-10T18:35:56.939Z [out] {\"type\":\"agent_start\"}",
      "2026-07-10T18:35:57.001Z [err] Warning: something",
      "2026-07-10T18:35:57.100Z [out] {\"type\":\"agent_end\"}",
    ].join("\n");
    expect(parseSessionLog(text)).toEqual([
      { stream: "out", line: '{"type":"agent_start"}' },
      { stream: "err", line: "Warning: something" },
      { stream: "out", line: '{"type":"agent_end"}' },
    ]);
  });

  test("unstamped continuations attach to the previous entry; preamble drops", () => {
    const text = [
      "junk before the first stamped line",
      "2026-07-10T18:35:57.001Z [err] Error: boom",
      "    at somewhere (file.ts:1:1)",
      "2026-07-10T18:35:57.100Z [out] {}",
      "",
    ].join("\n");
    expect(parseSessionLog(text)).toEqual([
      { stream: "err", line: "Error: boom\n    at somewhere (file.ts:1:1)" },
      { stream: "out", line: "{}" },
    ]);
  });

  test("a parsed log replays through the fold", () => {
    const text = outLines(fixture("pool-xs.ndjson"))
      .map((l, i) => `2026-07-10T18:35:5${i}.000Z [out] ${l.line}`)
      .join("\n");
    const { items } = foldSessionLines("pool", parseSessionLog(text));
    expect(proseText(items)).toBe("pong");
  });
});
