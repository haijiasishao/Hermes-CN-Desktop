use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDebugBundleInput {
    pub source_path: String,
    pub file_name: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDebugBundleResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub uri: Option<String>,
}

/// Registers the Android implementation that persists a generated debug ZIP
/// through the system document picker. Desktop builds do not need a native
/// implementation because `export_debug_bundle` opens the destination folder
/// directly.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("debug-export")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("cn.org.hermesagent.mobile", "DebugExportPlugin")?;
                app.manage(handle);
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = app;
                let _ = api;
            }
            Ok(())
        })
        .build()
}

/// Forwards the bounded export request to the registered Android plugin.
///
/// This is an application command rather than a direct `plugin:*` call so the
/// renderer does not need a separately generated custom-plugin permission.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn save_debug_bundle(
    app: AppHandle,
    input: SaveDebugBundleInput,
) -> AppResult<SaveDebugBundleResult> {
    let handle = app.state::<PluginHandle<tauri::Wry>>();
    handle
        .run_mobile_plugin_async("saveDebugBundle", input)
        .await
        .map_err(|error| AppError::FileError(error.to_string()))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn save_debug_bundle(_input: SaveDebugBundleInput) -> AppResult<SaveDebugBundleResult> {
    Err(AppError::FileError(
        "Android 系统文件保存能力仅在 Android 端可用".to_string(),
    ))
}
