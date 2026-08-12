import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent, HermesUIMessage, MessagesResponse } from "@hermes/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import type { NotificationSettings } from "@/stores/ui";

async function loadNotifications(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  const queryClientModule = await import("@/lib/query-client");
  const debugBusModule = await import("@/lib/debug-bus");
  debugBusModule.debugBus.clear();
  const mod = await import("./notifications");
  return {
    ...mod,
    uiStore,
    queryClient: queryClientModule.queryClient,
    debugBus: debugBusModule.debugBus,
  };
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    system: true,
    sound: true,
    onComplete: true,
    onApproval: true,
    onlyBackground: true,
    ...overrides,
  };
}

function runtimeWith(partial: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "streaming",
    pendingApprovals: [],
    statusMessage: "",
    updatedAt: 0,
    ...partial,
  };
}

function userMessage(text: string): HermesUIMessage {
  return {
    id: "u1",
    sessionId: "s1",
    role: "user",
    createdAt: 0,
    status: "complete",
    parts: [{ type: "text", text }],
  } as HermesUIMessage;
}

function approvalEvent(
  payload: Record<string, unknown> | undefined = { request_id: "r1", command: "rm -rf build" },
  sessionId: string | undefined = "s1",
): GatewayEvent {
  return { type: "approval.request", session_id: sessionId, payload } as GatewayEvent;
}

function completeEvent(
  payload: Record<string, unknown> = {},
  sessionId: string | undefined = "s1",
): GatewayEvent {
  return { type: "message.complete", session_id: sessionId, payload } as GatewayEvent;
}

function androidWindow(desktopNotify: unknown): Record<string, unknown> {
  return {
    __HERMES_RUNTIME__: { androidRemoteOnly: true },
    hermesDesktop: { desktopNotify },
  };
}

const never = () => false;

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  delete (globalThis as any).window;
  vi.unstubAllGlobals();
});

describe("decideNotification — approval.request", () => {
  it("produces an approval action with command body and a stable dedupe key", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: approvalEvent(),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "approval:s1:r1",
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
    });
  });

  it("falls back from command to reason to description to a default body", async () => {
    const { decideNotification } = await loadNotifications();
    const byReason = decideNotification({
      event: approvalEvent({ request_id: "r1", reason: "需要写入磁盘" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byReason?.body).toBe("需要写入磁盘");

    const byDefault = decideNotification({
      event: approvalEvent({ request_id: "r1" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byDefault?.body).toBe("任务等待你的确认后才能继续");
  });

  it("returns null when the approval toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ onApproval: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when both system notification and sound are off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ system: false, sound: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null without a request_id (cannot dedupe replays)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent({ command: "rm -rf build" }),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the approval is already pending in the previous runtime", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith({
          pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "rm -rf build" }],
        }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the dedupe key was already notified", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: (key) => key === "approval:s1:r1",
      }),
    ).toBeNull();
  });

  it("truncates an overlong command body", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: approvalEvent({ request_id: "r1", command: "x".repeat(500) }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body.length).toBeLessThanOrEqual(120);
    expect(action?.body.endsWith("…")).toBe(true);
  });

  it("does not split surrogate pairs when truncating", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: approvalEvent({ request_id: "r1", command: "🚀".repeat(200) }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    const body = action?.body ?? "";
    expect(body.endsWith("…")).toBe(true);
    expect(Array.from(body).length).toBeLessThanOrEqual(120);
    // 截断点不能落在代理对中间产生孤立代理字符。
    expect(body).toMatch(/^(?:🚀)+…$/u);
  });
});

