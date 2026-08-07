// Android-compatible replacements for desktop-only utility functions.
//
// On desktop builds, these re-export from the real process modules.
// On Android (non-desktop), minimal stub implementations are provided.

// ─── dashboard utilities ──────────────────────────────────────────────

#[cfg(feature = "desktop")]
pub use crate::process::dashboard::{
    build_gateway_url, build_gateway_ws_url_with_ticket, dashboard_supports_ws,
    dashboard_supports_ws_ticket,
    ensure_hermes_dashboard, external_agent_allowed, fetch_attached_dashboard_hermes_home,
    fetch_session_token, probe_attached_dashboard, probe_dashboard, remove_ownership_marker_path,
    terminate_owned_dashboard_tree, yolo_mode_effective, DashboardOwnershipMarker,
    EnsureDashboardOptions,
};

#[cfg(not(feature = "desktop"))]
mod dashboard_stubs {
    use std::sync::LazyLock;
    use std::time::Duration;

    static PROBE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("valid probe HTTP client")
    });

    static SESSION_TOKEN_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("valid session token HTTP client")
    });

    static SESSION_TOKEN_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)""#)
            .expect("valid session token regex")
    });

    pub async fn probe_dashboard(api_base_url: &str) -> bool {
        let url = format!("{}/api/status", api_base_url);
        match PROBE_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => res.status().is_success() || res.status().as_u16() == 401,
            Err(_) => false,
        }
    }

    pub async fn probe_attached_dashboard(api_base_url: &str) -> bool {
        probe_dashboard(api_base_url).await
    }

    pub async fn fetch_session_token(api_base_url: &str) -> Option<String> {
        let url = format!("{}/", api_base_url);
        let res = SESSION_TOKEN_HTTP_CLIENT
            .get(&url)
            .header("Accept", "text/html")
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let html = res.text().await.ok()?;
        SESSION_TOKEN_RE
            .captures(&html)
            .map(|c| c[1].to_string())
    }

    pub fn build_gateway_url(api_base_url: &str, token: Option<&str>) -> String {
        let ws_url = api_base_url
            .replace("http://", "ws://")
            .replace("https://", "wss://");
        match token {
            Some(t) => format!(
                "{}/api/ws?token={}",
                ws_url.trim_end_matches('/'),
                urlencoding::encode(t)
            ),
            None => format!("{}/api/ws", ws_url.trim_end_matches('/')),
        }
    }

    pub fn build_gateway_ws_url_with_ticket(api_base_url: &str, ticket: &str) -> String {
        let ws_url = api_base_url
            .replace("http://", "ws://")
            .replace("https://", "wss://");
        format!(
            "{}/api/ws?ticket={}",
            ws_url.trim_end_matches('/'),
            urlencoding::encode(ticket)
        )
    }

    pub async fn fetch_attached_dashboard_hermes_home(api_base_url: &str) -> Option<String> {
        let url = format!("{}/api/status", api_base_url);
        match PROBE_HTTP_CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => match res.json::<serde_json::Value>().await {
                Ok(data) => data
                    .get("hermes_home")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty()),
                Err(_) => None,
            },
            Err(_) => None,
        }
    }

    pub fn yolo_mode_effective(_hermes_home: &str) -> bool {
        false
    }

    pub fn external_agent_allowed() -> bool {
        false
    }

    pub async fn dashboard_supports_ws(_api_base_url: &str, _token: Option<&str>) -> bool {
        true
    }

    pub async fn dashboard_supports_ws_ticket(_api_base_url: &str, _ticket: &str) -> bool {
        true
    }

    #[derive(Debug, Clone, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DashboardOwnershipMarker {
        pub hermes_home: String,
    }

    pub struct EnsureDashboardOptions {
        pub host: String,
        pub port: u16,
        pub hermes_home: String,
        pub allow_external_agent: bool,
        pub allow_port_fallback: bool,
        pub connection_mode: crate::connection::ConnectionMode,
        pub remote_base_url: Option<String>,
    }

    pub fn terminate_owned_dashboard_tree(
        _api_base_url: &str,
        _child: Option<&mut std::process::Child>,
        _fallback_pid: Option<u32>,
        _session_token: Option<&str>,
    ) -> bool {
        true
    }

    pub fn remove_ownership_marker_path(_path: Option<&str>) {}
}

