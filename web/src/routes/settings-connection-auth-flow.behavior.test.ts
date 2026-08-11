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

describe("Backup login flow", () => {
  it("handlePasswordLogin accepts a target parameter (primary or backup)", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain('target: "primary"');
    expect(body).toContain('target === "backup"');
  });

  it("backup login uses remoteBackupUrl as loginUrl and saves config first", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain("remoteBackupUrl.trim()");
    // Must save config before login so persist_backup_login can match URL.
    expect(body).toContain("saveConnectionConfig");
  });

  it("backup login also calls applyConnectionConfig to establish failover", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    // Both primary and backup logins should call applyConnectionConfig
    // to establish the live failover state immediately.
    expect(body).toContain("applyConnectionConfig");
    expect(body).toContain("applyPayload");
  });

  it("backup login refreshes config to update remoteBackupSessionSet", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain("getConnectionConfig");
  });

  it("backup login saves connection config before calling password login", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    // The saveConnectionConfig call must appear before the actual
    // connectionPasswordLogin invocation (with arguments), not the guard check.
    const saveIdx = body.indexOf("saveConnectionConfig");
    const loginIdx = body.indexOf("connectionPasswordLogin({");
    expect(saveIdx).toBeGreaterThan(-1);
    expect(loginIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(loginIdx);
  });

  it("primary login passes remoteBackupUrl to applyConnectionConfig", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    expect(body).toContain("remoteBackupUrl.trim()");
    expect(body).toContain("applyPayload");
  });

  it("pwPass is cleared after successful login (inside r.ok branch)", () => {
    const body = functionBody("handlePasswordLogin", "handleLogout");
    // setPwPass("") must be called on the success path, before target-specific logic
    expect(body).toContain('setPwPass("")');
    // It must appear inside the r.ok block (after the r.ok check)
    const okCheck = body.indexOf("r.ok");
    const clearPass = body.indexOf('setPwPass("")');
    expect(okCheck).toBeGreaterThan(-1);
    expect(clearPass).toBeGreaterThan(okCheck);
  });
});

describe("Backup session validation", () => {
  it("blocks save when backup URL is set but no backup session exists", () => {
    expect(source).toContain("backupNeedsLogin");
    expect(source).toContain("已填写备用地址但尚未登录");
  });

  it("backupNeedsLogin checks gated, backupUrl, session, and normalized URL match", () => {
    expect(source).toContain("backupNeedsLogin");
    expect(source).toContain("normalizeRemoteUrl");
    expect(source).toContain("remoteBackupUrl");
    expect(source).toContain("remoteBackupSessionSet");
  });
});

describe("Backup probe and auth gate", () => {
  it("probes the backup URL independently of the primary URL", () => {
    expect(source).toContain("backupProbeStatus");
    expect(source).toContain("backupProbeSeq");
    expect(source).toContain("trimmedBackupUrl");
    expect(source).toContain("probeConnectionConfig?.(trimmedBackupUrl)");
  });

  it("keeps backup auth providers separate from primary providers", () => {
    expect(source).toContain("backupAuthProviders");
    expect(source).toContain("const backupGated");
    expect(source).toContain("{backupGated && trimmedBackupUrl &&");
  });

  it("shows the backup login gate even when primary probe is unavailable", () => {
    const backupBlock = source.slice(source.indexOf("{backupGated && trimmedBackupUrl &&"));
    expect(backupBlock).toContain("backupAuthProviders");
    expect(backupBlock).toContain('handlePasswordLogin(p.name, "backup")');
    expect(backupBlock).not.toContain("authProviders.map");
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
