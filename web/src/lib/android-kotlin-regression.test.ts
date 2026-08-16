import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

function section(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  expect(end, `missing source marker: ${endMarker ?? "<end>"}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Kotlin Android runtime configuration contracts", () => {
  it("loads the persisted connection before building get_runtime_config and runtime_info", () => {
    const source = read("android/app/src/main/java/cn/org/hermesagent/mobile/core/RuntimeConfig.kt");
    const getRuntimeConfig = section(
      source,
      '            "get_runtime_config" -> {',
      '            "runtime_info", "get_runtime_info" -> {',
    );
    const runtimeInfo = section(
      source,
      '            "runtime_info", "get_runtime_info" -> {',
      '            "get_desktop_control_state" -> {',
    );

    for (const branch of [getRuntimeConfig, runtimeInfo]) {
      const loadIndex = branch.indexOf("connectionStore.load()");
      const responseIndex = branch.indexOf("cb(JSONObject()");
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeLessThan(responseIndex);
      expect(branch).not.toContain("connectionStore.currentConfig()");
    }

    expect(runtimeInfo).toContain('.put("remoteUrl", c.remoteUrl)');
  });
});

describe("Kotlin Android session foreground update contract", () => {
  const source = read(
    "android/app/src/main/java/cn/org/hermesagent/mobile/notify/SessionForegroundService.kt",
  );
  const bridge = section(source, "class SessionForegroundBridge");

  it("registers session_foreground_update and validates its state", () => {
    const commands = section(bridge, "override fun commands()", "override fun handle");
    expect(commands).toContain('"session_foreground_update"');

    const updateHandler = section(
      bridge,
      '            "session_foreground_update" -> {',
      "            else -> {",
    );
    expect(updateHandler).toContain("VALID_UPDATE_STATES");
    expect(updateHandler).toContain("state");
  });

  it("invokes SessionForegroundService.update for a valid update", () => {
    const updateHandler = section(
      bridge,
      '            "session_foreground_update" -> {',
      "            else -> {",
    );
    expect(updateHandler).toContain("SessionForegroundService.update(context");
    expect(updateHandler).toMatch(/SessionForegroundService\.update\([\s\S]*state[\s\S]*\)/);
  });
});

describe("Web bridge and chat contracts for Kotlin session foreground updates", () => {
  it("exposes terminal states and sessionForegroundUpdate through the runtime surface", () => {
    const source = read("web/src/lib/runtime.ts");
    const input = section(
      source,
      "export interface AndroidSessionForegroundInput",
      "export interface AndroidSessionForegroundResult",
    );
    const desktopBridge = section(
      source,
      "sessionForegroundStart?",
      "terminalStart?",
    );

    expect(input).toContain('"completed"');
    expect(input).toContain('"failed"');
    expect(desktopBridge).toContain("sessionForegroundUpdate?");
  });

  it("maps sessionForegroundUpdate to the Kotlin command in tauri-bridge", () => {
    const source = read("web/src/lib/tauri-bridge.ts");
    const foregroundMethods = section(
      source,
      "async sessionForegroundStart",
      "async terminalStart",
    );

    expect(foregroundMethods).toMatch(
      /async sessionForegroundUpdate\(input: AndroidSessionForegroundInput\)/,
    );
    expect(foregroundMethods).toContain(
      'invokeCommand("session_foreground_update", { input })',
    );
  });

  it("provides an Android foreground update adapter", () => {
    const source = read("web/src/lib/android-session-foreground.ts");
    const update = section(
      source,
      "export async function updateAndroidSessionForeground",
      "export async function stopAndroidSessionForeground",
    );

    expect(update).toContain("runtime.androidRemoteOnly");
    expect(update).toContain("sessionForegroundUpdate");
    expect(update).toContain("window.hermesDesktop.sessionForegroundUpdate(input)");
  });

  it("publishes completed and failed foreground states from chat terminal events", () => {
    const source = read("web/src/stores/chat.ts");
    const terminal = section(
      source,
      'if (event.type === "message.complete" || event.type === "error") {',
      "  // 通知决策需要 reduce 前的快照",
    );

    expect(source).toContain("updateAndroidSessionForeground");
    expect(terminal).toContain("updateAndroidSessionForeground");
    expect(terminal).toMatch(/message\.complete[\s\S]*completed/);
    expect(terminal).toMatch(/error[\s\S]*failed/);
  });
});
