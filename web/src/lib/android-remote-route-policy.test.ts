import { describe, expect, it } from "vitest";
import { getAndroidRemoteRouteRedirect } from "./android-remote-route-policy";

describe("Android Remote route policy", () => {
  it("redirects local memory editing to remote memory configuration", () => {
    expect(getAndroidRemoteRouteRedirect("/memory", true)).toBe("/memconfig");
  });

  it("redirects desktop-only kernel and environment routes to remote health", () => {
    expect(getAndroidRemoteRouteRedirect("/kernel", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/env", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/advanced/kernel", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/advanced/env", true)).toBe("/health");
  });

  it("does not redirect supported routes or desktop shells", () => {
    expect(getAndroidRemoteRouteRedirect("/memory", false)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/common", true)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/connection", true)).toBeNull();
  });
});
