import { describe, expect, it } from "vitest";
import { memoryBackendState } from "./memory-backend-utils";

describe("memoryBackendState: status endpoint branches", () => {
  it("returns 当前启用（状态接口不可用） when status 404 and provider is active", () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      providerActive: true,
      providerConfigured: true,
    });
    expect(result.label).toBe("当前启用（状态接口不可用）");
    expect(result.tone).toBe("active");
  });

  it("returns 已配置（状态接口不可用） when status 404 and provider is configured but not active", () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      providerActive: false,
      providerConfigured: true,
    });
    expect(result.label).toBe("已配置（状态接口不可用）");
    expect(result.tone).toBe("ok");
  });

  it("returns 状态未知（状态接口不可用） when status 404 and provider not configured", () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      providerActive: false,
      providerConfigured: false,
    });
    expect(result.label).toBe("状态未知（状态接口不可用）");
    expect(result.label).not.toBe("未配置");
  });

  it("returns 未配置 when no status and statusUnavailable is not set", () => {
    const result = memoryBackendState(undefined, false);
    expect(result.label).toBe("未配置");
    expect(result.tone).toBe("muted");
  });

  it("returns 需登录 when authRequired is true regardless of other flags", () => {
    const result = memoryBackendState(undefined, true, { statusUnavailable: true, providerActive: true });
    expect(result.label).toBe("需登录");
    expect(result.tone).toBe("warn");
  });

  it("returns 当前启用 when status has active=true, configured=true, reachable, healthy", () => {
    const result = memoryBackendState({
      active: true,
      configured: true,
      reachable: true,
      healthy: true,
      checked_at: "2026-08-08T12:00:00Z",
    } as any, false);
    expect(result.label).toBe("当前启用");
    expect(result.tone).toBe("active");
  });

  it("returns 在线可用 when status is configured+reachable+healthy but not active", () => {
    const result = memoryBackendState({
      active: false,
      configured: true,
      reachable: true,
      healthy: true,
      checked_at: "2026-08-08T12:00:00Z",
    } as any, false);
    expect(result.label).toBe("在线可用");
    expect(result.tone).toBe("ok");
  });

  it("returns 运行异常 when status is configured+reachable but not healthy", () => {
    const result = memoryBackendState({
      active: true,
      configured: true,
      reachable: true,
      healthy: false,
      checked_at: "2026-08-08T12:00:00Z",
    } as any, false);
    expect(result.label).toBe("运行异常");
    expect(result.tone).toBe("error");
  });

  it("returns 已保存但离线 when status is configured but not reachable", () => {
    const result = memoryBackendState({
      active: false,
      configured: true,
      reachable: false,
      healthy: false,
      checked_at: "2026-08-08T12:00:00Z",
    } as any, false);
    expect(result.label).toBe("已保存但离线");
    expect(result.tone).toBe("warn");
  });

  it("never returns 未配置 when statusUnavailable is true", () => {
    // Test all combinations of provider flags
    for (const providerActive of [true, false]) {
      for (const providerConfigured of [true, false]) {
        const result = memoryBackendState(undefined, false, {
          statusUnavailable: true,
          providerActive,
          providerConfigured,
        });
        expect(result.label).not.toBe("未配置");
      }
    }
  });

  it('returns 状态读取失败 for a non-404, non-auth error (500)', () => {
    const result = memoryBackendState(undefined, false, {
      statusError: true,
      providerActive: false,
      providerConfigured: false,
    });
    expect(result.label).toBe('状态读取失败');
    expect(result.tone).toBe('error');
  });

  it('returns 当前启用（状态读取失败） when statusError and provider is active', () => {
    const result = memoryBackendState(undefined, false, {
      statusError: true,
      providerActive: true,
      providerConfigured: true,
    });
    expect(result.label).toBe('当前启用（状态读取失败）');
    expect(result.tone).toBe('error');
  });

  it('returns 已配置（状态读取失败） when statusError and provider is configured but not active', () => {
    const result = memoryBackendState(undefined, false, {
      statusError: true,
      providerActive: false,
      providerConfigured: true,
    });
    expect(result.label).toBe('已配置（状态读取失败）');
    expect(result.tone).toBe('error');
  });

  it('statusUnavailable takes precedence over statusError (404 wins)', () => {
    const result = memoryBackendState(undefined, false, {
      statusUnavailable: true,
      statusError: true,
      providerActive: true,
      providerConfigured: true,
    });
    expect(result.label).toBe('当前启用（状态接口不可用）');
    expect(result.tone).toBe('active');
  });

  it('authRequired takes precedence over statusError', () => {
    const result = memoryBackendState(undefined, true, {
      statusError: true,
      providerActive: true,
    });
    expect(result.label).toBe('需登录');
    expect(result.tone).toBe('warn');
  });

});
