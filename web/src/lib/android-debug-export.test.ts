import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname ?? __dirname, "../../..");
const rustSource = readFileSync(
  resolve(projectRoot, "src/commands/debug_bundle.rs"),
  "utf-8",
);
const routeSource = readFileSync(
  resolve(projectRoot, "web/src/routes/debug.tsx"),
  "utf-8",
);
const bridgeSource = readFileSync(
  resolve(projectRoot, "web/src/lib/tauri-bridge.ts"),
  "utf-8",
);
const runtimeSource = readFileSync(
  resolve(projectRoot, "web/src/lib/runtime.ts"),
  "utf-8",
);
const nativePluginPath = resolve(
  projectRoot,
  "gen/android/app/src/main/java/cn/org/hermesagent/mobile/DebugExportPlugin.kt",
);
const nativePluginSource = existsSync(nativePluginPath)
  ? readFileSync(nativePluginPath, "utf-8")
  : "";
const rustPluginSource = readFileSync(
  resolve(projectRoot, "src/commands/debug_export.rs"),
  "utf-8",
);
const appSource = readFileSync(resolve(projectRoot, "src/lib.rs"), "utf-8");

describe("Android debug bundle export contract", () => {
  it("uses an explicit filesystem-safe cache directory on Android", () => {
    expect(rustSource).toMatch(
      /#\[cfg\(target_os = "android"\)\][\s\S]{0,600}app_cache_dir\(\)[\s\S]{0,600}hermes-debug-reports/,
    );
    expect(rustSource).toContain("hermes-debug-reports");
  });

  it("provides a native Android save plugin backed by ACTION_CREATE_DOCUMENT", () => {
    expect(nativePluginSource).toContain("@TauriPlugin");
    expect(nativePluginSource).toContain("ACTION_CREATE_DOCUMENT");
    expect(nativePluginSource).toContain("openOutputStream");
    expect(nativePluginSource).toContain("cacheDir");
    expect(nativePluginSource).toContain("canonicalFile");
  });

  it("registers the native plugin and application save command", () => {
    expect(rustPluginSource).toContain('Builder::new("debug-export")');
    expect(rustPluginSource).toContain("register_android_plugin");
    expect(rustPluginSource).toContain("pub async fn save_debug_bundle");
    expect(appSource).toContain("commands::debug_export::save_debug_bundle");
  });

  it("routes Android export through the native save flow", () => {
    expect(routeSource).toContain("androidRemoteOnly");
    expect(routeSource).toContain("saveDebugBundle");
    expect(bridgeSource).toContain('invokeCommand("save_debug_bundle"');
    expect(bridgeSource).not.toContain("plugin:debug-export");
    expect(runtimeSource).toContain("SaveDebugBundle");
  });

  it("does not present the private zipPath as the Android destination", () => {
    expect(routeSource).toMatch(/androidRemoteOnly/);
    expect(routeSource).toMatch(/androidRemoteOnly[\s\S]{0,1200}saveDebugBundle/);
    expect(routeSource).not.toMatch(
      /androidRemoteOnly[\s\S]{0,1200}zipPath[^\n]*已导出到|已导出到[^\n]*zipPath/,
    );
  });
});
