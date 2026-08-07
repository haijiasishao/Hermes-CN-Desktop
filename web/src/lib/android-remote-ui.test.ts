import { describe, expect, it } from "vitest";
import {
  filterRemovedProviders,
  filterAndroidRemoteProviders,
  isRemovedProviderEnvKey,
  isRemovedProviderId,
  isAndroidRemoteHiddenEnvKey,
  isAndroidRemoteHiddenProviderId,
} from "./android-remote-ui";

describe("Android Remote-only UI filtering", () => {
  it("hides all known 优云智算 provider aliases on Android", () => {
    expect(isAndroidRemoteHiddenProviderId("cp.compshare.cn")).toBe(true);
    expect(isAndroidRemoteHiddenProviderId("modelverse")).toBe(true);
    expect(isAndroidRemoteHiddenProviderId("legacy-youyun-provider")).toBe(true);
    expect(isAndroidRemoteHiddenProviderId("anthropic")).toBe(false);
  });

  it("removes all Alibaba/DashScope provider aliases on every platform", () => {
    expect(isRemovedProviderId("alibaba")).toBe(true);
    expect(isRemovedProviderId("alibaba-coding-cn")).toBe(true);
    expect(isRemovedProviderId("dashscope")).toBe(true);
    expect(isRemovedProviderId("some-alibaba-legacy")).toBe(true);
    expect(isRemovedProviderId("custom-dashscope-proxy")).toBe(true);
    expect(isRemovedProviderId("anthropic")).toBe(false);
  });

  it("filters provider cards only for Android Remote-only", () => {
    const providers = [
      { id: "cp.compshare.cn" },
      { id: "modelverse" },
      { id: "anthropic" },
    ];
    expect(filterAndroidRemoteProviders(providers, true)).toEqual([{ id: "anthropic" }]);
    expect(filterAndroidRemoteProviders(providers, false)).toEqual(providers);
  });

  it("removes Alibaba/DashScope providers while retaining other providers", () => {
    const providers = [
      { id: "alibaba" },
      { id: "dashscope" },
      { id: "cp.compshare.cn" },
      { id: "anthropic" },
    ];
    expect(filterRemovedProviders(providers)).toEqual([
      { id: "cp.compshare.cn" },
      { id: "anthropic" },
    ]);
  });

  it("hides Compshare environment variables only on Android", () => {
    expect(isAndroidRemoteHiddenEnvKey("COMPSHARE_API_KEY")).toBe(true);
    expect(isAndroidRemoteHiddenEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("removes Alibaba/DashScope environment variables on every platform", () => {
    expect(isRemovedProviderEnvKey("DASHSCOPE_API_KEY")).toBe(true);
    expect(isRemovedProviderEnvKey("ALIBABA_CLOUD_ACCESS_KEY_ID")).toBe(true);
    expect(isRemovedProviderEnvKey("HERMES_QWEN_MODEL")).toBe(true);
    expect(isRemovedProviderEnvKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(isRemovedProviderEnvKey("DEEPSEEK_API_KEY")).toBe(false);
  });

  it("keeps the existing Android-only environment filtering scoped", () => {
    expect(isAndroidRemoteHiddenEnvKey("COMPSHARE_API_KEY")).toBe(true);
    expect(isAndroidRemoteHiddenEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});