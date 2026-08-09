import { describe, expect, it } from "vitest";
import type { MemoryProviderRuntimeStatusResponse } from "@hermes/protocol";
import { compactHealthDetail, isMemoryFieldVisible, memoryBackendState } from "./memory-backend-utils";

function status(overrides: Partial<MemoryProviderRuntimeStatusResponse> = {}): MemoryProviderRuntimeStatusResponse {
  return {
    provider: "openviking",
    active: false,
    configured: true,
    reachable: true,
    healthy: true,
    endpoint: "http://127.0.0.1:1933",
    console_url: "http://127.0.0.1:1933/studio",
    version: "0.3.26",
    checked_at: "2026-07-28T12:00:00Z",
    error: "",
    details: {
      kind: "openviking",
      auth_mode: "dev",
      ready_checks: {},
      system: {},
      components: {},
      summary: {},
      memory_stats: {},
      model_usage: [],
      queue_usage: [],
      tasks: [],
    },
    ...overrides,
  };
}

describe("memory backend UI state", () => {
  it("maps all runtime combinations to the locked product labels", () => {
    expect(memoryBackendState(undefined).label).toBe("未配置");
    expect(memoryBackendState(undefined, true)).toEqual({ label: "需登录", tone: "warn" });
    expect(memoryBackendState(status({ reachable: false, healthy: false })).label).toBe("已保存但离线");
    expect(memoryBackendState(status()).label).toBe("在线可用");
    expect(memoryBackendState(status({ active: true })).label).toBe("当前启用");
    expect(memoryBackendState(status({ healthy: false })).label).toBe("运行异常");
  });

  it("does not show 当前启用 or 在线可用 when status is unavailable even if providerActive", () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      providerActive: true,
      providerConfigured: true,
    });
    expect(result.label).not.toBe("当前启用");
    expect(result.label).not.toBe("在线可用");
    expect(result.label).toBe("服务端记录的当前选择（待核验）");
    expect(result.tone).toBe("warn");
  });

  it("does not treat provider metadata configured=true as configuration evidence when status is unavailable", () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      providerConfigured: true,
    });
    expect(result.label).toBe("待核验（状态接口不可用）");
    expect(result.label).not.toContain("已配置");
    expect(result.label).not.toContain("在线");
  });

  it("uses config fields as the only configuration evidence when the status route is unavailable", () => {
    expect(memoryBackendState(undefined, false, {
      statusUnavailable: true,
      configFieldsSet: false,
    }).label).toBe("未配置（状态接口不可用）");
    expect(memoryBackendState(undefined, false, {
      statusUnavailable: true,
      configFieldsSet: true,
    }).label).toBe("配置已保存（状态接口不可用）");
  });

  it("shows 已保存但待验证 when config fields have is_set but status says not configured", () => {
    const result = memoryBackendState(undefined, false, {
      configFieldsSet: true,
    });
    expect(result.label).toBe("已保存但待验证");
    expect(result.tone).toBe("warn");
  });

  it("shows mode-specific config fields only for the selected mode", () => {
    expect(isMemoryFieldVisible({
      key: "dashboard_url",
      label: "Dashboard URL",
      kind: "text",
      description: "",
      placeholder: "",
      required: false,
      value: "http://localhost:9999/dashboard",
      is_set: false,
      options: [],
      url: "",
      when: { mode: "local_external" },
    }, { mode: "local_external" })).toBe(true);

    expect(isMemoryFieldVisible({
      key: "dashboard_url",
      label: "Dashboard URL",
      kind: "text",
      description: "",
      placeholder: "",
      required: false,
      value: "http://localhost:9999/dashboard",
      is_set: false,
      options: [],
      url: "",
      when: { mode: "local_external" },
    }, { mode: "cloud" })).toBe(false);
  });

  it("keeps component health rows compact when observers return text tables", () => {
    expect(compactHealthDetail("healthy", true)).toBe("healthy");
    expect(compactHealthDetail("+----------------+\n| Queue | Pending |", true)).toBe("正常");
    expect(compactHealthDetail("failed", false)).toBe("failed");
  });
});
