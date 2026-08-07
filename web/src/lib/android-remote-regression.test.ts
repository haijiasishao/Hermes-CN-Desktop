/**
 * Android Remote-only regression tests.
 *
 * Fixed behaviors that must hold for the Android port:
 *  - Connection config commands pass remote-specific params correctly
 *  - Guide state IPC uses the expected command and shape
 *  - get_runtime_config populates androidRemoteOnly in __HERMES_RUNTIME__
 *  - GatewayClient suspends reconnect on both 4401 and 4403 close codes
 *  - Android Remote mode disables unsupported bridge methods
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((command: string) => {
    if (command === "get_runtime_config") {
      return Promise.resolve({
        apiBaseUrl: "http://192.168.1.10:9119",
        gatewayUrl: "ws://192.168.1.10:9119/api/ws?token=tok",
        sessionToken: "tok",
        currentProfile: "default",
        connectionMode: "remote",
        backendReady: true,
        guideState: "completed",
        managedRuntimeDesiredState: "stopped",
        managedRuntimeLifecycleState: "uninstalled",
        androidRemoteOnly: true,
      });
    }
    return Promise.resolve({});
  });
  (globalThis as any).window = {};
});

afterEach(() => {
  delete (globalThis as any).window;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tauri bridge: connection config ───────────────────────────────────

describe("Android Remote bridge: connection config", () => {
  it("getConnectionConfig invokes get_connection_config", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.getConnectionConfig?.();
    expect(mockInvoke).toHaveBeenCalledWith("get_connection_config", undefined);
  });

  it("saveConnectionConfig passes remote mode and URL/token", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.saveConnectionConfig?.({
      mode: "remote",
      remoteUrl: "http://new-host:9120",
      remoteToken: "new-tok",
    });

    expect(mockInvoke).toHaveBeenCalledWith("save_connection_config", {
      input: {
        mode: "remote",
        remoteUrl: "http://new-host:9120",
        remoteToken: "new-tok",
      },
    });
  });

  it("testConnectionConfig passes remote mode and URL/token", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.testConnectionConfig?.({
      mode: "remote",
      remoteUrl: "http://host:9221",
      remoteToken: "tok",
    });

    expect(mockInvoke).toHaveBeenCalledWith("test_connection_config", {
      input: {
        mode: "remote",
        remoteUrl: "http://host:9221",
        remoteToken: "tok",
      },
    });
  });

  it("probeConnectionConfig passes remoteUrl as a plain argument", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.probeConnectionConfig?.("http://host:9221");
    expect(mockInvoke).toHaveBeenCalledWith("probe_connection_config", {
      remoteUrl: "http://host:9221",
    });
  });

  it("applyConnectionConfig passes remote mode input", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.applyConnectionConfig?.({
      mode: "remote",
      remoteUrl: "http://host:9221",
      remoteToken: "tok",
    });

    expect(mockInvoke).toHaveBeenCalledWith("apply_connection_config", {
      input: {
        mode: "remote",
        remoteUrl: "http://host:9221",
        remoteToken: "tok",
      },
    });
  });
});

// ── Tauri bridge: guide state IPC ─────────────────────────────────────

describe("Android Remote bridge: guide state", () => {
  it("setGuideState wraps the value in { input: { guideState } }", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.setGuideState?.("pending");
    expect(mockInvoke).toHaveBeenCalledWith("set_guide_state", {
      input: { guideState: "pending" },
    });

    await window.hermesDesktop?.setGuideState?.("deferred");
    expect(mockInvoke).toHaveBeenCalledWith("set_guide_state", {
      input: { guideState: "deferred" },
    });

    await window.hermesDesktop?.setGuideState?.("completed");
    expect(mockInvoke).toHaveBeenCalledWith("set_guide_state", {
      input: { guideState: "completed" },
    });
  });

  it("getDesktopControlState invokes get_desktop_control_state", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    await window.hermesDesktop?.getDesktopControlState?.();
    expect(mockInvoke).toHaveBeenCalledWith("get_desktop_control_state", undefined);
  });
});

// ── installTauriBridge: androidRemoteOnly flag ────────────────────────

describe("installTauriBridge: androidRemoteOnly", () => {
  it("populates androidRemoteOnly in __HERMES_RUNTIME__ from config", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      androidRemoteOnly: true,
      connectionMode: "remote",
      backendReady: true,
    });
  });

  it("defaults androidRemoteOnly to false when config omits it", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_runtime_config") {
        return Promise.resolve({
          apiBaseUrl: "http://127.0.0.1:9119",
          gatewayUrl: "ws://127.0.0.1:9119/api/ws",
          sessionToken: "tok",
          currentProfile: "default",
          connectionMode: "remote",
        });
      }
      return Promise.resolve({});
    });

    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    expect(window.__HERMES_RUNTIME__?.androidRemoteOnly).toBe(false);
  });

  it("disables unsupported bridge methods when androidRemoteOnly && remote", async () => {
    const { installTauriBridge } = await import("./tauri-bridge");
    await installTauriBridge();

    const bridge = window.hermesDesktop as Record<string, unknown>;

    // These desktop-only methods must be removed
    expect(bridge.terminalStart).toBeUndefined();
    expect(bridge.terminalClose).toBeUndefined();
    expect(bridge.getYoloMode).toBeUndefined();
    expect(bridge.environmentCheck).toBeUndefined();
    expect(bridge.codingAgentsCheck).toBeUndefined();
    expect(bridge.scanConfigMigration).toBeUndefined();
    expect(bridge.readWorkspaceFile).toBeUndefined();
    expect(bridge.writeWorkspaceFile).toBeUndefined();
    expect(bridge.git).toBeUndefined();

    // Core remote methods must survive
    expect(typeof bridge.getConnectionConfig).toBe("function");
    expect(typeof bridge.saveConnectionConfig).toBe("function");
    expect(typeof bridge.setGuideState).toBe("function");
    expect(typeof bridge.getRuntimeConfig).toBe("function");
  });
});

// ── GatewayClient: auth close codes ───────────────────────────────────

describe("GatewayClient: auth close codes", () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(public url: string) {
      MockWebSocket.instances.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    close(code?: number, reason?: string) {
      this.readyState = 3;
      this.onclose?.(
        code === undefined ? undefined : { code, reason },
      );
    }
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", protocol: "http:" },
      __HERMES_SESSION_TOKEN__: "tok",
    });
  });

  it("4403 close suspends reconnect and emits auth_required with code 4403", async () => {
    vi.useFakeTimers();
    const { GatewayClient } = await import("./gateway-client");
    const client = new GatewayClient((url) => new MockWebSocket(url) as unknown as WebSocket);
    client.enableAutoReconnect();

    const events: Array<{ type: string; code?: number }> = [];
    client.onAny((ev) => {
      if (ev.type === "gateway.auth_required") {
        events.push(ev as unknown as { type: string; code?: number });
      }
    });

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(4403, "host rejected");

    // auth_required emitted with code 4403
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { code: 4403 } });

    // No new socket even after extended wait — reconnect is suspended
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    // forceReconnect clears the gate
    client.forceReconnect("relogin");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    client.close();
  });

  it("non-auth close (1006) does NOT suspend reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { GatewayClient } = await import("./gateway-client");
    const client = new GatewayClient((url) => new MockWebSocket(url) as unknown as WebSocket);
    client.enableAutoReconnect();

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].close(1006, "abnormal");

    // Non-auth close triggers reconnect after backoff
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    client.close();
  });
});

// ── GatewayClient: event parsing ──────────────────────────────────────

describe("GatewayClient: event parsing from relay frames", () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(public url: string) {
      MockWebSocket.instances.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(data: string) {
      this.sent.push(data);
    }
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", protocol: "http:" },
      __HERMES_SESSION_TOKEN__: "tok",
    });
  });

  it("parses a JSON-RPC response and resolves the matching pending request", async () => {
    const { GatewayClient } = await import("./gateway-client");
    const client = new GatewayClient((url) => new MockWebSocket(url) as unknown as WebSocket);

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;
    await Promise.resolve();

    const requestPromise = client.request("session.list", { limit: 10 });
    await Promise.resolve();

    // Simulate the relay delivering a JSON-RPC response matching the sent id
    const sentPayload = JSON.parse(MockWebSocket.instances[0].sent[0]);
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: sentPayload.id,
      result: { sessions: ["s1", "s2"] },
    });
    MockWebSocket.instances[0].onmessage?.({ data: response });

    const result = await requestPromise;
    expect(result).toEqual({ sessions: ["s1", "s2"] });
  });

  it("broadcasts typed events to matching listeners", async () => {
    const { GatewayClient } = await import("./gateway-client");
    const client = new GatewayClient((url) => new MockWebSocket(url) as unknown as WebSocket);

    const connected = client.connect();
    MockWebSocket.instances[0].open();
    await connected;

    const received: unknown[] = [];
    client.on("message.complete", (ev) => received.push(ev));

    // Simulate a gateway event (not a JSON-RPC response — no id field)
    const event = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "s1",
        payload: { text: "done" },
      },
    });
    MockWebSocket.instances[0].onmessage?.({ data: event });

    expect(received).toHaveLength(1);
    client.close();
  });
});
