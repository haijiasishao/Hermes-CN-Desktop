// Android stubs for desktop-only file/git/yolo commands.
//
// The frontend calls these from a few places (composer attachments,
// workspace pickers, YOLO toggle). On remote-only mobile builds they are
// intentionally stubbed to return a friendly "not supported" response
// instead of a missing-command IPC error. Desktop builds re-export the real
// implementations so main.rs can reference one path for both features.

#[cfg(feature = "desktop")]
pub use crate::commands::file_dialogs::{
    __cmd__open_external_url, __cmd__open_workspace_path, __cmd__pick_directory, __cmd__pick_files,
    __tauri_command_name_open_external_url, __tauri_command_name_open_workspace_path,
    __tauri_command_name_pick_directory, __tauri_command_name_pick_files, open_external_url,
    open_workspace_path, pick_directory, pick_files,
};

#[cfg(feature = "desktop")]
pub use crate::commands::yolo::{
    __cmd__set_yolo_mode, __tauri_command_name_set_yolo_mode, set_yolo_mode,
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
pub async fn open_external_url(
    input: crate::android_compat::ExternalUrlInput,
) -> crate::error::AppResult<crate::android_compat::SimpleApiResult> {
    let parsed = url::Url::parse(input.url.trim())
        .map_err(|_| crate::error::AppError::InvalidRequest("外部链接格式无效".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "obsidian") {
        return Err(crate::error::AppError::InvalidRequest(
            "仅允许打开 http、https、mailto 或 obsidian 链接".to_string(),
        ));
    }
    // The frontend falls back to window.open for Android. Returning an explicit
    // false result keeps this command safe and avoids a missing-command IPC
    // error without pretending Rust opened a local desktop application.
    Ok(crate::android_compat::SimpleApiResult {
        ok: false,
        message: Some("Android 版将使用系统 WebView 打开外部链接".to_string()),
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
