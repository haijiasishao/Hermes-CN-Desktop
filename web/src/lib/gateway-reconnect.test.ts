import { describe, it, expect, vi } from "vitest";
import {
  isDefinitiveMissingSessionError,
  reattachAfterReconnect,
  type ReattachAfterReconnectDeps,
  type ReconnectResumeResult,
} from "./gateway-reconnect";

function makeDeps(overrides: Partial<ReattachAfterReconnectDeps> = {}): {
  deps: ReattachAfterReconnectDeps;
  resume: ReturnType<typeof vi.fn>;
  onResumed: ReturnType<typeof vi.fn>;
  onResumeFailed: ReturnType<typeof vi.fn>;
} {
  const resume = vi.fn(async (persistentId: string) => ({ session_id: `gw-${persistentId}` }));
  const onResumed = vi.fn();
  const onResumeFailed = vi.fn();
  const deps: ReattachAfterReconnectDeps = {
    getActiveSessionId: () => "gw-old",
    resolvePersistentId: (id) => (id === "gw-old" ? "sess-1" : id),
    resume,
    onResumed,
    onResumeFailed,
    ...overrides,
  };
  return { deps, resume, onResumed, onResumeFailed };
}

describe("reattachAfterReconnect", () => {
  it("no-ops when there is no active session", async () => {
    const { deps, resume, onResumed, onResumeFailed } = makeDeps({
      getActiveSessionId: () => null,
    });
    await reattachAfterReconnect(deps);
    expect(resume).not.toHaveBeenCalled();
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).not.toHaveBeenCalled();
  });

  it("resumes the resolved persistent id and reports the new gateway id", async () => {
    const diagnostics: string[] = [];
    const { deps, resume, onResumed, onResumeFailed } = makeDeps({
      onDiagnostic: (event) => diagnostics.push(event.stage),
    });
    await reattachAfterReconnect(deps);
    expect(resume).toHaveBeenCalledWith("sess-1");
    expect(onResumed).toHaveBeenCalledWith("gw-sess-1", "sess-1", "gw-old");
    expect(onResumeFailed).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      "reattach.started",
      "reattach.active_session",
      "reattach.resume_requested",
      "reattach.resumed",
    ]);
  });

  it("prefers the server-reported resumed persistent id when present", async () => {
    const { deps, onResumed } = makeDeps({
      resume: vi.fn(async () => ({ session_id: "gw-new", resumed: "sess-canonical" })),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).toHaveBeenCalledWith("gw-new", "sess-canonical", "gw-old");
  });

  it("escalates to onResumeFailed when resume rejects (session gone)", async () => {
    const diagnostics: string[] = [];
    const { deps, onResumed, onResumeFailed } = makeDeps({
      onDiagnostic: (event) => diagnostics.push(event.stage),
      resume: vi.fn(async () => {
        throw new Error("Session not found");
      }),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      "reattach.started",
      "reattach.active_session",
      "reattach.resume_requested",
      "reattach.failed",
    ]);
  });

  it("escalates to onResumeFailed when resume returns no session_id", async () => {
    const { deps, onResumed, onResumeFailed } = makeDeps({
      resume: vi.fn(async () => ({ session_id: "" })),
    });
    await reattachAfterReconnect(deps);
    expect(onResumed).not.toHaveBeenCalled();
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
  });
});

