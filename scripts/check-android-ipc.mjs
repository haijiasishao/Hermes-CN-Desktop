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

if (missingRequired.length > 0 || unclassified.length > 0) {
  if (missingRequired.length > 0) console.error(`Missing required Remote commands: ${missingRequired.join(", ")}`);
  if (unclassified.length > 0) console.error(`Unclassified bridge commands: ${unclassified.join(", ")}`);
  process.exit(1);
}

console.log("Android IPC audit passed");
