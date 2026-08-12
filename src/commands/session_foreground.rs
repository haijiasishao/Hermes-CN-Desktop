use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, State,
};

use crate::commands::api_proxy::{api_request_from_state, ApiRequestInput};
use crate::error::{AppError, AppResult};
use crate::state::{
    foreground_monitor_matches, next_session_foreground_generation, AppState,
    SessionForegroundMonitor,
};

const HEARTBEAT_INTERVAL_MS: u64 = 10_000;

#[cfg(target_os = "android")]
struct SessionForegroundPluginHandle(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("session-foreground")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    "cn.org.hermesagent.mobile",
                    "SessionForegroundPlugin",
                )?;
                app.manage(SessionForegroundPluginHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForegroundStartInput {
    pub persistent_session_id: String,
    pub title: String,
    pub state: String,
    pub heartbeat_sequence: u64,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForegroundStopInput {
    pub persistent_session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForegroundResult {
    pub ok: bool,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInput {
    action: String,
    persistent_session_id: String,
    title: String,
    state: String,
    heartbeat_sequence: u64,
    timestamp_ms: i64,
}

const PROBE_PATH: &str = "/api/sessions?limit=1&offset=0";
const MAX_PLUGIN_UPDATE_FAILURES: u8 = 6;

pub const fn heartbeat_interval_ms() -> u64 {
    HEARTBEAT_INTERVAL_MS
}

async fn plugin(app: &AppHandle, input: PluginInput) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<SessionForegroundPluginHandle>();
        handle
            .0
            .run_mobile_plugin_async("sessionForeground", input)
            .await
            .map_err(|error| {
                AppError::Internal(format!("foreground diagnostic plugin: {error}"))
            })?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, input);
        Err(AppError::Internal(
            "Android 前台服务仅支持 Android".to_string(),
        ))
    }
}

#[tauri::command]
pub async fn session_foreground_start(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SessionForegroundStartInput,
) -> AppResult<SessionForegroundResult> {
    let _operation = state.session_foreground_operation.lock().await;
    let old_monitor = {
        let mut inner = state.inner.lock()?;
        inner.session_foreground_monitor.take()
    };
    if let Some(old_monitor) = old_monitor {
        old_monitor.handle.abort();
        let old_session_id = old_monitor.persistent_session_id;
        if plugin(
            &app,
            PluginInput {
                action: "stop".to_string(),
                persistent_session_id: old_session_id,
                title: "后台链路诊断".to_string(),
                state: "stopped".to_string(),
                heartbeat_sequence: 0,
                timestamp_ms: now_ms(),
            },
        )
        .await
        .is_err()
        {
            log::warn!("session-fgs.monitor.error error_category=old_service_stop_failed");
        }
    }
    let generation = next_session_foreground_generation();
    let session_id = input.persistent_session_id;
    plugin(
        &app,
        PluginInput {
            action: "start".to_string(),
            persistent_session_id: session_id.clone(),
            title: sanitize_title(&input.title),
            state: input.state,
            heartbeat_sequence: input.heartbeat_sequence,
            timestamp_ms: input.timestamp_ms,
        },
    )
    .await?;
    let monitor_app = app.clone();
    let monitor_session_id = session_id.clone();
    let monitor_task_session_id = session_id.clone();
    let task = tokio::spawn(async move {
        let mut sequence = 0_u64;
        let mut plugin_failures = 0_u8;
        loop {
            sequence += 1;
            let result = {
                let app_state = monitor_app.state::<AppState>();
                probe(&monitor_app, &app_state).await
            };
            log::debug!(
                "session-fgs.transport.heartbeat session_id={} sequence={} ok={} status={:?} error_category={:?}",
                monitor_task_session_id,
                sequence,
                result.ok,
                result.status,
                result.error_category
            );
            let update = plugin(
                &monitor_app,
                PluginInput {
                    action: "update".to_string(),
                    persistent_session_id: monitor_task_session_id.clone(),
                    title: "后台链路诊断".to_string(),
                    state: if result.ok {
                        "connected"
                    } else {
                        "probe_failed"
                    }
                    .to_string(),
                    heartbeat_sequence: sequence,
                    timestamp_ms: now_ms(),
                },
            )
            .await;
            if update.is_err() {
                plugin_failures = plugin_failures.saturating_add(1);
                if plugin_failures >= MAX_PLUGIN_UPDATE_FAILURES {
                    log::warn!(
                        "session-fgs.monitor.error session_id={} sequence={} error_category=plugin_unavailable",
                        monitor_task_session_id,
                        sequence
                    );
                    break;
                }
            } else {
                plugin_failures = 0;
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEARTBEAT_INTERVAL_MS)).await;
        }
        let owns_current_monitor = {
            let app_state = monitor_app.state::<AppState>();
            let mut inner = match app_state.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            let matches = foreground_monitor_matches(
                inner
                    .session_foreground_monitor
                    .as_ref()
                    .map(|monitor| monitor.persistent_session_id.as_str()),
                inner
                    .session_foreground_monitor
                    .as_ref()
                    .map(|monitor| monitor.generation),
                &monitor_task_session_id,
                generation,
            );
            if matches {
                inner.session_foreground_monitor.take();
            }
            matches
        };
        if owns_current_monitor {
            let _ = plugin(
                &monitor_app,
                PluginInput {
                    action: "stop".to_string(),
                    persistent_session_id: monitor_task_session_id,
                    title: "后台链路诊断".to_string(),
                    state: "stopped".to_string(),
                    heartbeat_sequence: sequence,
                    timestamp_ms: now_ms(),
                },
            )
            .await;
        }
    });
    let mut task = Some(task);
    let registration_result: AppResult<()> = {
        match state.inner.lock() {
            Ok(mut inner) => {
                inner.session_foreground_monitor = Some(SessionForegroundMonitor {
                    persistent_session_id: monitor_session_id,
                    generation,
                    handle: task.take().expect("monitor task must be available"),
                });
                Ok(())
            }
            Err(_) => Err(AppError::StateLockPoisoned),
        }
    };
    if let Err(error) = registration_result {
        task.take().expect("monitor task must be available").abort();
        let _ = plugin(
            &app,
            PluginInput {
                action: "stop".to_string(),
                persistent_session_id: session_id,
                title: "后台链路诊断".to_string(),
                state: "stopped".to_string(),
                heartbeat_sequence: 0,
                timestamp_ms: now_ms(),
            },
        )
        .await;
        return Err(error);
    }
    Ok(SessionForegroundResult {
        ok: true,
        supported: cfg!(target_os = "android"),
    })
}

