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
    const appliedOkCheck = body.indexOf("!applied.ok");
    const notifyIdx = body.indexOf("notifyConnectionAuthRestored");
    expect(appliedOkCheck).toBeGreaterThan(-1);
    expect(appliedOkCheck).toBeLessThan(notifyIdx);
    const afterFailCheck = body.slice(appliedOkCheck, notifyIdx);
    expect(afterFailCheck).toContain("return");
  });

  it("shows error message when apply fails, not success", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    const appliedOkIdx = body.indexOf("!applied.ok");
    if (appliedOkIdx > -1) {
      const failBlock = body.slice(appliedOkIdx, body.indexOf("return", appliedOkIdx) + 10);
      expect(failBlock).toContain('"error"');
      expect(failBlock).not.toContain('"登录成功"');
    }
  });

  it("uses single-link payload (no backup fields)", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).not.toContain("remoteBackupUrl");
    expect(body).not.toContain("target");
    expect(body).not.toContain("backup");
  });

  it("saves config before calling password login", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    const saveIdx = body.indexOf("saveConnectionConfig");
    const loginIdx = body.indexOf("connectionPasswordLogin({");
    expect(saveIdx).toBeGreaterThan(-1);
    expect(loginIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(loginIdx);
  });

  it("pwPass is cleared after successful login", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain('setPwPass("")');
    const okCheck = body.indexOf("r.ok");
    const clearPass = body.indexOf('setPwPass("")');
    expect(okCheck).toBeGreaterThan(-1);
    expect(clearPass).toBeGreaterThan(okCheck);
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

  it("uses single-link payload (no backup fields)", () => {
    const body = functionBody("handleOauthLogin", "handlePasswordLogin");
    expect(body).not.toContain("remoteBackupUrl");
    expect(body).not.toContain("backup");
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

describe("Single-link connection", () => {
  it("no backup/failover references remain in the source", () => {
    expect(source).not.toContain("remoteBackupUrl");
    expect(source).not.toContain("backupTokenInput");
    expect(source).not.toContain("backupProbeStatus");
    expect(source).not.toContain("backupAuthProviders");
    expect(source).not.toContain("backupGated");
    expect(source).not.toContain("backupNeedsLogin");
    expect(source).not.toContain("normalizeRemoteUrl");
    expect(source).not.toContain("failoverActive");
    expect(source).not.toContain("activeRemote");
    expect(source).not.toContain("connection-failover");
  });

  it("submit payload only sends single-link fields", () => {
    const submitBody = functionBody("submit", "handleOpenBrowser");
    expect(submitBody).toContain("remoteUrl");
    expect(submitBody).toContain("remoteToken");
    expect(submitBody).toContain("remoteAuthMode");
    expect(submitBody).not.toContain("remoteBackupUrl");
    expect(submitBody).not.toContain("remoteBackupToken");
  });
});

describe("QuickStart removal", () => {
  const panelSource = readFileSync(
    resolve(import.meta.dirname ?? __dirname, "panel.tsx"),
    "utf-8",
  );
  it("panel.tsx does not import QuickStart", () => {
    expect(panelSource).not.toContain("quick-start");
    expect(panelSource).not.toContain("QuickStart");
  });

  it("panel.tsx does not render a QuickStart section", () => {
    expect(panelSource).not.toContain('"快速起手"');
    expect(panelSource).not.toContain('"模板"');
  });
});
