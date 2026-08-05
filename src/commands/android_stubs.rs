// Android stubs for desktop-only file/git/yolo commands.
//
// The frontend calls these from a few places (composer attachments,
// workspace pickers, YOLO toggle). On remote-only mobile builds they are
// intentionally stubbed to return a friendly "not supported" response
// instead of a missing-command IPC error. Desktop builds re-export the real
// implementations so main.rs can reference one path for both features.

#[cfg(feature = "desktop")]
pub use crate::commands::file_dialogs::{
    open_workspace_path, pick_directory, pick_files, __cmd__open_workspace_path,
    __cmd__pick_directory, __cmd__pick_files, __tauri_command_name_open_workspace_path,
    __tauri_command_name_pick_directory, __tauri_command_name_pick_files,
};

#[cfg(feature = "desktop")]
pub use crate::commands::yolo::{
    set_yolo_mode, __cmd__set_yolo_mode, __tauri_command_name_set_yolo_mode,
};

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn pick_files(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<crate::android_compat::FilePickerResult> {
    Ok(crate::android_compat::FilePickerResult {
        canceled: true,
        paths: vec![],
    })
}

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn pick_directory(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<crate::android_compat::FilePickerResult> {
    Ok(crate::android_compat::FilePickerResult {
        canceled: true,
        paths: vec![],
    })
}

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn open_workspace_path(
    _input: crate::android_compat::WorkspacePathInput,
    _state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<crate::android_compat::SimpleApiResult> {
    Ok(crate::android_compat::SimpleApiResult {
        ok: false,
        message: Some("Android 版不支持直接打开本地工作区路径".to_string()),
    })
}

#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn set_yolo_mode(
    _input: crate::android_compat::SetYoloModeInput,
    _state: tauri::State<'_, crate::state::AppState>,
) -> crate::error::AppResult<crate::android_compat::SetYoloModeResult> {
    Ok(crate::android_compat::SetYoloModeResult {
        ok: false,
        enabled: false,
        effective: false,
        restarted: false,
        api_base_url: None,
        gateway_url: None,
        session_token: None,
        error: Some("Android 版不支持 YOLO 模式".to_string()),
    })
}
