import { describe, expect, it } from "vitest";
import {
  dashboardAuthErrorMessage,
  errorText,
  isDashboardAuthError,
} from "./dashboard-error";

describe("dashboard authentication error classification", () => {
  it("recognizes the native proxy HTTP 401 envelope", () => {
    const error = new Error(
      'HTTP 401: {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}',
    );

    expect(isDashboardAuthError(error)).toBe(true);
    expect(dashboardAuthErrorMessage()).toContain("用户名/密码");
  });

  it("recognizes a serialized Tauri IPC error object with status 401", () => {
    const error = {
      message: "Dashboard request failed",
      status: 401,
      body: '{"error":"unauthenticated","reason":"no_cookie"}',
    };

    expect(errorText(error)).toContain("no_cookie");
    expect(isDashboardAuthError(error)).toBe(true);
  });

  it("does not classify upstream availability failures as auth failures", () => {
    expect(isDashboardAuthError(new Error("HTTP 502: upstream unavailable"))).toBe(false);
  });
});