#[tauri::command]
pub async fn session_foreground_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SessionForegroundStopInput,
) -> AppResult<SessionForegroundResult> {
    let _operation = state.session_foreground_operation.lock().await;
    let monitor = {
        let mut inner = state.inner.lock()?;
        let matches = inner
            .session_foreground_monitor
            .as_ref()
            .map(|monitor| monitor.persistent_session_id == input.persistent_session_id)
            .unwrap_or(false);
        if matches {
            inner.session_foreground_monitor.take()
        } else {
            None
        }
    };
    let Some(monitor) = monitor else {
        return Ok(SessionForegroundResult {
            ok: true,
            supported: cfg!(target_os = "android"),
        });
    };
    monitor.handle.abort();
    plugin(
        &app,
        PluginInput {
            action: "stop".to_string(),
            persistent_session_id: input.persistent_session_id,
            title: "后台链路诊断".to_string(),
            state: "stopped".to_string(),
            heartbeat_sequence: 0,
            timestamp_ms: now_ms(),
        },
    )
    .await?;
    Ok(SessionForegroundResult {
        ok: true,
        supported: cfg!(target_os = "android"),
    })
}

#[derive(Debug, PartialEq, Eq)]
struct ProbeResult {
    ok: bool,
    status: Option<u16>,
    error_category: Option<&'static str>,
}

async fn probe(app: &AppHandle, state: &AppState) -> ProbeResult {
    let result = api_request_from_state(
        app,
        ApiRequestInput {
            path: PROBE_PATH.to_string(),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
            suppress_auth_expired_event: true,
        },
        state,
    )
    .await;
    match result {
        Ok(response) if response.ok => ProbeResult {
            ok: true,
            status: Some(response.status),
            error_category: None,
        },
        Ok(response) => ProbeResult {
            ok: false,
            status: Some(response.status),
            error_category: Some(if response.status == 401 || response.status == 403 {
                "auth"
            } else {
                "http"
            }),
        },
        Err(error) => ProbeResult {
            ok: false,
            status: None,
            error_category: Some(match error {
                AppError::DashboardUnreachable(_) | AppError::DashboardProbe(_) => "network",
                AppError::AuthSessionExpired(_) => "auth",
                AppError::StateLockPoisoned | AppError::Internal(_) => "internal",
                _ => "error",
            }),
        },
    }
}

