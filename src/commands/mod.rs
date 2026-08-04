// Command modules shared across desktop and Android.
pub mod api_proxy;
pub mod backup;
pub mod config_migration;
pub mod connection;
pub mod connection_auth;
pub mod debug_bundle;
pub mod devtools;
pub mod environment;
pub mod file_dialogs;
pub mod gateway;
pub mod git;
pub mod im_onboarding;
pub mod log_export;
pub mod memory;
pub mod notify;
pub mod preview;
pub mod profiles;
pub mod session_export;
pub mod ui_store;
pub mod ws_proxy;

// Desktop-only command modules (require managed runtime, tray, PTY, etc.)
#[cfg(feature = "desktop")]
pub mod browser_companion;
#[cfg(feature = "desktop")]
pub mod coding_agents;
#[cfg(feature = "desktop")]
pub mod desktop_update;
#[cfg(feature = "desktop")]
pub mod restart;
#[cfg(feature = "desktop")]
pub mod runtime_manager;
#[cfg(feature = "desktop")]
pub mod terminal;
#[cfg(feature = "desktop")]
pub mod yolo;
