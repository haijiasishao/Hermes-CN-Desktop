// Command modules shared across desktop and Android.
pub mod android_stubs;
pub mod api_proxy;
pub mod connection;
pub mod connection_auth;
pub mod debug_bundle;
pub mod debug_export;
pub mod devtools;
pub mod gateway;
pub mod log_export;
pub mod memory;
#[cfg(any(feature = "desktop", feature = "android"))]
pub mod notify;
pub mod profiles;
pub mod runtime_compat;
pub mod session_export;
pub mod ui_store;
pub mod ws_proxy;

// Desktop-only command modules (require managed runtime, tray, PTY, etc.)
#[cfg(feature = "desktop")]
pub mod backup;
#[cfg(feature = "desktop")]
pub mod browser_companion;
#[cfg(feature = "desktop")]
pub mod coding_agents;
#[cfg(feature = "desktop")]
pub mod config_migration;
#[cfg(feature = "desktop")]
pub mod desktop_update;
#[cfg(feature = "desktop")]
pub mod environment;
#[cfg(feature = "desktop")]
pub mod file_dialogs;
#[cfg(feature = "desktop")]
pub mod git;
#[cfg(feature = "desktop")]
pub mod im_onboarding;
#[cfg(feature = "desktop")]
pub mod preview;
#[cfg(feature = "desktop")]
pub mod restart;
#[cfg(feature = "desktop")]
pub mod runtime_manager;
#[cfg(feature = "desktop")]
pub mod terminal;
#[cfg(feature = "desktop")]
pub mod yolo;
