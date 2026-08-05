// Runtime inspection commands.
//
// Desktop builds re-export the full runtime_manager::runtime_info.
// Android (remote-only) builds have no managed runtime, but the frontend's
// useRuntimeInfo()/status bar still invoke `runtime_info` for diagnostics —
// provide a minimal, always-available response instead of a missing-command
// IPC error.

#[cfg(feature = "desktop")]
pub use crate::commands::runtime_manager::{
    runtime_info, __cmd__runtime_info, __tauri_command_name_runtime_info,
};

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn runtime_info(state: tauri::State<'_, crate::state::AppState>) -> crate::error::AppResult<crate::android_compat::RuntimeInfo> {
    let last_error = state.inner.lock()?.last_runtime_error.clone();
    Ok(crate::android_compat::get_runtime_info(last_error))
}
