pub mod android_compat;
pub mod bootstrap;
pub mod commands;
pub mod connection;
pub mod cron_runs;
pub mod env_file;
pub mod environment;
pub mod error;
pub mod oauth_session;
pub mod path_resolver;
pub mod session_archive;
pub mod session_log;
pub mod state;
pub mod ui_store;
pub mod util;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::bootstrap::{
    connect_remote_backend, finalize_bootstrap, record_bootstrap_error,
};
use crate::connection::{ConnectionBackend, ConnectionMode};
use crate::state::AppState;

fn shutdown_remote_connection(app: &tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<AppState>();
    let (gateway_ws, dashboard_handle) = match state.inner.lock() {
        Ok(mut inner) => (
            inner.gateway_ws.take(),
            inner.dashboard_handle.take(),
        ),
        Err(err) => {
            log::warn!("Failed to lock app state during Android shutdown: {}", err);
            return;
        }
    };

    if let Some(relay) = gateway_ws {
        relay.abort.store(true, Ordering::Relaxed);
        relay.notify.notify_waiters();
    }

    // DashboardHandle::stop() is a no-op for an attached remote handle. Drop
    // it here only to release the local Rust state; never stop a remote agent.
    drop(dashboard_handle);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let app_state = AppState::new();
    let quit_requested = Arc::new(AtomicBool::new(false));
    let close_quit_requested = Arc::clone(&quit_requested);

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            // Persist all Android-local state below Tauri's writable app-private
            // directory. This must happen before resolve_connection_backend(),
            // which reads connection.json.
            use tauri::Manager;
            if let Ok(dir) = app.path().app_data_dir() {
                crate::android_compat::set_android_data_dir(dir);
            }

            // Resolve the remote backend: env override → connection.json.
            // An env URL without a token is the one fatal misconfiguration.
            let backend = match connection::resolve_connection_backend() {
                Ok(backend) => backend,
                Err(msg) => {
                    record_bootstrap_error(app.handle(), msg);
                    return Ok(());
                }
            };

            // If no remote/local backend is configured, show an error —
            // Android port does not support managed runtime.
            if matches!(backend, ConnectionBackend::Managed) {
                record_bootstrap_error(
                    app.handle(),
                    "Android 版仅支持远程连接模式，请在设置中配置远程 Dashboard 地址。".to_string(),
                );
                return Ok(());
            }

            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                let (handle, mode) = match backend {
                    ConnectionBackend::Remote(remote) => (
                        connect_remote_backend(&app_handle, &remote).await,
                        ConnectionMode::Remote,
                    ),
                    ConnectionBackend::Managed | ConnectionBackend::Local(_) => {
                        record_bootstrap_error(
                            &app_handle,
                            "Android 版仅支持远程 Hermes Agent，不支持本地或托管内核。".to_string(),
                        );
                        return;
                    }
                };

                finalize_bootstrap(
                    &app_handle,
                    handle,
                    String::new(), // boot_home — not used in Remote mode
                    String::new(), // base_str
                    "default".to_string(),
                    mode,
                )
                .await;
            });

            log::info!("Hermes Agent Mobile bootstrapping (Remote mode)");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connection & gateway — core for remote mode
            commands::gateway::get_runtime_config,
            commands::gateway::refresh_gateway_url,
            commands::connection::get_connection_config,
            commands::connection::save_connection_config,
            commands::connection::probe_connection_config,
            commands::connection::test_connection_config,
            commands::connection::apply_connection_config,
            commands::connection_auth::connection_oauth_login,
            commands::connection_auth::connection_password_login,
            commands::connection_auth::connection_auth_me,
            commands::connection_auth::connection_oauth_logout,
            // API proxy — HTTP requests to Dashboard
            commands::api_proxy::api_request,
            commands::api_proxy::external_request,
            commands::api_proxy::upload_file,
            commands::api_proxy::download_external_image,
            // WebSocket relay — gateway events
            commands::ws_proxy::gateway_ws_open,
            commands::ws_proxy::gateway_ws_send,
            commands::ws_proxy::gateway_ws_close,
            // UI state
            commands::ui_store::ui_store_snapshot,
            commands::ui_store::ui_store_set_kv,
            commands::ui_store::ui_store_remove_kv,
            commands::ui_store::ui_store_record_turn_stats,
            commands::ui_store::ui_store_get_turn_stats,
            commands::ui_store::ui_store_get_turn_stats_window,
            commands::ui_store::ui_store_record_event,
            // Session/memory
            commands::session_export::export_session_json,
            commands::memory::read_memory,
            commands::memory::add_memory_entry,
            commands::memory::update_memory_entry,
            commands::memory::remove_memory_entry,
            commands::memory::write_user_profile,
            // Profiles
            commands::profiles::switch_profile,
            // Runtime info and guide state (desktop: full; Android: remote-only compatibility)
            commands::runtime_compat::runtime_info,
            commands::runtime_compat::get_desktop_control_state,
            commands::runtime_compat::set_guide_state,
            // File/yolo commands (desktop: real; Android: friendly stubs)
            commands::android_stubs::pick_files,
            commands::android_stubs::pick_directory,
            commands::android_stubs::open_workspace_path,
            commands::android_stubs::open_external_url,
            commands::android_stubs::set_yolo_mode,
            // Logging/debug
            commands::log_export::export_log_snapshot,
            commands::debug_bundle::export_debug_bundle,
            // Devtools toggle (for debugging)
            commands::devtools::toggle_devtools,
        ])
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. }
                if !close_quit_requested.load(Ordering::Relaxed) =>
            {
                // On Android, closing the last window exits the app.
                // In remote mode, we just let it close.
                let _ = window;
                let _ = api;
            }
            tauri::WindowEvent::Destroyed => {
                log::info!("Main window destroyed");
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Hermes Agent Mobile");

    app.run(move |app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            quit_requested.store(true, Ordering::Relaxed);
        }
        tauri::RunEvent::Exit => {
            shutdown_remote_connection(app_handle);
        }
        _ => {}
    });
}
