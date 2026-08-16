import { beforeEach, describe, expect, it } from "vitest";
import type { HermesUIMessage } from "@hermes/protocol";
import {
  createEmptyChatRuntime,
  type ChatRuntimeBySession,
  type ChatSessionRuntime,
} from "@/stores/chat";
import { __resetUiStoreForTests, writeUiValue } from "@/lib/ui-store";
import { rememberSessionMapping } from "@/lib/session-map";
import {
  resolveGatewaySessionTarget,
  resolveSessionRuntime,
} from "./use-session-resolution";

const MAP_KEY = "hermes:gateway-session-map";

function userMessage(sessionId: string, text: string): HermesUIMessage {
  return {
    id: `u-${text}`,
    sessionId,
    role: "user",
    createdAt: 1,
    status: "complete",
    parts: [{ type: "text", text }],
  };
}

function runtimeWith(sessionId: string, text: string): ChatSessionRuntime {
  return { ...createEmptyChatRuntime(1), messages: [userMessage(sessionId, text)] };
}

function firstText(runtime: ChatSessionRuntime): string | undefined {
  const part = runtime.messages[0]?.parts[0];
  return part && part.type === "text" ? part.text : undefined;
}

describe("resolveSessionRuntime", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("reads the live runtime when the persisted map still holds a stale duplicate", () => {
    // Regression for the invisible-reply bug: a resumed session accumulated two
    // gateway ids for one persistent id (e.g. a map persisted across an app
    // relaunch). The route id is the persistent id; the optimistic send wrote
    // into the *live* gateway bucket. Resolution must land on that bucket, not
    // the empty runtimeBySession[persistentId] fallback.
    const persistentId = "20260815_123456_abcd";
    writeUiValue(MAP_KEY, {
      "gw-stale": { persistentId, ts: Date.now() - 60_000 },
      "gw-live": { persistentId, ts: Date.now() - 1_000 },
    });
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-live": runtimeWith("gw-live", "just sent"),
    };

    const resolved = resolveSessionRuntime(persistentId, "gw-live", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-live");
    expect(firstText(resolved.runtime)).toBe("just sent");
    expect(resolved.isLiveSession).toBe(true);
    expect(resolved.restSessionId).toBe(persistentId);
  });

  it("does not bleed a different background-streaming session into the current view", () => {
    // Session B is the live gateway session (streaming in the background) while
    // the route is showing session A. Preferring the live gwSessionId must be
    // gated on it mapping to the *same* persistent session, or detail would
    // render B's transcript under A.
    rememberSessionMapping("gw-A", "persistent-A");
    rememberSessionMapping("gw-B", "persistent-B");
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-A": runtimeWith("gw-A", "from A"),
      "gw-B": runtimeWith("gw-B", "from B"),
    };

    const resolved = resolveSessionRuntime("persistent-A", "gw-B", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-A");
    expect(firstText(resolved.runtime)).toBe("from A");
  });

  it("resolves a fresh new-task session keyed directly by its gateway id", () => {
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-new": runtimeWith("gw-new", "hi"),
    };

    const resolved = resolveSessionRuntime("gw-new", "gw-new", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-new");
    expect(firstText(resolved.runtime)).toBe("hi");
    expect(resolved.isGatewayLinked).toBe(true);
    expect(resolved.isLiveSession).toBe(true);
  });

  it("falls back to an empty idle runtime for an unknown session", () => {
    const resolved = resolveSessionRuntime("unknown", null, {});

    expect(resolved.runtime.messages).toHaveLength(0);
    expect(resolved.runtimeIsBusy).toBe(false);
    expect(resolved.isLiveSession).toBe(false);
  });

  it("does not offer a stale pre-reconnect gateway id as a send target", () => {
    // Regression for `session not found` after background disconnect+reconnect:
    // the session-map still holds a gateway id minted before the reconnect
    // (dae122d5); the server has reaped it. activeMappedGatewaySessionId must
    // only ever surface the LIVE gateway id, so the send path resumes the
    // persistent id instead of submitting to the dead gateway.
    rememberSessionMapping("gw-stale", "20260815_123456_abcd");
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-stale": runtimeWith("gw-stale", "old"),
    };

    const resolved = resolveSessionRuntime("20260815_123456_abcd", "gw-live-new", runtimeBySession);
    // gw-live-new belongs to a DIFFERENT persistent session, so it is not live
    // for this task; the stale gw-stale must not be resurrected as a target.
    expect(resolved.activeMappedGatewaySessionId).toBeUndefined();
    expect(resolved.isGatewayLinked).toBe(false);
  });

  it("uses the live gateway id for the same persistent task as the send target", () => {
    const persistentId = "20260815_123456_abcd";
    rememberSessionMapping("gw-live", persistentId);
    rememberSessionMapping("gw-stale", persistentId);
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-live": runtimeWith("gw-live", "live"),
    };

    const resolved = resolveSessionRuntime(persistentId, "gw-live", runtimeBySession);

    expect(resolved.activeMappedGatewaySessionId).toBe("gw-live");
    expect(resolved.runtimeSessionId).toBe("gw-live");
    expect(firstText(resolved.runtime)).toBe("live");
  });
});

describe("resolveGatewaySessionTarget", () => {
  it("resumes the persistent session when the route still has a stale gateway id", () => {
    expect(
      resolveGatewaySessionTarget({
        taskId: "gw-old",
        restSessionId: "sess-1",
        activeMappedGatewaySessionId: undefined,
      }),
    ).toEqual({
      gatewaySessionId: "sess-1",
      resumePersistentSessionId: "sess-1",
    });
  });

  it("uses the live mapped gateway id without resuming", () => {
    expect(
      resolveGatewaySessionTarget({
        taskId: "sess-1",
        restSessionId: "sess-1",
        activeMappedGatewaySessionId: "gw-live",
      }),
    ).toEqual({ gatewaySessionId: "gw-live" });
  });

  it("uses taskId when no persistent mapping is available", () => {
    expect(
      resolveGatewaySessionTarget({
        taskId: "gw-new",
        restSessionId: undefined,
        activeMappedGatewaySessionId: undefined,
      }),
    ).toEqual({ gatewaySessionId: "gw-new" });
  });
});
