import { describe, expect, it } from "vitest";
import { getAndroidRemoteRouteRedirect } from "./android-remote-route-policy";

describe("Android Remote route policy", () => {
  it("redirects every memory route to remote health", () => {
    for (const pathname of ["/memory", "/memconfig", "/openviking", "/hindsight"]) {
      expect(getAndroidRemoteRouteRedirect(pathname, true)).toBe("/health");
    }
  });

  it("redirects desktop-only kernel and environment routes to remote health", () => {
    expect(getAndroidRemoteRouteRedirect("/kernel", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/env", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/advanced/kernel", true)).toBe("/health");
    expect(getAndroidRemoteRouteRedirect("/advanced/env", true)).toBe("/health");
  });

  it("keeps /about reachable on Android Remote (mobile build-info page)", () => {
    expect(getAndroidRemoteRouteRedirect("/about", true)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/advanced/about", true)).toBeNull();
  });

  it("does not redirect /about on desktop shells", () => {
    expect(getAndroidRemoteRouteRedirect("/about", false)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/advanced/about", false)).toBeNull();
  });

  it("does not redirect supported routes or desktop shells", () => {
    expect(getAndroidRemoteRouteRedirect("/memory", false)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/openviking", false)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/common", true)).toBeNull();
    expect(getAndroidRemoteRouteRedirect("/connection", true)).toBeNull();
  });

  it("redirects /console to /health on Android Remote", () => {
    expect(getAndroidRemoteRouteRedirect("/console", true)).toBe("/health");
  });

  it("does not redirect /console on desktop shells", () => {
    expect(getAndroidRemoteRouteRedirect("/console", false)).toBeNull();
  });

  it("redirects /coding-agents to /health on Android Remote", () => {
    expect(getAndroidRemoteRouteRedirect("/coding-agents", true)).toBe("/health");
  });

  it("does not redirect /coding-agents on desktop shells", () => {
    expect(getAndroidRemoteRouteRedirect("/coding-agents", false)).toBeNull();
  });

});
