import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Android phase-0 foreground session diagnostic contract", () => {
  it("declares a non-exported dataSync foreground service and both permissions", () => {
    const manifest = read("gen/android/app/src/main/AndroidManifest.xml");
    expect(manifest.match(/<uses-permission\s+android:name="android\.permission\.FOREGROUND_SERVICE"\s*\/>/g)).toHaveLength(1);
    expect(manifest.match(/<uses-permission\s+android:name="android\.permission\.FOREGROUND_SERVICE_DATA_SYNC"\s*\/>/g)).toHaveLength(1);
    expect(manifest).toMatch(
      /<service[\s\S]*android:exported="false"[\s\S]*android:foregroundServiceType="dataSync"/,
    );
    expect(manifest.match(/<service\b[^>]*android:name="\.SessionForegroundService"[^>]*>/g)).toHaveLength(1);
  });

  it("uses an explicit AndroidX Core dependency and installs Android 36 in CI", () => {
    expect(read("gen/android/app/build.gradle.kts")).toMatch(
      /implementation\(["']androidx\.core:core-ktx:/,
    );
    expect(read(".github/workflows/android-build.yml").match(/platforms;android-36/g)).toHaveLength(1);
  });

  it("has a Rust command, plugin registration, and safe monitor boundary", () => {
    const rust = read("src/commands/session_foreground.rs");
    const lib = read("src/lib.rs");
    expect(rust).toContain("session_foreground_start");
    expect(rust).toContain("session_foreground_stop");
    expect(rust).toContain("run_mobile_plugin_async");
    expect(rust).toContain("api_request_from_state");
    expect(rust).toContain("plugin_unavailable");
    expect(rust).toContain("heartbeat");
    expect(rust).not.toMatch(/prompt|assistant text|Cookie|token.*log/i);
    expect(lib).toContain("commands::session_foreground::session_foreground_start");
    expect(lib).toContain("commands::session_foreground::session_foreground_stop");
  });

  it("carries only the diagnostic session contract through Kotlin and rejects unsafe actions/states", () => {
    const plugin = read("gen/android/app/src/main/java/cn/org/hermesagent/mobile/SessionForegroundPlugin.kt");
    const service = read("gen/android/app/src/main/java/cn/org/hermesagent/mobile/SessionForegroundService.kt");
    expect(plugin).toContain('putExtra(SessionForegroundService.EXTRA_SESSION_ID');
    expect(plugin).toContain('putExtra(SessionForegroundService.EXTRA_TIMESTAMP');
    expect(plugin).toContain('ACTION_STOP');
    expect(plugin).toContain('ContextCompat.startForegroundService(activity, intent)');
    expect(plugin).not.toContain("activity.stopService");
    expect(plugin).toMatch(/START|UPDATE|STOP/);
    expect(service).toContain("onCreate");
    expect(service).toContain("onStartCommand");
    expect(service).toContain("onTaskRemoved");
    expect(service).toContain("onDestroy");
    expect(service).toContain("onTimeout");
    expect(service).toContain("ServiceCompat.stopForeground");
    expect(service).toContain("Log.i");
    expect(service).not.toContain("$title");
    expect(service).not.toContain("$prompt");
    expect(service).not.toContain("$url");
  });

  it("stops the diagnostic service on gateway terminal events and manual interrupt", async () => {
    const chat = read("web/src/stores/chat.ts");
    expect(chat).toContain("stopAndroidSessionForeground");
    expect(chat).toMatch(/message\.complete[\s\S]{0,500}stopAndroidSessionForeground/);
    expect(chat).toMatch(/event\.type === "error"[\s\S]{0,500}stopAndroidSessionForeground/);
    expect(chat).toMatch(/markSessionInterruptedAtom[\s\S]{0,500}stopAndroidSessionForeground/);
    expect(chat).toContain("resolvePersistentSessionId");
  });

  it("keeps the Web adapter typed and starts before sendPrompt", () => {
    const bridge = read("web/src/lib/tauri-bridge.ts");
    const adapter = read("web/src/lib/android-session-foreground.ts");
    const submit = read("web/src/hooks/use-create-and-send-session.ts");
    expect(bridge).toContain("sessionForegroundStart");
    expect(bridge).toContain("sessionForegroundStop");
    expect(adapter).toContain("androidRemoteOnly");
    expect(adapter).toContain("recordNotificationDebug");
    expect(submit).not.toMatch(/void\s+startAndroidSessionForeground\s*\(/);
    const tryStart = submit.match(
      /try\s*\{\s*await\s+startAndroidSessionForeground\s*\(/,
    );
    expect(tryStart).not.toBeNull();
    const start = tryStart ? submit.indexOf("await startAndroidSessionForeground", tryStart.index) : -1;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(
      submit.indexOf("sendPrompt(sessionId"),
    );
    const startCall = submit.slice(start, submit.indexOf("});", start) + 3);
    expect(startCall).toContain("persistentSessionId: sessionId");
    expect(startCall).toContain('title: "后台链路诊断"');
    expect(startCall).toContain("timestampMs: submittedAt");
  });
});
