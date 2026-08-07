// Runtime inspection and guide-state commands.
//
// Desktop builds re-export the full runtime_manager commands.
// Android (remote-only) builds have no managed runtime, but the frontend still
// invokes runtime_info/get_desktop_control_state/set_guide_state while the
// connection guide completes. Provide compatible, no-local-runtime commands
// instead of allowing a missing-command IPC error to block remote connection.

#[cfg(not(feature = "desktop"))]
use serde::{Deserialize, Serialize};

#[cfg(feature = "desktop")]
pub use crate::commands::runtime_manager::{
    get_desktop_control_state, runtime_info, set_guide_state, RuntimeControlResult,
    SetGuideStateInput, __cmd__get_desktop_control_state, __cmd__runtime_info,
    __cmd__set_guide_state, __tauri_command_name_get_desktop_control_state,
    __tauri_command_name_runtime_info, __tauri_command_name_set_guide_state,
};

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn runtime_info(
    state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<crate::android_compat::RuntimeInfo> {
    let last_error = state.inner.lock()?.last_runtime_error.clone();
    Ok(crate::android_compat::get_runtime_info(last_error))
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeControlResult {
    pub ok: bool,
    pub guide_state: String,
    pub desired_state: String,
    pub lifecycle_state: String,
    pub installed: bool,
    pub running: bool,
    pub backend_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGuideStateInput {
    pub guide_state: String,
}

#[cfg(not(feature = "desktop"))]
fn normalize_guide_state(value: &str) -> crate::error::AppResult<&'static str> {
    match value {
        "pending" => Ok("pending"),
        "deferred" => Ok("deferred"),
        "completed" => Ok("completed"),
        other => Err(crate::error::AppError::InvalidRequest(format!(
            "未知的引导状态: {}",
            other
        ))),
    }
}

#[cfg(not(feature = "desktop"))]
fn android_control_snapshot(
    state: &tauri::State<'_, crate::state::AppState>,
    guide_state: &str,
    error: Option<String>,
) -> crate::error::AppResult<RuntimeControlResult> {
    let inner = state.inner.lock()?;
    Ok(RuntimeControlResult {
        ok: error.is_none(),
        guide_state: guide_state.to_string(),
        desired_state: "stopped".to_string(),
        lifecycle_state: "uninstalled".to_string(),
        installed: false,
        running: false,
        backend_ready: inner.dashboard_handle.is_some() && !inner.api_base_url.trim().is_empty(),
        error,
    })
}

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub fn get_desktop_control_state(
    state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<RuntimeControlResult> {
    android_control_snapshot(&state, "completed", None)
}

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub fn set_guide_state(
    input: SetGuideStateInput,
    state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<RuntimeControlResult> {
    let guide_state = normalize_guide_state(&input.guide_state)?;
    android_control_snapshot(&state, guide_state, None)
}

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "desktop"))]
    #[test]
    fn accepts_supported_guide_states() {
        for value in ["pending", "deferred", "completed"] {
            assert_eq!(super::normalize_guide_state(value).unwrap(), value);
        }
    }

    #[cfg(not(feature = "desktop"))]
    #[test]
    fn rejects_unknown_guide_state() {
        assert!(super::normalize_guide_state("hidden").is_err());
    }
}
