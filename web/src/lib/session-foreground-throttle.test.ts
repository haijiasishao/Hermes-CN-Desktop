import { describe, expect, it } from "vitest";
import { shouldThrottleSessionForegroundUpdate } from "./android-session-foreground";

describe("shouldThrottleSessionForegroundUpdate", () => {
  const base = {
    persistentSessionId: "20260815_132521_7e627c",
    state: "thinking",
    timestampMs: 10_000,
  };

  it("passes through a state change even inside the throttle window", () => {
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        state: "working",
        last: { state: "thinking", tsMs: 9_500 },
      }),
    ).toBe(false);
  });

  it("throttles a same-state repeat within the 1s window", () => {
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        last: { state: "thinking", tsMs: 9_500 },
      }),
    ).toBe(true);
  });

  it("passes through a same-state update after the window elapses", () => {
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        last: { state: "thinking", tsMs: 8_900 },
      }),
    ).toBe(false);
  });

  it("never throttles terminal states", () => {
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        state: "completed",
        last: { state: "completed", tsMs: 9_999 },
      }),
    ).toBe(false);
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        state: "failed",
        last: { state: "failed", tsMs: 9_999 },
      }),
    ).toBe(false);
  });

  it("passes through when no previous state was recorded", () => {
    expect(shouldThrottleSessionForegroundUpdate(base)).toBe(false);
  });

  it("ignores a missing session id", () => {
    expect(
      shouldThrottleSessionForegroundUpdate({
        ...base,
        persistentSessionId: undefined,
        last: { state: "thinking", tsMs: 9_500 },
      }),
    ).toBe(false);
  });
});