fn sanitize_title(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .trim()
        .chars()
        .take(80)
        .collect()
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_body<'a>(source: &'a str, command: &str) -> &'a str {
        let start = source
            .find(command)
            .expect("foreground command must remain present");
        &source[start..]
    }

    #[test]
    fn foreground_commands_have_a_dedicated_async_operation_lock() {
        let state_source = include_str!("../state.rs");
        assert!(state_source.contains("pub session_foreground_operation: tokio::sync::Mutex<()>"));
        assert!(state_source.contains("session_foreground_operation: tokio::sync::Mutex::new(())"));

        let source = include_str!("session_foreground.rs");
        for command in [
            "pub async fn session_foreground_start",
            "pub async fn session_foreground_stop",
        ] {
            let body = command_body(source, command);
            let operation_lock = body
                .find("let _operation = state.session_foreground_operation.lock().await;")
                .expect("command must acquire the foreground operation lock");
            let first_plugin_await = body
                .find("plugin(")
                .and_then(|index| body[index..].find(".await").map(|offset| index + offset))
                .expect("command must await the plugin");
            assert!(
                operation_lock < first_plugin_await,
                "operation lock must precede the first plugin await"
            );
        }
    }

    #[test]
    fn start_replaces_old_monitor_before_starting_new_plugin_service() {
        let source = include_str!("session_foreground.rs");
        let body = command_body(source, "pub async fn session_foreground_start");
        let take_old_monitor = body
            .find("session_foreground_monitor.take()")
            .expect("start must take the old monitor while holding the state lock");
        let abort_old_monitor = body
            .find("old_monitor.handle.abort()")
            .expect("start must abort the old monitor before replacing it");
        let stop_old_service = body
            .find("action: \"stop\".to_string()")
            .expect("start must stop the old plugin service");
        let start_new_service = body
            .find("action: \"start\".to_string()")
            .expect("start must start the new plugin service");
        let spawn_new_monitor = body
            .find("let task = tokio::spawn")
            .expect("start must spawn the new monitor after plugin start");

        assert!(take_old_monitor < abort_old_monitor);
        assert!(abort_old_monitor < stop_old_service);
        assert!(stop_old_service < start_new_service);
        assert!(start_new_service < spawn_new_monitor);
        assert!(body[stop_old_service..start_new_service]
            .contains("persistent_session_id: old_session_id"));
        assert!(body[stop_old_service..start_new_service].contains("state: \"stopped\""));
        assert!(body[stop_old_service..start_new_service].contains(".await"));
    }

    #[test]
    fn stop_only_matches_the_current_monitor_session() {
        assert!(foreground_monitor_matches(
            Some("persistent-a"),
            Some(7),
            "persistent-a",
            7,
        ));
        assert!(!foreground_monitor_matches(
            Some("persistent-a"),
            Some(7),
            "persistent-a",
            8,
        ));
        assert!(!foreground_monitor_matches(
            Some("persistent-a"),
            Some(7),
            "persistent-b",
            7,
        ));
        assert!(!foreground_monitor_matches(None, None, "persistent-a", 7));
    }

    #[test]
    fn monitor_uses_ten_second_heartbeat_contract() {
        assert_eq!(heartbeat_interval_ms(), 10_000);
    }

    #[test]
    fn monitor_generations_are_unique() {
        assert_ne!(
            next_session_foreground_generation(),
            next_session_foreground_generation()
        );
    }
    #[test]
    fn title_is_bounded_and_line_safe() {
        assert_eq!(sanitize_title(" a\nb "), "a b");
    }

    #[test]
    fn probe_contract_has_only_safe_categories() {
        assert_eq!(PROBE_PATH, "/api/sessions?limit=1&offset=0");
        assert_eq!(MAX_PLUGIN_UPDATE_FAILURES, 6);
        assert_eq!(
            ProbeResult {
                ok: false,
                status: Some(401),
                error_category: Some("auth")
            },
            ProbeResult {
                ok: false,
                status: Some(401),
                error_category: Some("auth")
            },
        );
    }
}
