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
  "desktop_notify",
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

if (missingRequired.length > 0 || unclassified.length > 0) {
  if (missingRequired.length > 0) console.error(`Missing required Remote commands: ${missingRequired.join(", ")}`);
  if (unclassified.length > 0) console.error(`Unclassified bridge commands: ${unclassified.join(", ")}`);
  process.exit(1);
}

console.log("Android IPC audit passed");
