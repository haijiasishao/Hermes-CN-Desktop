import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "settings.tsx"),
  "utf-8",
);

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf(`const ${nextName}`, start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("Notification flow: updateAndroidPermission return type", () => {
  it("returns { granted, state } instead of plain boolean", () => {
    const body = functionBody("updateAndroidPermission", "handleSystemChange");
    expect(body).toContain("Promise<{ granted: boolean; state: string }>");
  });

  it("non-Android returns { granted: true, state: 'granted' }", () => {
    const body = functionBody("updateAndroidPermission", "handleSystemChange");
    expect(body).toContain('return { granted: true, state: "granted" }');
  });

  it("success path returns { granted: result.granted, state: result.state }", () => {
    const body = functionBody("updateAndroidPermission", "handleSystemChange");
    expect(body).toContain("return { granted: result.granted, state: result.state }");
  });

  it("error path returns { granted: false, state: 'unavailable' }", () => {
    const body = functionBody("updateAndroidPermission", "handleSystemChange");
    expect(body).toContain('return { granted: false, state: "unavailable" }');
  });
});

describe("Notification flow: stale state bug fix", () => {
  it("handleTestNotification captures fresh permission state from updateAndroidPermission", () => {
    const body = functionBody("handleTestNotification", "permissionLabel");
    // Captures perm.state from updateAndroidPermission for diagnostics.
    expect(body).toContain("freshState = perm.state");
    expect(body).toContain("updateAndroidPermission(true)");
  });

  it("handleTestNotification uses freshState for denied check instead of early return", () => {
    const body = functionBody("handleTestNotification", "permissionLabel");
    // Must use freshState (not stale permissionState) in error handling.
    expect(body).toContain('freshState === "denied"');
    // Must NOT early-return before calling desktopNotify — the plugin is
    // authoritative, not the permission pre-check.
    expect(body).toContain("bridge.desktopNotify(");
    // freshState is checked AFTER result.error, not as a gate.
    const freshIdx = body.indexOf('freshState === "denied"');
    const resultErrorIdx = body.indexOf("result.error");
    expect(freshIdx).toBeGreaterThan(resultErrorIdx);
  });

  it("handleSystemChange uses .granted from the return value", () => {
    const body = functionBody("handleSystemChange", "handleTestNotification");
    expect(body).toContain("(await updateAndroidPermission(true)).granted");
  });
});

describe("Notification flow: visibility refresh", () => {
  it("registers visibilitychange listener to refresh permission on return from system settings", () => {
    expect(source).toContain("visibilitychange");
    expect(source).toContain('document.visibilityState === "visible"');
  });

  it("also listens for focus and pageshow events", () => {
    expect(source).toContain('window.addEventListener("focus"');
    expect(source).toContain('window.addEventListener("pageshow"');
  });

  it("cleans up all three event listeners on unmount", () => {
    expect(source).toContain('document.removeEventListener("visibilitychange"');
    expect(source).toContain('window.removeEventListener("focus"');
    expect(source).toContain('window.removeEventListener("pageshow"');
  });
});

describe("Notification flow: refresh callback behavior", () => {
  it("visibility change callback calls updateAndroidPermission with request=false", () => {
    const body = functionBody("updateAndroidPermission", "handleSystemChange");
    // The refresh callback uses updateAndroidPermission(false) — check only, no request.
    expect(source).toContain("void updateAndroidPermission(false)");
  });

  it("error message distinguishes actual send failure from permission state", () => {
    // The test notification error message should reference the actual error
    // from desktopNotify (result.error), not just the permission state.
    const testBody = functionBody("handleTestNotification", "permissionLabel");
    expect(testBody).toContain("result.error");
    // Error message should reference the actual send result.
    expect(testBody).toContain("系统通知发送失败");
  });

  it("permission denied error is separate from send error", () => {
    const testBody = functionBody("handleTestNotification", "permissionLabel");
    // The denied check (freshState === denied) should produce a different
    // error message than the send failure.
    expect(testBody).toContain("Android 通知权限已被永久拒绝");
  });
});
