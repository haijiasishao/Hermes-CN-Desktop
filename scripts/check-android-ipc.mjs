#!/usr/bin/env node
/**
 * Verify the Android Remote-only Tauri IPC boundary.
 *
 * Every command used by the Tauri bridge must either be registered in the
 * Android generate_handler list or be explicitly removed from the bridge for
 * Android Remote mode. This prevents runtime "Command ... not found" errors.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const bridgePath = path.join(root, "web/src/lib/tauri-bridge.ts");
const libPath = path.join(root, "src/lib.rs");
const bridge = fs.readFileSync(bridgePath, "utf8");
const lib = fs.readFileSync(libPath, "utf8");

const invokeCommands = new Set();
const invokePattern = /\b(?:invokeCommand|inv)\s*(?:<[^;()]+>)?\s*\(\s*["']([^"']+)["']/g;
for (const match of bridge.matchAll(invokePattern)) invokeCommands.add(match[1]);

const registeredCommands = new Set();
const registrationPattern = /commands::[A-Za-z0-9_]+::([A-Za-z0-9_]+)/g;
for (const match of lib.matchAll(registrationPattern)) registeredCommands.add(match[1]);

// These commands belong to desktop-only local runtime/process/filesystem
// features. Their bridge methods are removed after Android Remote bootstrap so
// optional UI capability checks render a clear unsupported state instead of
// invoking a missing Tauri command.
const androidUnsupportedCommands = new Set([
  "backup_export_profile",
  "backup_import_profile",
  "coding_agents_check",
  "config_migration_import",
  "config_migration_scan",
  "create_workspace_project",
  "desktop_check_update",
  "environment_check",
  "get_yolo_mode",
  "git_branch_list",
  "git_branch_switch",
  "git_repo_status",
  "git_review_commit",
  "git_review_commit_context",
  "git_review_create_pr",
  "git_review_diff",
  "git_review_list",
  "git_review_push",
  "git_review_rev_parse",
  "git_review_revert",
  "git_review_ship_info",
  "git_review_stage",
  "git_review_unstage",
  "git_worktree_add",
  "git_worktree_list",
  "git_worktree_remove",
  "im_onboarding_apply",
  "im_onboarding_begin",
  "im_onboarding_poll",
  "im_onboarding_state",
  "managed_runtime_install",
  "managed_runtime_reinstall",
  "managed_runtime_start",
  "managed_runtime_stop",
  "managed_runtime_uninstall",
  "open_browser_companion",
  "read_workspace_file",
  "runtime_check_update",
  "runtime_install_update",
  "runtime_rollback",
  "stop_preview_file_watch",
  "terminal_close",
  "terminal_open_external",
  "terminal_resize",
  "terminal_start",
  "terminal_write",
  "watch_preview_file",
  "write_workspace_file",
]);

const requiredRemoteCommands = [
  "get_runtime_config",
  "get_connection_config",
  "save_connection_config",
  "probe_connection_config",
  "test_connection_config",
  "apply_connection_config",
  "connection_oauth_login",
  "connection_password_login",
  "connection_auth_me",
  "connection_oauth_logout",
  "api_request",
  "external_request",
  "upload_file",
  "download_external_image",
  "gateway_ws_open",
  "gateway_ws_send",
  "gateway_ws_close",
  "switch_profile",
  "runtime_info",
  "get_desktop_control_state",
  "set_guide_state",
];

const missing = [...invokeCommands].filter((command) => !registeredCommands.has(command));
const unclassified = missing.filter((command) => !androidUnsupportedCommands.has(command));
const missingRequired = requiredRemoteCommands.filter((command) => !registeredCommands.has(command));

console.log(`bridge_commands=${invokeCommands.size}`);
console.log(`registered_commands=${registeredCommands.size}`);
console.log(`explicit_android_unsupported=${androidUnsupportedCommands.size}`);
console.log(`missing_registered_commands=${missing.length}`);
for (const command of missing) console.log(`  ${androidUnsupportedCommands.has(command) ? "unsupported" : "UNCLASSIFIED"} ${command}`);


// --- Android compile-boundary audit ---
// Verify that desktop-only modules are gated behind #[cfg(feature = "desktop")].
// This prevents accidental compilation of source modules that are proven
// desktop-only and not registered in the Android Tauri IPC handler.
const compileBoundaryChecks = [
  {
    file: "src/commands/mod.rs",
    modules: ["environment", "git"],
  },
  {
    file: "src/lib.rs",
    modules: ["environment", "env_file", "path_resolver"],
  },
];

let compileBoundaryFailed = false;
for (const { file, modules } of compileBoundaryChecks) {
  const filePath = path.join(root, file);
  const content = fs.readFileSync(filePath, "utf8");
  for (const mod of modules) {
    // Match the cfg gate immediately preceding `pub mod <name>;`
    const pattern = new RegExp(
      '#\\[cfg\\(feature\\s*=\\s*"desktop"\\)\\]\\s*pub\\s+mod\\s+' + mod + '\\s*;',
    );
    if (!pattern.test(content)) {
      console.error(
        `Compile-boundary violation: ${file} — pub mod ${mod} is not gated behind #[cfg(feature = "desktop")]`,
      );
      compileBoundaryFailed = true;
    }
  }
}
if (compileBoundaryFailed) {
  process.exit(1);
}
console.log("Android compile-boundary audit passed");
// --- Android Cargo dependency boundary audit ---
// Verify that desktop-only crate dependencies are declared optional and
// activated exclusively through the "desktop" feature.  This prevents the
// Android build from pulling in crates that are only needed by
// desktop-gated modules (browser_companion, env_file, etc.).
const cargoPath = path.join(root, "Cargo.toml");
const cargo = fs.readFileSync(cargoPath, "utf8");

const desktopOnlyDeps = ["bytes", "dotenvy", "getrandom", "http-body-util", "hyper", "hyper-util"];

// Extract the desktop feature value.
const desktopFeatureMatch = cargo.match(/^desktop\s*=\s*\[([^\]]*)\]/m);
const desktopFeatureValue = desktopFeatureMatch ? desktopFeatureMatch[1] : "";

let depAuditFailed = false;
for (const dep of desktopOnlyDeps) {
  // Check optional flag in [dependencies] — match either inline table or
  // dotted-key form.
  const depPattern = new RegExp(
    `^${dep}\\s*=\\s*(?:\\{[^}]*optional\\s*=\\s*true|\\{[^}]*\\}|"[^"]*")`,
    "m",
  );
  const optionalPattern = new RegExp(
    `^${dep}\\s*=\\s*\\{[^}]*optional\\s*=\\s*true`,
    "m",
  );
  if (!depPattern.test(cargo)) {
    console.error(`Dependency boundary violation: ${dep} is not declared in [dependencies]`);
    depAuditFailed = true;
  } else if (!optionalPattern.test(cargo)) {
    console.error(`Dependency boundary violation: ${dep} must be declared optional (optional = true)`);
    depAuditFailed = true;
  }

  // Check dep: activation in the desktop feature list.
  if (!desktopFeatureValue.includes(`"dep:${dep}"`)) {
    console.error(
      `Dependency boundary violation: dep:${dep} is missing from the "desktop" feature list`,
    );
    depAuditFailed = true;
  }
}

if (depAuditFailed) {
  process.exit(1);
}
console.log(`Cargo dependency boundary audit passed (${desktopOnlyDeps.length} deps verified)`);


// --- Android build-surface audit ---
// The notification plugin and the notify commands (desktop_notify /
// notification_permission) only compile under the "android" cargo feature
// (src/lib.rs, src/commands/mod.rs).  Tauri does NOT select that feature
// automatically: an APK built without `--features android` registers none of
// them and the settings page fails at runtime with
// "command_desktop_notify not found".  Fail here — this audit runs before the
// APK build step — instead of publishing an APK missing commands.
const androidWorkflowPath = path.join(root, ".github/workflows/android-build.yml");
const androidWorkflow = fs.readFileSync(androidWorkflowPath, "utf8");
const androidBuildCommands = androidWorkflow
  .split("\n")
  .filter((line) => line.includes("tauri android build") && !line.trim().startsWith("#"));

let buildSurfaceFailed = false;
if (androidBuildCommands.length === 0) {
  console.error(
    "Build-surface violation: no `tauri android build` command found in .github/workflows/android-build.yml",
  );
  buildSurfaceFailed = true;
}
for (const command of androidBuildCommands) {
  if (!/--features[\s=]android\b/.test(command)) {
    console.error(
      `Build-surface violation: \`${command.trim()}\` must pass --features android ` +
        "(the notification plugin and notify commands are cfg-gated behind it)",
    );
    buildSurfaceFailed = true;
  }
}
if (buildSurfaceFailed) {
  process.exit(1);
}
console.log(`android_build_commands=${androidBuildCommands.length} (all pass --features android)`);


// --- Android manifest audit ---
const manifestPath = path.join(root, "gen/android/app/src/main/AndroidManifest.xml");
const manifest = fs.readFileSync(manifestPath, "utf8");
const requiredPermissions = [
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
];
const missingPermissions = requiredPermissions.filter((perm) => !manifest.includes(perm));
if (missingPermissions.length > 0) {
  for (const perm of missingPermissions) {
    console.error(`Missing required Android permission in manifest: ${perm}`);
  }
  process.exit(1);
}
// usesCleartextTraffic=true is required for Remote Dashboard LAN HTTP access.
// Without it, WebView media/file download links served over HTTP will fail with
// net::ERR_CLEARTEXT_NOT_PERMITTED on Android 9+.
const cleartextPattern = /android:usesCleartextTraffic\s*=\s*"true"/;
if (!cleartextPattern.test(manifest)) {
  console.error(
    'Missing android:usesCleartextTraffic="true" in AndroidManifest.xml. ' +
    "Remote Dashboard uses LAN HTTP; WebView needs cleartext to load MEDIA file links.",
  );
  process.exit(1);
}
console.log(`manifest_permissions=${requiredPermissions.length} (all present)`);
console.log("manifest_cleartext=true");

// --- Phase-0 foreground-service boundary audit ---
const fgsPermissions = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
];
for (const permission of fgsPermissions) {
  const declarationPattern = new RegExp(
    `<uses-permission\\s+android:name=["']${permission.replaceAll(".", "\\.")}['"]\\s*/>`,
    "g",
  );
  const declarationCount = manifest.match(declarationPattern)?.length ?? 0;
  if (declarationCount !== 1) {
    console.error(
      `Foreground service permission must be declared exactly once: ${permission} (found ${declarationCount})`,
    );
    process.exit(1);
  }
}
const foregroundServiceDeclarations = manifest.match(
  /<service\b[^>]*android:name=["']\.SessionForegroundService["'][^>]*>/g,
);
if (foregroundServiceDeclarations?.length !== 1 ||
    !foregroundServiceDeclarations[0].includes('android:exported="false"') ||
    !foregroundServiceDeclarations[0].includes('android:foregroundServiceType="dataSync"')) {
  console.error("Missing non-exported dataSync SessionForegroundService declaration");
  process.exit(1);
}
const phase0AndroidWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/android-build.yml"),
  "utf8",
);
const android36Count = phase0AndroidWorkflow.match(/platforms;android-36/g)?.length ?? 0;
if (android36Count !== 1) {
  console.error(`Android SDK platform android-36 must be listed exactly once (found ${android36Count})`);
  process.exit(1);
}
const gradle = fs.readFileSync(path.join(root, "gen/android/app/build.gradle.kts"), "utf8");
if (!/androidx\.core:core-ktx:/.test(gradle)) {
  console.error("Missing explicit AndroidX Core dependency for ServiceCompat");
  process.exit(1);
}
const foregroundRust = fs.readFileSync(path.join(root, "src/commands/session_foreground.rs"), "utf8");
for (const command of ["session_foreground_start", "session_foreground_stop"]) {
  if (!foregroundRust.includes(command)) {
    console.error(`Missing foreground diagnostic command: ${command}`);
    process.exit(1);
  }
}
if (/log::(?:debug|info|warn|error)!\([^\n]*(?:token|cookie|prompt|response|url)/i.test(foregroundRust)) {
  console.error("Foreground diagnostic logging may expose sensitive data");
  process.exit(1);
}
for (const forbidden of ["reqwest::Client", "bearer_auth", "authenticated_sessions_probe"]) {
  if (foregroundRust.includes(forbidden)) {
    console.error(`Foreground probe must use shared api proxy; found forbidden ${forbidden}`);
    process.exit(1);
  }
}
for (const required of [
  '"/api/sessions?limit=1&offset=0"',
  "api_request_from_state",
  "plugin_unavailable",
  "MAX_PLUGIN_UPDATE_FAILURES",
]) {
  if (!foregroundRust.includes(required)) {
    console.error(`Missing safe foreground monitor contract: ${required}`);
    process.exit(1);
  }
}
const foregroundPlugin = fs.readFileSync(
  path.join(root, "gen/android/app/src/main/java/cn/org/hermesagent/mobile/SessionForegroundPlugin.kt"),
  "utf8",
);
const foregroundService = fs.readFileSync(
  path.join(root, "gen/android/app/src/main/java/cn/org/hermesagent/mobile/SessionForegroundService.kt"),
  "utf8",
);
for (const required of [
  "EXTRA_SESSION_ID",
  "EXTRA_TIMESTAMP",
  'args.action in setOf("start", "update", "stop")',
  'args.state in setOf("starting", "connected", "probe_failed", "stopped")',
]) {
  if (!foregroundPlugin.includes(required)) {
    console.error(`Missing safe Kotlin plugin contract: ${required}`);
    process.exit(1);
  }
}
const actionBranches = ["start", "update", "stop"].map((action) => {
  const marker = `"${action}" ->`;
  const start = foregroundPlugin.indexOf(marker);
  const next = ["start", "update", "stop"]
    .map((candidate) => foregroundPlugin.indexOf(`"${candidate}" ->`, start + marker.length))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? foregroundPlugin.length;
  if (start < 0) {
    console.error(`Missing explicit Kotlin foreground action branch: ${action}`);
    process.exit(1);
  }
  return [action, foregroundPlugin.slice(start, next)];
});
const branchText = new Map(actionBranches);
if (!branchText.get("start")?.includes("ContextCompat.startForegroundService(activity, intent)")) {
  console.error("Foreground start must use ContextCompat.startForegroundService");
  process.exit(1);
}
if (!branchText.get("update")?.includes("activity.startService(intent)")) {
  console.error("Foreground update must use activity.startService");
  process.exit(1);
}
if (!branchText.get("stop")?.includes("activity.startService(intent)")) {
  console.error("Foreground stop must use activity.startService");
  process.exit(1);
}
if (branchText.get("start")?.includes("activity.startService(intent)")) {
  console.error("Foreground start must not use activity.startService");
  process.exit(1);
}
if (branchText.get("update")?.includes("ContextCompat.startForegroundService(activity, intent)")) {
  console.error("Foreground update must not use ContextCompat.startForegroundService");
  process.exit(1);
}
if (branchText.get("stop")?.includes("ContextCompat.startForegroundService(activity, intent)")) {
  console.error("Foreground stop must not use ContextCompat.startForegroundService");
  process.exit(1);
}
if (/if\s*\(\s*stopping\s*\)[\s\S]*?else\s+ContextCompat\.startForegroundService/.test(foregroundPlugin)) {
  console.error("Foreground actions must not merge stop/startForegroundService branches");
  process.exit(1);
}
if (foregroundPlugin.includes("activity.stopService")) {
  console.error("Foreground stop must go through service ACTION_STOP");
  process.exit(1);
}
for (const required of [
  "onCreate",
  "onStartCommand",
  "onTaskRemoved",
  "onDestroy",
  "onTimeout",
  "ServiceCompat.stopForeground",
  "Log.i",
  "START_NOT_STICKY",
]) {
  if (!foregroundService.includes(required)) {
    console.error(`Missing safe Kotlin service contract: ${required}`);
    process.exit(1);
  }
}
if (foregroundService.includes("EXTRA_TITLE") || /getStringExtra\(EXTRA_TITLE\)/.test(foregroundService)) {
  console.error("Foreground diagnostic service must keep a fixed title");
  process.exit(1);
}
console.log("foreground_service_boundary=dataSync/non-exported/safe-bridge");

if (missingRequired.length > 0 || unclassified.length > 0) {
  if (missingRequired.length > 0) console.error(`Missing required Remote commands: ${missingRequired.join(", ")}`);
  if (unclassified.length > 0) console.error(`Unclassified bridge commands: ${unclassified.join(", ")}`);
  process.exit(1);
}

console.log("Android IPC audit passed");