describe("decideNotification — message.complete", () => {
  it("produces a complete action summarizing the latest user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent({ status: "complete" }),
      prevRuntime: runtimeWith({
        activeAssistantId: "live-assistant-1",
        messages: [userMessage("帮我重构登录模块")],
      }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "complete:s1:live-assistant-1",
      kind: "complete",
      title: "任务完成",
      body: "帮我重构登录模块",
    });
  });

  it("falls back to a default body without a user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent(),
      prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body).toBe("会话回复已就绪");
  });

  it("maps status=error to an error action carrying the error text", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent({ status: "error", error: "API Key 已失效" }),
      prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.kind).toBe("error");
    expect(action?.title).toBe("任务出错");
    expect(action?.body).toBe("API Key 已失效");
  });

  it("returns null without an active assistant turn (SSE replay protection)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: undefined,
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null after a manual interrupt", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1", interrupted: true }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the complete toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
        settings: settings({ onComplete: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("decideNotification — other events", () => {
  it("ignores unrelated event types and missing session ids", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: { type: "tool.start", session_id: "s1", payload: {} } as GatewayEvent,
        prevRuntime: runtimeWith({ activeAssistantId: "a" }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        event: {
          type: "approval.request",
          payload: { request_id: "r1", command: "rm -rf build" },
        } as GatewayEvent,
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("dedupe store", () => {
  it("remembers marked keys", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    expect(hasNotified("k1")).toBe(false);
    markNotified("k1");
    markNotified("k1");
    expect(hasNotified("k1")).toBe(true);
  });

  it("evicts the oldest keys beyond the FIFO cap of 500", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    for (let i = 0; i < 501; i += 1) markNotified(`k${i}`);
    expect(hasNotified("k0")).toBe(false);
    expect(hasNotified("k1")).toBe(true);
    expect(hasNotified("k500")).toBe(true);
  });
});

describe("shouldPlayFallbackSound", () => {
  const delivered = { delivered: true, focused: false };
  const undelivered = { delivered: false, focused: false };

  it("never plays when the sound toggle is off", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ sound: false }), undelivered)).toBe(false);
    expect(shouldPlayFallbackSound(settings({ sound: false, system: false }), undelivered)).toBe(false);
  });

  it("stays silent in the foreground when only-background is on", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(
      shouldPlayFallbackSound(settings(), { delivered: false, focused: true }),
    ).toBe(false);
    expect(
      shouldPlayFallbackSound(settings({ onlyBackground: false }), {
        delivered: false,
        focused: true,
      }),
    ).toBe(true);
  });

  it("skips the chime when the system notification carried its own sound", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings(), delivered)).toBe(false);
  });

  it("plays when system notifications are disabled or failed", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ system: false }), undelivered)).toBe(true);
    expect(
      shouldPlayFallbackSound(settings(), { ...undelivered, error: "permission denied" }),
    ).toBe(true);
  });
});

describe("notifyFromGatewayEvent", () => {
  class FakeAudioContext {
    static created = 0;
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      FakeAudioContext.created += 1;
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    resume() {
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    FakeAudioContext.created = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  it("is a no-op without the desktop bridge", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    (globalThis as any).window = {};
    expect(() => notifyFromGatewayEvent(approvalEvent(), runtimeWith())).not.toThrow();
  });

  it("invokes desktopNotify once with the settings-driven payload", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify).toHaveBeenCalledWith({
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
      showSystemNotification: true,
      withSound: true,
      respectFocus: true,
      requestAttention: true,
    });
  });

  it("notifies the native bridge when an active turn completes", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(
      completeEvent({ status: "complete" }),
      runtimeWith({
        activeAssistantId: "live-assistant-1",
        messages: [userMessage("后台任务")],
      }),
    );
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "complete",
        title: "任务完成",
        respectFocus: true,
      }),
    );
  });

  it("does not notify a completion event when no turn is active", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(completeEvent({ status: "complete" }), runtimeWith());
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });
  it("does not notify twice for a replayed event", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi.fn().mockRejectedValue(new Error("ipc down"));
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    expect(() => notifyFromGatewayEvent(approvalEvent(), runtimeWith())).not.toThrow();
    await flushAsync();
    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("allows a later retry after native delivery fails", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValueOnce({ delivered: false, focused: false, error: "permission denied" })
      .mockResolvedValueOnce({ delivered: true, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      activeAssistantId: "live-assistant-1",
      messages: [userMessage("后台任务")],
    });
    notifyFromGatewayEvent(completeEvent({ status: "complete" }), runtime);
    await flushAsync();
    notifyFromGatewayEvent(completeEvent({ status: "complete" }), runtime);
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(2);
  });

  it("plays the WebAudio chime when system notifications are disabled", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications({
      "hermes.notify-system": false,
    });
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: false, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ showSystemNotification: false, withSound: true }),
    );
    expect(FakeAudioContext.created).toBe(1);
  });

  it("respects disabled event-type toggles end to end", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications({
      "hermes.notify-on-approval": false,
    });
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("prefixes the body with the session title from the query cache", async () => {
    const { notifyFromGatewayEvent, queryClient } = await loadNotifications();
    queryClient.setQueryData(["sessions", "default", 50, 0], {
      sessions: [{ id: "s1", title: "重构登录" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ body: "「重构登录」 · rm -rf build" }),
    );
  });
});

// ── Reconnect snapshot notification ──────────────────────────────────
// When Android backgrounds the app during an active turn, the WebSocket
// drops and the server's message.complete is lost. On reconnect the REST
// snapshot shows the turn is done but the gateway never replays the event.
// notifyFromReconnectSnapshot detects this and fires a synthetic notification.

