// relativeTime band coverage — every branch gets `now` passed explicitly so
// the test is deterministic regardless of when it runs.

import { describe, expect, test } from "bun:test";
import { relativeTime } from "@/lib/relative-time";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0); // Jul 10, 2026, 12:00:00 UTC

  test("under 60s -> now", () => {
    expect(relativeTime(now - 0, now)).toBe("now");
    expect(relativeTime(now - 30 * SECOND, now)).toBe("now");
    expect(relativeTime(now - 59 * SECOND, now)).toBe("now");
  });

  test("under 60m -> Nm", () => {
    expect(relativeTime(now - 60 * SECOND, now)).toBe("1m");
    expect(relativeTime(now - 5 * MINUTE, now)).toBe("5m");
    expect(relativeTime(now - 59 * MINUTE, now)).toBe("59m");
  });

  test("under 24h -> Nh", () => {
    expect(relativeTime(now - 60 * MINUTE, now)).toBe("1h");
    expect(relativeTime(now - 5 * HOUR, now)).toBe("5h");
    expect(relativeTime(now - 23 * HOUR, now)).toBe("23h");
  });

  test("under 7d -> Nd", () => {
    expect(relativeTime(now - 24 * HOUR, now)).toBe("1d");
    expect(relativeTime(now - 3 * DAY, now)).toBe("3d");
    expect(relativeTime(now - 6 * DAY, now)).toBe("6d");
  });

  test("7d or more, same year -> short date", () => {
    expect(relativeTime(now - 7 * DAY, now)).toBe("Jul 3");
    expect(relativeTime(Date.UTC(2026, 0, 1), now)).toBe("Jan 1");
  });

  test("different year -> short date with year", () => {
    expect(relativeTime(Date.UTC(2025, 6, 9), now)).toBe("Jul 9, 2025");
  });
});