// Android backgrounds the WebView mid-turn; the backend finishes and persists
// the reply while the socket is dead. On foreground the transport reconnects and
// `session.resume` is issued — but resume is allowed minutes (the gateway may
// rebuild the agent), and it re-pins nothing when the turn already ended. The
// REST snapshot is therefore the ONLY thing that can retire the local "思考中"
// state, so it must not be sequenced behind resume.
describe("reattachAfterReconnect stored-message refresh", () => {
  function deferredResume() {
    let settle: (result: ReconnectResumeResult) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const resume = vi.fn(
      () =>
        new Promise<ReconnectResumeResult>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        }),
    );
    return { resume, settle: (r: ReconnectResumeResult) => settle(r), fail: (e: Error) => fail(e) };
  }

  it("refreshes stored messages before a slow resume settles", async () => {
    const { resume, settle } = deferredResume();
    const onReattachStart = vi.fn();
    const { deps, onResumed } = makeDeps({ resume, onReattachStart });

    let finished = false;
    const pending = reattachAfterReconnect(deps).then(() => {
      finished = true;
    });
    // Drain the microtask queue: enough for the refresh + the resume call, but
    // the resume promise itself is still deliberately unsettled.
    await Promise.resolve();
    await Promise.resolve();

    expect(onReattachStart).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    expect(onResumed).not.toHaveBeenCalled();

    settle({ session_id: "gw-new" });
    await pending;
    expect(finished).toBe(true);
    // Exactly once — reattach must not double-refresh on the way out.
    expect(onReattachStart).toHaveBeenCalledTimes(1);
  });

  it("refreshes before resume is even issued", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      onReattachStart: async () => {
        calls.push("refresh");
        await Promise.resolve();
      },
      resume: vi.fn(async () => {
        calls.push("resume");
        return { session_id: "gw-new" };
      }),
    });

    await reattachAfterReconnect(deps);

    expect(calls).toEqual(["refresh", "resume"]);
  });

  it("skips resume when the awaited snapshot has retired the active turn", async () => {
    const calls: string[] = [];
    const { deps, resume } = makeDeps({
      onReattachStart: async () => {
        calls.push("refresh");
        await Promise.resolve();
        calls.push("recovered");
      },
      getActiveSessionId: () => (calls.includes("recovered") ? null : "gw-old"),
    });

    await reattachAfterReconnect(deps);

    expect(resume).not.toHaveBeenCalled();
  });

  it("still refreshes when there is no active session to resume", async () => {
    const onReattachStart = vi.fn();
    const { deps, resume } = makeDeps({
      getActiveSessionId: () => null,
      onReattachStart,
    });

    await reattachAfterReconnect(deps);

    expect(onReattachStart).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it("uses a saved persistent session when the gateway id was already cleared", async () => {
    const diagnostics: Array<{ stage: string; details?: Record<string, unknown> }> = [];
    const { deps, resume, onResumed } = makeDeps({
      getActiveSessionId: () => null,
      getActivePersistentSessionId: () => "sess-active",
      resolveRuntimeSessionId: () => "gw-lost",
      onReattachStart: vi.fn(async () => "active" as const),
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await reattachAfterReconnect(deps);

    expect(resume).toHaveBeenCalledWith("sess-active");
    expect(onResumed).toHaveBeenCalledWith("gw-sess-active", "sess-active", "gw-lost");
    expect(diagnostics.map((event) => event.stage)).toContain("reattach.active_session");
    expect(diagnostics.find((event) => event.stage === "reattach.active_session")?.details).toMatchObject({
      gatewaySessionId: null,
      persistentSessionId: "sess-active",
      runtimeSessionId: "gw-lost",
    });
  });

  it("still refreshes when resume rejects", async () => {
    const onReattachStart = vi.fn();
    const { deps, onResumeFailed } = makeDeps({
      onReattachStart,
      resume: vi.fn(async () => {
        throw new Error("Request timed out after 300000ms");
      }),
    });

    await reattachAfterReconnect(deps);

    expect(onReattachStart).toHaveBeenCalledTimes(1);
    expect(onResumeFailed).toHaveBeenCalledTimes(1);
  });
});

describe("isDefinitiveMissingSessionError", () => {
  it.each([
    new Error("Session not found"),
    new Error("unknown conversation id"),
    "conversation was reaped",
  ])("accepts explicit missing-session failures", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(true);
  });

  it.each([
    new Error("Request timed out after 300000ms"),
    new Error("WebSocket disconnected"),
    new Error("HTTP 503 Service Unavailable"),
  ])("keeps transient resume failures recoverable", (error) => {
    expect(isDefinitiveMissingSessionError(error)).toBe(false);
  });
});
