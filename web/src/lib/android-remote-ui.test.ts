import { describe, expect, it } from "vitest";
import {
  filterAndroidRemoteProviders,
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

  it("filters provider cards only for Android Remote-only", () => {
    const providers = [
      { id: "cp.compshare.cn" },
      { id: "modelverse" },
      { id: "anthropic" },
    ];
    expect(filterAndroidRemoteProviders(providers, true)).toEqual([{ id: "anthropic" }]);
    expect(filterAndroidRemoteProviders(providers, false)).toEqual(providers);
  });

  it("hides Compshare environment variables only on Android", () => {
    expect(isAndroidRemoteHiddenEnvKey("COMPSHARE_API_KEY")).toBe(true);
    expect(isAndroidRemoteHiddenEnvKey("ANTHROPIC_API_KEY")).toBe(false);
  });
});
