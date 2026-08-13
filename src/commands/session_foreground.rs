use serde::{Deserialize, Serialize};
use std::time::Duration;
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
const READY_TIMEOUT_MS: u64 = 5_000;
const MAX_PROBE_BODY_BYTES: usize = 1024 * 1024;

#[cfg(target_os = "android")]
struct SessionForegroundPluginHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

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

const MAX_PLUGIN_UPDATE_FAILURES: u8 = 6;

pub const fn heartbeat_interval_ms() -> u64 {
    HEARTBEAT_INTERVAL_MS
}

async fn plugin(app: &AppHandle, input: PluginInput) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<SessionForegroundPluginHandle<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin_async::<()>("sessionForeground", input)
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

async fn plugin_if_foreground_monitor_owner(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    generation: u64,
    input: PluginInput,
) -> AppResult<bool> {
    let _operation = state.session_foreground_operation.lock().await;
    let owns_monitor = {
        let inner = state.inner.lock()?;
        foreground_monitor_matches(
            inner
                .session_foreground_monitor
                .as_ref()
                .map(|m| m.persistent_session_id.as_str()),
            inner
                .session_foreground_monitor
                .as_ref()
                .map(|m| m.generation),
            session_id,
            generation,
        )
    };
    if !owns_monitor {
        return Ok(false);
    }
    plugin(app, input).await?;
    Ok(true)
}

async fn terminal_plugin_if_foreground_monitor_owner(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    generation: u64,
    input: PluginInput,
) -> AppResult<bool> {
    let _operation = state.session_foreground_operation.lock().await;
    let owns_monitor = {
        let inner = state.inner.lock()?;
        foreground_monitor_matches(
            inner
                .session_foreground_monitor
                .as_ref()
                .map(|m| m.persistent_session_id.as_str()),
            inner
                .session_foreground_monitor
                .as_ref()
                .map(|m| m.generation),
            session_id,
            generation,
        )
    };
    if !owns_monitor {
        return Ok(false);
    }
    plugin(app, input).await?;
    let mut inner = state.inner.lock()?;
    if foreground_monitor_matches(
        inner
            .session_foreground_monitor
            .as_ref()
            .map(|m| m.persistent_session_id.as_str()),
        inner
            .session_foreground_monitor
            .as_ref()
            .map(|m| m.generation),
        session_id,
        generation,
    ) {
        inner.session_foreground_monitor.take();
        Ok(true)
    } else {
        Ok(false)
    }
}