describe("notifyFromReconnectSnapshot", () => {
  it("fires notification when REST shows completed turn with active assistant id", async () => {
    const { notifyFromReconnectSnapshot, debugBus } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, visible: true, attentionRequested: false });
    (globalThis as any).window = androidWindow(desktopNotify);

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
      messages: [userMessage("帮我写代码")],
    });

    const restData: MessagesResponse = {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "u1", sessionId: "s1", role: "user", createdAt: 0, status: "complete", parts: [{ type: "text", text: "帮我写代码" }] },
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "complete", parts: [{ type: "text", text: "好的" }] },
      ],
    };

    notifyFromReconnectSnapshot("s1", runtime, restData);
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "complete",
        title: "任务完成",
        respectFocus: false,
      }),
    );
    const entries = debugBus.snapshot();
    expect(entries.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining([
        "notification.reconnect-snapshot.started",
        "notification.reconnect-snapshot.matched",
        "notification.native.result",
      ]),
    );
    const matched = entries.find(
      (entry) => entry.summary === "notification.reconnect-snapshot.matched",
    );
    expect(matched?.payload).toMatchObject({
      sessionId: "s1",
      activeAssistantId: "live-assistant-100",
      assistantStatus: "complete",
    });
    const nativeResult = entries.find((entry) => entry.summary === "notification.native.result");
    expect(nativeResult?.payload).toMatchObject({
      source: "reconnect-snapshot",
      delivered: true,
      focused: false,
      visible: true,
      error: null,
    });
    expect(JSON.stringify(matched?.payload)).not.toContain("好的");
  });

  it("records the exact skip reason when no active assistant turn exists", async () => {
    const { notifyFromReconnectSnapshot, debugBus } = await loadNotifications();
    const desktopNotify = vi.fn();
    (globalThis as any).window = androidWindow(desktopNotify);

    notifyFromReconnectSnapshot("s1", runtimeWith({ turnStartedAt: 50 }), {
      session_id: "s1",
      messages: [],
      ui_messages: [],
    });
    await flushAsync();

    const skipped = debugBus
      .snapshot()
      .find((entry) => entry.summary === "notification.reconnect-snapshot.skipped");
    expect(skipped?.payload).toMatchObject({ reason: "no_active_assistant" });
    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("does not fire when no active assistant id (no in-flight turn)", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications();
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      activeAssistantId: undefined,
    });

    notifyFromReconnectSnapshot("s1", runtime, { session_id: "s1", messages: [], ui_messages: [] });
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("does not fire when REST turn is still streaming", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications();
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
    });

    const restData: MessagesResponse = {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "streaming", parts: [{ type: "text", text: "正在..." }] },
      ],
    };

    notifyFromReconnectSnapshot("s1", runtime, restData);
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("does not notify for a completed assistant message from before the active turn", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications();
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 200,
      activeAssistantId: "live-assistant-100",
    });
    const restData: MessagesResponse = {
      session_id: "s1",
      messages: [],
      ui_messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant",
          createdAt: 100,
          status: "complete",
          parts: [{ type: "text", text: "上一轮已完成" }],
        },
      ],
    };

    notifyFromReconnectSnapshot("s1", runtime, restData);
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("fires error notification when REST shows errored turn", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
    });

    const restData: MessagesResponse = {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "error", parts: [{ type: "text", text: "失败" }] },
      ],
    };

    notifyFromReconnectSnapshot("s1", runtime, restData);
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", title: "任务出错" }),
    );
  });

  it("does not double-notify when real message.complete arrives after synthetic", async () => {
    const { notifyFromGatewayEvent, notifyFromReconnectSnapshot } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
      messages: [userMessage("帮我写代码")],
    });

    // Synthetic fires first (from reconnect snapshot)
    const restData: MessagesResponse = {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "complete", parts: [{ type: "text", text: "好的" }] },
      ],
    };
    notifyFromReconnectSnapshot("s1", runtime, restData);
    await flushAsync();
    expect(desktopNotify).toHaveBeenCalledTimes(1);

    // Real message.complete arrives later — should be deduped
    notifyFromGatewayEvent(completeEvent(), runtime);
    await flushAsync();
    expect(desktopNotify).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("is a no-op when onComplete is disabled", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications({
      "hermes.notify-on-complete": false,
    });
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
    });

    notifyFromReconnectSnapshot("s1", runtime, {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "complete", parts: [] },
      ],
    });
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("is a no-op when both system and sound are off", async () => {
    const { notifyFromReconnectSnapshot } = await loadNotifications({
      "hermes.notify-system": false,
      "hermes.notify-sound": false,
    });
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    const runtime = runtimeWith({
      streamStatus: "connecting",
      turnStartedAt: 50,
      activeAssistantId: "live-assistant-100",
    });

    notifyFromReconnectSnapshot("s1", runtime, {
      session_id: "s1",
      messages: [],
      ui_messages: [
        { id: "a1", sessionId: "s1", role: "assistant", createdAt: 100, status: "complete", parts: [] },
      ],
    });
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });
});