#[cfg(not(feature = "desktop"))]
pub use dashboard_stubs::*;

// ─── runtime utilities ────────────────────────────────────────────────

#[cfg(feature = "desktop")]
pub use crate::process::runtime::{
    bundled_runtime_available, current_bundled_plugins_dir, current_bundled_skills_dir,
    current_dashboard_web_dist_dir, current_record_path_display, gateway_runtime_dir,
    get_runtime_info, hermes_home_dir, install_bundled_runtime_if_needed, install_runtime_update,
    portable_mode_active, read_current_record, runtime_root, sync_runtime_resources_if_available,
    RuntimeInfo, RuntimeProcessInfo,
};

#[cfg(not(feature = "desktop"))]
mod runtime_stubs {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// App-private writable data dir on Android, resolved once from Tauri's
    /// path API (`app_data_dir` → `/data/data/<pkg>/files`). Fallback keeps
    /// the old dirs::data_dir() behaviour for tests / odd environments.
    static ANDROID_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

    pub fn set_android_data_dir(dir: PathBuf) {
        let _ = ANDROID_DATA_DIR.set(dir);
    }

    pub fn hermes_home_dir() -> PathBuf {
        if let Some(dir) = ANDROID_DATA_DIR.get() {
            return dir.join("hermes-agent-cn-mobile");
        }
        std::env::var("HERMES_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("hermes-agent-cn-mobile")
            })
    }

    pub fn runtime_root() -> PathBuf {
        hermes_home_dir()
    }

    pub fn portable_mode_active() -> bool {
        false
    }

    pub fn read_current_record() -> Option<RuntimeRecord> {
        None
    }

    pub fn current_record_path_display() -> String {
        "<not available on Android>".to_string()
    }

    pub fn current_bundled_skills_dir() -> Option<PathBuf> {
        None
    }

    pub fn current_bundled_plugins_dir() -> Option<PathBuf> {
        None
    }

    pub fn current_dashboard_web_dist_dir() -> Option<PathBuf> {
        None
    }

    pub fn gateway_runtime_dir() -> PathBuf {
        hermes_home_dir().join("gateway-runtime")
    }

    pub fn bundled_runtime_available(_resource_dir: Option<&std::path::Path>) -> bool {
        false
    }

    pub fn get_runtime_info(_home: Option<String>) -> RuntimeInfo {
        RuntimeInfo {
            mode: "managed-pending".to_string(),
            packaged: true,
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            current: None,
            runtime_root: String::new(),
            current_record_path: String::new(),
            versions_dir: String::new(),
            downloads_dir: String::new(),
            gateway_runtime_dir: String::new(),
            update_manifest_url: None,
            updates_configured: false,
            executable_sha256: None,
            source: None,
            process: None,
            last_error: None,
            guide_state: "completed".to_string(),
            managed_runtime_desired_state: "off".to_string(),
            managed_runtime_lifecycle_state: "uninstalled".to_string(),
        }
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RuntimeInfo {
        pub mode: String,
        pub packaged: bool,
        pub platform: String,
        pub arch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub current: Option<RuntimeRecord>,
        pub runtime_root: String,
        pub current_record_path: String,
        pub versions_dir: String,
        pub downloads_dir: String,
        pub gateway_runtime_dir: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub update_manifest_url: Option<String>,
        pub updates_configured: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub executable_sha256: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub source: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub process: Option<RuntimeProcessInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub last_error: Option<String>,
        pub guide_state: String,
        pub managed_runtime_desired_state: String,
        pub managed_runtime_lifecycle_state: String,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RuntimeProcessInfo {
        pub api_base_url: String,
        pub gateway_url: String,
        pub hermes_home: String,
        pub hermes_home_base: String,
        pub current_profile: String,
        pub connection_mode: String,
        pub yolo_mode: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub last_runtime_error: Option<String>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RuntimeRecord {
        pub runtime_version: String,
        pub path: PathBuf,
        pub executable_path: String,
        pub kernel_version: String,
        pub runtime_flavor: String,
        pub runtime_revision: String,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    pub struct InstallResult {
        pub ok: bool,
        pub error: Option<String>,
        pub installed: Option<InstalledInfo>,
    }

    #[derive(Debug, Clone, serde::Serialize)]
    pub struct InstalledInfo {
        pub runtime_version: String,
    }

    pub async fn install_runtime_update(_home: Option<&str>) -> InstallResult {
        InstallResult {
            ok: false,
            error: Some("Runtime management not available on Android".into()),
            installed: None,
        }
    }

    pub async fn install_bundled_runtime_if_needed(
        _resource_dir: Option<&std::path::Path>,
    ) -> InstallResult {
        InstallResult {
            ok: false,
            error: Some("Bundled runtime not available on Android".into()),
            installed: None,
        }
    }

    pub fn sync_runtime_resources_if_available(
        _resource_dir: Option<&std::path::Path>,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Android stub — profile restart is not supported.
    #[derive(Debug, Clone)]
    pub enum RespawnOutcome {
        Spawned,
        Recovered { error: String },
        Down { error: String },
    }
}

#[cfg(not(feature = "desktop"))]
pub use runtime_stubs::*;

// ─── desktop_control utilities ────────────────────────────────────────

#[cfg(feature = "desktop")]
pub use crate::desktop_control::{self as desktop_ctrl, ManagedRuntimeDesiredState};

#[cfg(not(feature = "desktop"))]
pub mod desktop_ctrl {
    pub struct DesktopControlState {
        pub guide_state: GuideState,
        pub managed_runtime_desired_state: ManagedRuntimeDesiredState,
    }

    #[derive(Debug, Clone, Copy)]
    pub enum GuideState {
        Completed,
    }

    impl GuideState {
        pub fn as_str(self) -> &'static str {
            "completed"
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ManagedRuntimeDesiredState {
        Stopped,
        Running,
        Uninstalled,
    }

    impl ManagedRuntimeDesiredState {
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Stopped => "stopped",
                Self::Running => "running",
                Self::Uninstalled => "uninstalled",
            }
        }
    }

    pub fn read() -> DesktopControlState {
        DesktopControlState {
            guide_state: GuideState::Completed,
            managed_runtime_desired_state: ManagedRuntimeDesiredState::Stopped,
        }
    }

    pub fn managed_runtime_lifecycle_state(_installed: bool, _running: bool) -> String {
        "uninstalled".to_string()
    }

    pub fn set_managed_runtime_desired_state(
        _state: ManagedRuntimeDesiredState,
    ) -> Result<(), crate::error::AppError> {
        Ok(())
    }
}

#[cfg(not(feature = "desktop"))]
pub use desktop_ctrl::ManagedRuntimeDesiredState;

// ─── tray constants ──────────────────────────────────────────────────

#[cfg(feature = "desktop")]
pub use crate::tray::MAIN_WINDOW_LABEL;

#[cfg(not(feature = "desktop"))]
pub const MAIN_WINDOW_LABEL: &str = "main";

// ─── port_lock stub ──────────────────────────────────────────────────

#[cfg(feature = "desktop")]
pub use crate::process::port_lock::PortLock;

#[cfg(not(feature = "desktop"))]
pub struct PortLock;

#[cfg(not(feature = "desktop"))]
impl PortLock {
    pub fn release(self) {}
}

// ─── shared IPC types for Android command stubs ───────────────────────
// Desktop builds re-export the real types from the desktop command modules;
// Android builds define the same shapes so android_stubs.rs compiles under
// both features with identical signatures.

#[cfg(feature = "desktop")]
pub use crate::commands::file_dialogs::{
    ExternalUrlInput, FilePickerResult, SimpleApiResult, WorkspacePathInput,
};

#[cfg(feature = "desktop")]
pub use crate::commands::yolo::{SetYoloModeInput, SetYoloModeResult};

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePickerResult {
    pub canceled: bool,
    pub paths: Vec<String>,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleApiResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUrlInput {
    pub url: String,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathInput {
    pub path: String,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetYoloModeInput {
    pub enabled: bool,
}

#[cfg(not(feature = "desktop"))]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetYoloModeResult {
    pub ok: bool,
    pub enabled: bool,
    pub effective: bool,
    pub restarted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