fn take_matching_monitor(
    state: &AppState,
    session_id: &str,
    generation: u64,
) -> AppResult<Option<SessionForegroundMonitor>> {
    let mut inner = state.inner.lock()?;
    if foreground_monitor_matches(
        inner
            .session_foreground_monitor
            .as_ref()
            .map(|m| m.persistent_session_id.as_str()),
        inner
            .session_foreground_monitor
            .as_ref()
            .map(|m| m.generation),
        session_id,
        generation,
    ) {
        Ok(inner.session_foreground_monitor.take())
    } else {
        Ok(None)
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
    let started_at_ms = input.timestamp_ms;
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
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = start_rx.await;
        let mut sequence = 0_u64;
        let mut plugin_failures = 0_u8;
        let mut baseline_id = None;
        let mut ready_tx = Some(ready_tx);
        let mut first_probe = true;
        loop {
            sequence += 1;
            let result = {
                let app_state = monitor_app.state::<AppState>();
                probe(
                    &monitor_app,
                    &app_state,
                    &monitor_task_session_id,
                    started_at_ms,
                )
                .await
            };
            log::debug!(
                "session-fgs.transport.probe session_id={} sequence={} ok={} status={:?} error_category={:?} terminal={:?}",
                monitor_task_session_id,
                sequence,
                result.ok,
                result.status,
                result.error_category,
                result.terminal
            );
            if let Some(sender) = ready_tx.take() {
                baseline_id = result.max_assistant_id;
                let ready_failed = !result.ok;
                let _ = sender.send(if ready_failed { Err(()) } else { Ok(()) });
                if ready_failed {
                    return;
                }
            }
            if let Some(terminal) = result.terminal_after(baseline_id, first_probe) {
                let app_state = monitor_app.state::<AppState>();
                let update = terminal_plugin_if_foreground_monitor_owner(
                    &monitor_app,
                    &app_state,
                    &monitor_task_session_id,
                    generation,
                    PluginInput {
                        action: "update".to_string(),
                        persistent_session_id: monitor_task_session_id.clone(),
                        title: "后台链路诊断".to_string(),
                        state: terminal.as_plugin_state().to_string(),
                        heartbeat_sequence: sequence,
                        timestamp_ms: now_ms(),
                    },
                )
                .await;
                match update {
                    Ok(true) => return,
                    Ok(false) => return,
                    Err(_) => {
                        plugin_failures = plugin_failures.saturating_add(1);
                        if plugin_failures >= MAX_PLUGIN_UPDATE_FAILURES {
                            log::warn!(
                                "session-fgs.monitor.error session_id={} sequence={} error_category=plugin_unavailable",
                                monitor_task_session_id,
                                sequence
                            );
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(HEARTBEAT_INTERVAL_MS)).await;
                        continue;
                    }
                }
            }
            first_probe = false;
            let app_state = monitor_app.state::<AppState>();
            let update = plugin_if_foreground_monitor_owner(
                &monitor_app,
                &app_state,
                &monitor_task_session_id,
                generation,
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
            match update {
                Ok(true) => plugin_failures = 0,
                Ok(false) => return,
                Err(_) => {
                    plugin_failures = plugin_failures.saturating_add(1);
                    if plugin_failures >= MAX_PLUGIN_UPDATE_FAILURES {
                        log::warn!(
                            "session-fgs.monitor.error session_id={} sequence={} error_category=plugin_unavailable",
                            monitor_task_session_id,
                            sequence
                        );
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEARTBEAT_INTERVAL_MS)).await;
        }
        let app_state = monitor_app.state::<AppState>();
        let _ = terminal_plugin_if_foreground_monitor_owner(
            &monitor_app,
            &app_state,
            &monitor_task_session_id,
            generation,
            PluginInput {
                action: "stop".to_string(),
                persistent_session_id: monitor_task_session_id.clone(),
                title: "后台链路诊断".to_string(),
                state: "stopped".to_string(),
                heartbeat_sequence: sequence,
                timestamp_ms: now_ms(),
            },
        )
        .await;
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
    let _ = start_tx.send(());
    let ready = tokio::time::timeout(Duration::from_millis(READY_TIMEOUT_MS), ready_rx).await;
    if !matches!(ready.as_ref(), Ok(Ok(Ok(())))) {
        let monitor = take_matching_monitor(&state, &session_id, generation)?;
        if let Some(monitor) = monitor {
            monitor.handle.abort();
            let _ = plugin(
                &app,
                PluginInput {
                    action: "stop".to_string(),
                    persistent_session_id: session_id.clone(),
                    title: "后台链路诊断".to_string(),
                    state: "stopped".to_string(),
                    heartbeat_sequence: 0,
                    timestamp_ms: now_ms(),
                },
            )
            .await;
        }
        let error_category = if ready.is_err() {
            "baseline_timeout"
        } else {
            "baseline_failed"
        };
        log::warn!(
            "session-fgs.monitor.error session_id={} error_category={}",
            session_id,
            error_category
        );
        return Err(AppError::Internal(
            "foreground monitor failed to become ready".to_string(),
        ));
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalState {
    Running,
    Completed,
    Failed,
}

impl TerminalState {
    fn as_plugin_state(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Running => "connected",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ProbeResult {
    ok: bool,
    status: Option<u16>,
    error_category: Option<&'static str>,
    terminal: TerminalState,
    max_assistant_id: Option<u64>,
}

impl ProbeResult {
    fn terminal_after(&self, baseline_id: Option<u64>, first_probe: bool) -> Option<TerminalState> {
        self.max_assistant_id
            .filter(|id| !first_probe && baseline_id.map_or(true, |baseline| *id > baseline))
            .and_then(|_| match self.terminal {
                TerminalState::Completed | TerminalState::Failed => Some(self.terminal),
                TerminalState::Running => None,
            })
    }
}

async fn probe(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    started_at_ms: i64,
) -> ProbeResult {
    let result = api_request_from_state(
        app,
        ApiRequestInput {
            path: session_messages_path(session_id),
            method: Some("GET".to_string()),
            headers: None,
            body: None,
            suppress_auth_expired_event: true,
        },
        state,
    )
    .await;
    match result {
        Ok(response) if response.ok => match parse_message_probe(&response.body) {
            Some(messages) => {
                let max_assistant_id = messages.iter().map(|m| m.id).max();
                let terminal = max_assistant_id
                    .and_then(|id| messages.iter().find(|m| m.id == id))
                    .filter(|m| message_started_after(m.timestamp_ms, started_at_ms))
                    .map(|m| m.terminal)
                    .unwrap_or(TerminalState::Running);
                ProbeResult {
                    ok: true,
                    status: Some(response.status),
                    error_category: None,
                    terminal,
                    max_assistant_id,
                }
            }
            None => ProbeResult {
                ok: false,
                status: Some(response.status),
                error_category: Some("parse"),
                terminal: TerminalState::Running,
                max_assistant_id: None,
            },
        },
        Ok(response) => ProbeResult {
            ok: false,
            status: Some(response.status),
            error_category: Some(if response.status == 401 || response.status == 403 {
                "auth"
            } else {
                "http"
            }),
            terminal: TerminalState::Running,
            max_assistant_id: None,
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
            terminal: TerminalState::Running,
            max_assistant_id: None,
        },
    }
}

#[derive(Debug, Clone, Copy)]
struct AssistantMessage {
    id: u64,
    timestamp_ms: Option<f64>,
    terminal: TerminalState,
}

fn session_messages_path(session_id: &str) -> String {
    format!(
        "/api/sessions/{}/messages?limit=50&order=latest",
        urlencoding::encode(session_id)
    )
}

fn parse_message_probe(body: &str) -> Option<Vec<AssistantMessage>> {
    if body.len() > MAX_PROBE_BODY_BYTES {
        return None;
    }
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let rows = root
        .get("messages")
        .or_else(|| root.get("data"))?
        .as_array()?;
    Some(
        rows.iter()
            .filter_map(|row| {
                if row.get("role")?.as_str()? != "assistant" {
                    return None;
                }
                let id = row.get("id")?.as_u64()?;
                let content = row.get("content")?;
                let nonempty = content.as_str().is_some_and(|s| !s.is_empty())
                    || content.as_array().is_some_and(|a| !a.is_empty());
                if !nonempty {
                    return Some(AssistantMessage {
                        id,
                        timestamp_ms: None,
                        terminal: TerminalState::Running,
                    });
                }
                let finish = row
                    .get("finish_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let terminal = match finish {
                    "stop" => TerminalState::Completed,
                    "error" | "failed" | "content_filter" => TerminalState::Failed,
                    _ => TerminalState::Running,
                };
                Some(AssistantMessage {
                    id,
                    timestamp_ms: row
                        .get("timestamp")
                        .and_then(|v| v.as_f64())
                        .map(|s| s * 1000.0),
                    terminal,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
fn match_terminal(body: &str, baseline_id: Option<u64>, started_at_ms: i64) -> TerminalState {
    let Some(messages) = parse_message_probe(body) else {
        return TerminalState::Running;
    };
    let Some(message) = messages.iter().max_by_key(|m| m.id) else {
        return TerminalState::Running;
    };
    if baseline_id.is_some_and(|id| message.id <= id)
        || !message_started_after(message.timestamp_ms, started_at_ms)
    {
        return TerminalState::Running;
    }
    message.terminal
}

fn message_started_after(timestamp_ms: Option<f64>, started_at_ms: i64) -> bool {
    started_at_ms == 0 || timestamp_ms.is_some_and(|ts| ts >= started_at_ms as f64)
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
        assert_eq!(
            session_messages_path("a/b ?"),
            "/api/sessions/a%2Fb%20%3F/messages?limit=50&order=latest"
        );
        assert_eq!(MAX_PLUGIN_UPDATE_FAILURES, 6);
        assert_eq!(
            ProbeResult {
                ok: false,
                status: Some(401),
                error_category: Some("auth"),
                terminal: TerminalState::Running,
                max_assistant_id: None,
            },
            ProbeResult {
                ok: false,
                status: Some(401),
                error_category: Some("auth"),
                terminal: TerminalState::Running,
                max_assistant_id: None,
            },
        );
    }

    #[test]
    fn message_matcher_uses_largest_assistant_id_and_baseline() {
        let body = r#"{"messages":[
          {"id":7,"role":"assistant","content":"old","finish_reason":"stop"},
          {"id":8,"role":"assistant","content":"new","finish_reason":"stop"},
          {"id":99,"role":"user","content":"later"}
        ]}"#;
        assert_eq!(match_terminal(body, Some(7), 0), TerminalState::Completed);
        assert_eq!(match_terminal(body, Some(8), 0), TerminalState::Running);
    }

    #[test]
    fn first_probe_only_establishes_baseline() {
        let body =
            r#"{"data":[{"id":12,"role":"assistant","content":"done","finish_reason":"stop"}]}"#;
        let result = ProbeResult {
            ok: true,
            status: Some(200),
            error_category: None,
            terminal: match_terminal(body, Some(11), 0),
            max_assistant_id: Some(12),
        };
        assert_eq!(result.terminal_after(Some(12), true), None);
        assert_eq!(
            result.terminal_after(Some(11), false),
            Some(TerminalState::Completed)
        );
    }

    #[test]
    fn tool_calls_does_not_fall_back_to_older_stop() {
        let body = r#"{"messages":[
          {"id":10,"role":"assistant","content":"done","finish_reason":"stop"},
          {"id":11,"role":"assistant","content":"tool","finish_reason":"tool_calls"}
        ]}"#;
        assert_eq!(match_terminal(body, Some(9), 0), TerminalState::Running);
    }

    #[test]
    fn failed_empty_and_malformed_messages_are_safe() {
        assert_eq!(
            match_terminal(
                r#"{"messages":[{"id":2,"role":"assistant","content":"x","finish_reason":"error"}]}"#,
                Some(1),
                0
            ),
            TerminalState::Failed
        );
        assert_eq!(
            match_terminal(
                r#"{"messages":[{"id":2,"role":"assistant","content":"","finish_reason":"stop"}]}"#,
                Some(1),
                0
            ),
            TerminalState::Running
        );
        assert_eq!(match_terminal("{", Some(1), 0), TerminalState::Running);
        assert!(parse_message_probe(&"x".repeat(1_048_577)).is_none());
    }

    #[test]
    fn timestamp_boundary_and_ready_timeout_contract_are_present() {
        assert!(message_started_after(Some(1_234.0), 1_000));
        assert!(!message_started_after(Some(999.0), 1_000));
        assert!(message_started_after(Some(1_999.0), 1_999));
        assert!(message_started_after(Some(2_000.0), 2_000));
        assert_eq!(READY_TIMEOUT_MS, 5_000);
    }

    #[test]
    fn ready_failure_is_fail_closed_and_cleans_the_matching_monitor() {
        let source = include_str!("session_foreground.rs");
        assert!(source.contains("let ready = tokio::time::timeout"));
        assert!(source.contains("matches!(ready.as_ref(), Ok(Ok(Ok(()))))"));
        assert!(source.contains("foreground_monitor_matches"));
        assert!(source.contains("monitor.handle.abort()"));
        assert!(source.contains("action: \"stop\".to_string()"));
        assert!(source.contains("baseline_timeout"));
        assert!(source.contains("foreground monitor failed to become ready"));
        assert!(source.contains("return Err(AppError::Internal("));
    }

    #[test]
    fn terminal_update_is_retried_before_any_ordinary_update() {
        let source = include_str!("session_foreground.rs");
        let terminal = source
            .find("if let Some(terminal) = result.terminal_after")
            .unwrap();
        let ordinary = source[terminal..].find("state: if result.ok").unwrap();
        assert!(source[terminal..].contains("tokio::time::sleep"));
        assert!(source[terminal..terminal + ordinary].contains("plugin_failures"));
        assert!(!source[terminal..terminal + ordinary].contains("terminal_update_attempted"));
    }

    #[test]
    fn every_monitor_plugin_update_is_owner_gated() {
        let source = include_str!("session_foreground.rs");
        assert!(source.contains("async fn plugin_if_foreground_monitor_owner"));
        assert!(source.contains("async fn terminal_plugin_if_foreground_monitor_owner"));
        assert!(
            source
                .matches("plugin_if_foreground_monitor_owner(")
                .count()
                >= 1
        );
        assert!(
            source
                .matches("terminal_plugin_if_foreground_monitor_owner(")
                .count()
                >= 1
        );
        assert!(
            source.contains("let _operation = state.session_foreground_operation.lock().await;")
        );
        assert!(source.contains("inner.session_foreground_monitor.take()"));
    }
}
