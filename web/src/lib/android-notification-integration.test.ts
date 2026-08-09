import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname ?? __dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf-8");

describe("Android native notification integration", () => {
  it("enables and initializes the Tauri notification plugin for Android", () => {
    const cargo = read("Cargo.toml");
    expect(cargo).toMatch(/android\s*=\s*\[[^\]]*"dep:tauri-plugin-notification"/s);
    expect(cargo).toContain('tauri-plugin-notification = { version = "2", optional = true }');
    expect(read("src/lib.rs")).toContain("tauri_plugin_notification::init()");
    expect(read("src/commands/mod.rs")).toMatch(/cfg\(any\(feature = "desktop", feature = "android"\)\)[\s\S]*pub mod notify/);
    expect(read("gen/android/app/src/main/AndroidManifest.xml")).toContain(
      "android.permission.POST_NOTIFICATIONS",
    );
  });

  it("registers native notify and explicit permission commands in the Android handler", () => {
    const lib = read("src/lib.rs");
    expect(lib).toContain("commands::notify::desktop_notify");
    expect(lib).toContain("commands::notify::notification_permission");
    const notify = read("src/commands/notify.rs");
    expect(notify).toContain(".permission_state()");
    expect(notify).toContain(".request_permission()");
    expect(notify).toContain("hermes-agent-silent");
    expect(notify).toContain("Importance::Low");
  });

  it("exposes permission IPC through the web bridge", () => {
    expect(read("web/src/lib/runtime.ts")).toContain("notificationPermission?");
    expect(read("web/src/lib/tauri-bridge.ts")).toContain('invokeCommand("notification_permission"');
  });

  it("uses Android-specific notification permission copy in settings", () => {
    const settings = read("web/src/routes/settings.tsx");
    expect(settings).toContain("Android 通知权限");
    expect(settings).toContain("notificationPermission");
  });
});

describe("Android visible app name", () => {
  it("uses Hermes Agent without changing the application identifier", () => {
    const tauriConfig = JSON.parse(read("tauri.conf.json"));
    expect(tauriConfig.productName).toBe("Hermes Agent");
    expect(tauriConfig.app.windows[0].title).toBe("Hermes Agent");
    const strings = read("gen/android/app/src/main/res/values/strings.xml");
    expect(strings).toContain('<string name="app_name">Hermes Agent</string>');
    expect(strings).toContain('<string name="main_activity_title">Hermes Agent</string>');
    expect(tauriConfig.identifier).toBe("cn.org.hermesagent.mobile");
  });
});
