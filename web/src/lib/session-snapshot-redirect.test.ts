import { describe, expect, it } from "vitest";
import {
  pickTipRedirect,
  recordCompletedSnapshotRouteRedirect,
} from "./session-tip-redirect";

describe("recordCompletedSnapshotRouteRedirect", () => {
  it("records the gateway id to persistent id redirect for a completed snapshot", () => {
    const redirects = recordCompletedSnapshotRouteRedirect({}, {
      snapshotCompleted: true,
      gatewaySessionId: "266669f7",
      persistentSessionId: "20260814_184759_000bc7",
    });

    expect(redirects).toEqual({ "266669f7": "20260814_184759_000bc7" });
    expect(
      pickTipRedirect(redirects, {
        taskId: "266669f7",
        restSessionId: "266669f7",
        activeSessionId: "266669f7",
      }),
    ).toBe("20260814_184759_000bc7");
  });

  it.each([
    {
      name: "an incomplete snapshot",
      snapshotCompleted: false,
      gatewaySessionId: "gw-old",
      persistentSessionId: "sess-1",
    },
    {
      name: "a missing gateway id",
      snapshotCompleted: true,
      gatewaySessionId: undefined,
      persistentSessionId: "sess-1",
    },
    {
      name: "a missing persistent id",
      snapshotCompleted: true,
      gatewaySessionId: "gw-old",
      persistentSessionId: undefined,
    },
    {
      name: "an identity mapping",
      snapshotCompleted: true,
      gatewaySessionId: "same-id",
      persistentSessionId: "same-id",
    },
  ])("does not record a redirect for $name", ({ snapshotCompleted, gatewaySessionId, persistentSessionId }) => {
    const previous = { existing: "redirect" };

    expect(
      recordCompletedSnapshotRouteRedirect(previous, {
        snapshotCompleted,
        gatewaySessionId,
        persistentSessionId,
      }),
    ).toBe(previous);
  });
});
