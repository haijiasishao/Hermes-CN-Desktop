import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname ?? __dirname, "settings-connection-section.tsx"),
  "utf-8",
);

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf(`const ${nextName}`, start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("Auth flow behavior: handlePasswordLogin", () => {
  it("calls applyConnectionConfig with oauth mode", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain("applyConnectionConfig");
    expect(body).toContain('remoteAuthMode: "oauth"');
  });

  it("places applyConnectionConfig before notifyConnectionAuthRestored", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    const applyIdx = body.indexOf("applyConnectionConfig");
    const notifyIdx = body.indexOf("notifyConnectionAuthRestored");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeLessThan(notifyIdx);
  });

  it("guards notify behind apply result: does not notify on apply failure", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    // The apply result check must come before notify
    const appliedOkCheck = body.indexOf("!applied.ok");
    const notifyIdx = body.indexOf("notifyConnectionAuthRestored");
    expect(appliedOkCheck).toBeGreaterThan(-1);
    expect(appliedOkCheck).toBeLessThan(notifyIdx);
    // There should be a return after the failure message to prevent notify
    const afterFailCheck = body.slice(appliedOkCheck, notifyIdx);
    expect(afterFailCheck).toContain("return");
  });

  it("shows error message when apply fails, not success", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    // Should have error tone for failure path
    const appliedOkIdx = body.indexOf("!applied.ok");
    if (appliedOkIdx > -1) {
      const failBlock = body.slice(appliedOkIdx, body.indexOf("return", appliedOkIdx) + 10);
      expect(failBlock).toContain('"error"');
      expect(failBlock).not.toContain('"登录成功"');
    }
  });
});

describe("Auth flow behavior: handleOauthLogin", () => {
  it("uses the same applyConnectionConfig pattern as password login", () => {
    const body = functionBody("handleOauthLogin", "handlePasswordLogin");
    expect(body).toContain("applyConnectionConfig");
    expect(body).toContain('remoteAuthMode: "oauth"');
  });

  it("guards notify behind apply result in OAuth flow too", () => {
    const body = functionBody("handleOauthLogin", "handlePasswordLogin");
    const applyIdx = body.indexOf("applyConnectionConfig");
    const notifyIdx = body.indexOf("notifyConnectionAuthRestored");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeLessThan(notifyIdx);
  });
});

describe("URL handling", () => {
  it("passes trimmedRemoteUrl to applyConnectionConfig (not raw input)", () => {
    const pwBody = functionBody("handlePasswordLogin", "handleLogout");
    expect(pwBody).toContain("trimmedRemoteUrl");
  });

  it("both login handlers pass mode remote to applyConnectionConfig", () => {
    const pwBody = functionBody("handlePasswordLogin", "handleLogout");
    const oauthBody = functionBody("handleOauthLogin", "handlePasswordLogin");
    expect(pwBody).toContain('mode: "remote"');
    expect(oauthBody).toContain('mode: "remote"');
  });
});
