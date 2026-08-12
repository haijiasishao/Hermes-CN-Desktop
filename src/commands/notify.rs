// Native notification command (desktop + Android).
//
// 用户切到别的应用后，任务完成或卡在权限确认弹窗时毫无感知。`desktop_notify`
// 在一次 IPC 内完成「前台判定 → 系统通知 → 桌面端请求窗口注意力」。Android
// 通知权限由独立的 `notification_permission` 命令管理，后台事件绝不擅自弹权限框。
//
// 前台判定放在 Rust 侧：托盘隐藏 / 最小化时 webview 的 document.hasFocus()
// 不可靠，而 window.is_focused() 是权威信号；同时避免「前端查焦点 → 发通知」
// 之间的时间窗。
//
// 系统通知发送失败（例如 macOS 用户拒绝了通知授权）不算命令错误——写进
// 结果的 `error` 字段，前端据此回退到 WebAudio 提示音，绝不打断聊天主流程。

use serde::{Deserialize, Serialize};
#[cfg(all(feature = "desktop", not(target_os = "android")))]
use tauri::UserAttentionType;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;

const MAIN_WINDOW_LABEL: &str = "main";

const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotifyInput {
    /// "approval" | "complete" | "error" | "test"
    pub kind: String,
    pub title: String,
    pub body: String,
    /// 设置「系统通知」开关；关闭时仍可请求窗口注意力。
    pub show_system_notification: bool,
    /// 设置「提示音」开关：系统通知自带的原生声音。
    pub with_sound: bool,
    /// 设置「仅窗口在后台时通知」；测试按钮传 false 以便前台也能看到效果。
    pub respect_focus: bool,
    pub request_attention: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotifyResult {
    /// 系统通知已实际发出。
    pub delivered: bool,
    /// 平台调整后的有效前台判定（与 effective_foreground 相同）。
    /// 前端 shouldPlayFallbackSound 以此字段决定是否补播提示音。
    /// 在 Android 上等于 raw_focused（因为 is_visible() 不可靠）；
    /// 在桌面端等于 focused && !minimized && visible。
    pub focused: bool,
    /// raw is_visible() 原始查询结果（Android WebView 上此值不可靠，可能恒为 false）。
    pub visible: bool,
    /// raw is_focused() 原始查询结果（调用前台判定前的原始信号）。
    pub raw_focused: bool,
    /// raw is_visible() 原始查询结果（同 visible 字段；冗余命名便于前端诊断区分语义）。
    pub raw_visible: bool,
    /// 平台调整后的有效前台判定（与 focused 字段相同；明确命名避免歧义）。
    pub effective_foreground: bool,
    pub attention_requested: bool,
    /// 系统通知发送失败的原因（非致命，不走 Err）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionInput {
    /// false 只检查；true 才由用户操作触发 Android 系统权限请求。
    pub request: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermissionResult {
    pub state: String,
    pub granted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotifyKind {
    Approval,
    Complete,
    Error,
    Test,
}

fn parse_kind(kind: &str) -> Option<NotifyKind> {
    match kind {
        "approval" => Some(NotifyKind::Approval),
        "complete" => Some(NotifyKind::Complete),
        "error" => Some(NotifyKind::Error),
        "test" => Some(NotifyKind::Test),
        _ => None,
    }
}

/// 权限确认会阻塞任务，用 Critical（macOS dock 持续弹跳 / Windows 任务栏持续
/// 闪烁直到用户回来）；其余场景 Informational 提醒一次即可。
#[cfg(all(feature = "desktop", not(target_os = "android")))]
fn attention_type(kind: NotifyKind) -> UserAttentionType {
    match kind {
        NotifyKind::Approval => UserAttentionType::Critical,
        _ => UserAttentionType::Informational,
    }
}

/// 去掉控制字符并按 char 截断（多字节字符不会被截半）。
fn sanitize_text(input: &str, max_chars: usize) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn is_foreground(focused: bool, minimized: bool, visible: bool) -> bool {
    focused && !minimized && visible
}

/// Platform-aware foreground determination.
///
/// On Android, `is_visible()` from the Tauri WebView API is unreliable: it returns
/// `false` even when the Activity is fully in the foreground and the WebView has
/// focus. `is_focused()` IS reliable on Android (tracks Activity foreground / focus
/// state correctly), so we use it alone.
///
/// On desktop (macOS / Windows / Linux), both signals are reliable and the classic
/// `focused && !minimized && visible` rule applies.
///
/// `is_android` is a compile-time constant injected by callers so this function
/// is a plain pure function that can be unit-tested on any host.
pub(crate) fn compute_foreground(
    focused: bool,
    minimized: bool,
    visible: bool,
    is_android: bool,
) -> bool {
    if is_android {
        // Boundary: we rely on Tauri's is_focused() which tracks the Android
        // Activity focus state. If the app is fully backgrounded (Activity stopped),
        // is_focused() returns false. If the app is in the foreground with the
        // WebView active, is_focused() returns true. We cannot further distinguish
        // "screen off but Activity still technically resumed" via this API alone;
        // that edge case is acceptable since screen-off usually triggers is_focused()=false.
        focused
    } else {
        is_foreground(focused, minimized, visible)
    }
}

fn should_suppress(respect_focus: bool, foreground: bool) -> bool {
    respect_focus && foreground
}

fn system_sound_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Glass"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Default"
    }
}

fn permission_result(
    state: tauri_plugin_notification::PermissionState,
) -> NotificationPermissionResult {
    NotificationPermissionResult {
        state: state.to_string(),
        granted: matches!(state, tauri_plugin_notification::PermissionState::Granted),
    }
}

#[tauri::command]
pub async fn notification_permission(
    app: AppHandle,
    input: NotificationPermissionInput,
) -> Result<NotificationPermissionResult, AppError> {
    #[cfg(target_os = "android")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let mut state = app.notification().permission_state().map_err(|err| {
                AppError::Internal(format!(
                    "failed to check Android notification permission: {err}"
                ))
            })?;
            if input.request
                && !matches!(state, tauri_plugin_notification::PermissionState::Granted)
            {
                state = app.notification().request_permission().map_err(|err| {
                    AppError::Internal(format!(
                        "failed to request Android notification permission: {err}"
                    ))
                })?;
            }
            Ok(permission_result(state))
        })
        .await
        .map_err(|err| {
            AppError::Internal(format!("notification_permission task failed: {err}"))
        })?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, input);
        Ok(permission_result(
            tauri_plugin_notification::PermissionState::Granted,
        ))
    }
}

#[cfg(target_os = "android")]
fn notification_permission_error(app: &AppHandle) -> Option<String> {
    match app.notification().permission_state() {
        Ok(tauri_plugin_notification::PermissionState::Granted) => None,
        Ok(state) => Some(format!("Android 通知权限未授予（当前状态：{state}）")),
        Err(err) => Some(format!("无法检查 Android 通知权限：{err}")),
    }
}

#[cfg(not(target_os = "android"))]
fn notification_permission_error(_app: &AppHandle) -> Option<String> {
    None
}

// async + spawn_blocking：同步 command 在主线程上执行，而 `builder.show()`
// 是阻塞的系统调用（Linux 上经 zbus 走同步 D-Bus 往返），通知系统卡顿时会
// 冻结整个 UI；挪到阻塞线程池后主线程和 async runtime 都不受影响。
#[tauri::command]
pub async fn desktop_notify(
    app: AppHandle,
    input: DesktopNotifyInput,
) -> Result<DesktopNotifyResult, AppError> {
    let kind = parse_kind(&input.kind)
        .ok_or_else(|| AppError::InvalidRequest(format!("unknown notify kind: {}", input.kind)))?;
    let title = sanitize_text(&input.title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err(AppError::InvalidRequest(
            "notify title must not be empty".to_string(),
        ));
    }
    let body = sanitize_text(&input.body, MAX_BODY_CHARS);

    tauri::async_runtime::spawn_blocking(move || notify_blocking(&app, kind, &title, &body, &input))
        .await
        .map_err(|e| AppError::Internal(format!("desktop_notify task failed: {e}")))
}

fn notify_blocking(
    app: &AppHandle,
    kind: NotifyKind,
    title: &str,
    body: &str,
    input: &DesktopNotifyInput,
) -> DesktopNotifyResult {
    let window = app.get_webview_window(MAIN_WINDOW_LABEL);
    let (focused, visible, foreground) = window
        .as_ref()
        .map(|w| {
            // On a Tauri query error, bias every signal toward "not
            // foreground" so an uncertain window state still delivers the
            // notification: missing an approval prompt is the failure this
            // feature exists to prevent, a redundant toast is harmless.
            let focused = w.is_focused().unwrap_or(false);
            let visible = w.is_visible().unwrap_or(false);
            let foreground = {
                #[cfg(target_os = "android")]
                {
                    // On Android, is_visible() is unreliable on WebView activities
                    // and returns false even when the Activity is fully in the foreground.
                    // Pass is_android=true to compute_foreground so it uses only
                    // is_focused() as the authoritative foreground signal.
                    compute_foreground(focused, false, visible, true)
                }
                #[cfg(not(target_os = "android"))]
                {
                    compute_foreground(focused, w.is_minimized().unwrap_or(true), visible, false)
                }
            };
            (focused, visible, foreground)
        })
        .unwrap_or((false, false, false));

    if should_suppress(input.respect_focus, foreground) {
        return DesktopNotifyResult {
            delivered: false,
            focused: foreground,
            visible,
            raw_focused: focused,
            raw_visible: visible,
            effective_foreground: foreground,
            attention_requested: false,
            error: None,
        };
    }

    let mut delivered = false;
    let mut error = None;
    if input.show_system_notification {
        // Log permission state for diagnostics but don't gate on it —
        // the plugin's permission_state() can return stale results on
        // Android (e.g. user granted in system settings but the plugin
        // hasn't refreshed). The authoritative test is builder.show().
        if let Some(permission_hint) = notification_permission_error(app) {
            log::info!("Notification permission pre-check: {}", permission_hint);
        }
        {
            let mut builder = app.notification().builder().title(title).body(body);
            #[cfg(target_os = "android")]
            {
                if input.with_sound {
                    builder = builder.sound(system_sound_name());
                } else {
                    const SILENT_CHANNEL_ID: &str = "hermes-agent-silent";
                    let channel = tauri_plugin_notification::Channel::builder(
                        SILENT_CHANNEL_ID,
                        "Hermes Agent 静音通知",
                    )
                    .description("不播放声音的 Hermes Agent 后台提醒")
                    .importance(tauri_plugin_notification::Importance::Low)
                    .vibration(false)
                    .build();
                    match app.notification().create_channel(channel) {
                        Ok(()) => builder = builder.channel_id(SILENT_CHANNEL_ID),
                        Err(err) => log::warn!("Failed to prepare silent Android channel: {}", err),
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            if input.with_sound {
                builder = builder.sound(system_sound_name());
            }
            match builder.show() {
                Ok(()) => delivered = true,
                Err(err) => {
                    log::warn!("System notification failed: {}", err);
                    error = Some(err.to_string());
                }
            }
        }
    }

    #[cfg(all(feature = "desktop", not(target_os = "android")))]
    let mut attention_requested = false;
    #[cfg(all(feature = "desktop", not(target_os = "android")))]
    if input.request_attention && !foreground {
        if let Some(window) = window.as_ref() {
            match window.request_user_attention(Some(attention_type(kind))) {
                Ok(()) => attention_requested = true,
                Err(err) => log::debug!("request_user_attention failed: {}", err),
            }
        }
    }
    #[cfg(not(all(feature = "desktop", not(target_os = "android"))))]
    let attention_requested = {
        let _ = kind;
        false
    };

    DesktopNotifyResult {
        delivered,
        focused: foreground,
        visible,
        raw_focused: focused,
        raw_visible: visible,
        effective_foreground: foreground,
        attention_requested,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn parse_kind_accepts_known_kinds() {
        assert_eq!(parse_kind("approval"), Some(NotifyKind::Approval));
        assert_eq!(parse_kind("complete"), Some(NotifyKind::Complete));
        assert_eq!(parse_kind("error"), Some(NotifyKind::Error));
        assert_eq!(parse_kind("test"), Some(NotifyKind::Test));
    }

    #[test]
    fn parse_kind_rejects_unknown_kinds() {
        assert_eq!(parse_kind(""), None);
        assert_eq!(parse_kind("Approval"), None);
        assert_eq!(parse_kind("warn"), None);
    }

    #[test]
    #[cfg(all(feature = "desktop", not(target_os = "android")))]
    fn approval_uses_critical_attention_others_informational() {
        assert!(matches!(
            attention_type(NotifyKind::Approval),
            UserAttentionType::Critical
        ));
        assert!(matches!(
            attention_type(NotifyKind::Complete),
            UserAttentionType::Informational
        ));
        assert!(matches!(
            attention_type(NotifyKind::Error),
            UserAttentionType::Informational
        ));
        assert!(matches!(
            attention_type(NotifyKind::Test),
            UserAttentionType::Informational
        ));
    }

    #[test]
    fn sanitize_text_strips_control_chars_and_trims() {
        assert_eq!(
            sanitize_text("  hello\nworld\t!\u{0007} ", 100),
            "hello world !"
        );
    }

    #[test]
    fn sanitize_text_truncates_by_chars_not_bytes() {
        // 5 个中文字符截到 4：保留 3 个 + 省略号，不会在多字节边界 panic。
        assert_eq!(sanitize_text("一二三四五", 4), "一二三…");
        assert_eq!(sanitize_text("一二三四", 4), "一二三四");
    }

    #[test]
    fn sanitize_text_empty_input_stays_empty() {
        assert_eq!(sanitize_text("   \n\t  ", 10), "");
    }

    #[test]
    fn is_foreground_truth_table() {
        // Exhaustive: only (focused, !minimized, visible) is foreground.
        assert!(is_foreground(true, false, true));
        assert!(!is_foreground(false, false, true));
        assert!(!is_foreground(true, true, true));
        assert!(!is_foreground(true, false, false));
        assert!(!is_foreground(false, true, false));
        assert!(!is_foreground(true, true, false));
        assert!(!is_foreground(false, true, true));
        assert!(!is_foreground(false, false, false));
    }

    #[test]
    fn should_suppress_only_when_respecting_focus_in_foreground() {
        assert!(should_suppress(true, true));
        assert!(!should_suppress(true, false));
        assert!(!should_suppress(false, true));
        assert!(!should_suppress(false, false));
    }

    #[test]
    fn system_sound_name_matches_platform() {
        #[cfg(target_os = "macos")]
        assert_eq!(system_sound_name(), "Glass");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(system_sound_name(), "Default");
    }

    #[test]
    fn input_deserializes_from_camel_case() {
        let input: DesktopNotifyInput = serde_json::from_value(serde_json::json!({
            "kind": "approval",
            "title": "需要权限确认",
            "body": "rm -rf build",
            "showSystemNotification": true,
            "withSound": true,
            "respectFocus": true,
            "requestAttention": true,
        }))
        .unwrap();
        assert_eq!(input.kind, "approval");
        assert!(input.show_system_notification);
        assert!(input.with_sound);
        assert!(input.respect_focus);
        assert!(input.request_attention);
    }

    #[test]
    fn result_serializes_to_camel_case_and_skips_empty_error() {
        let ok = DesktopNotifyResult {
            delivered: true,
            focused: false,
            visible: true,
            raw_focused: false,
            raw_visible: true,
            effective_foreground: false,
            attention_requested: true,
            error: None,
        };
        let value = serde_json::to_value(&ok).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "delivered": true,
                "focused": false,
                "visible": true,
                "rawFocused": false,
                "rawVisible": true,
                "effectiveForeground": false,
                "attentionRequested": true,
            })
        );

        let failed = DesktopNotifyResult {
            delivered: false,
            focused: false,
            visible: false,
            raw_focused: false,
            raw_visible: false,
            effective_foreground: false,
            attention_requested: false,
            error: Some("denied".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap()["error"],
            serde_json::json!("denied")
        );
    }

    // ── compute_foreground ──────────────────────────────────────────────────

    #[test]
    fn compute_foreground_android_focused_true_is_foreground_regardless_of_visible() {
        // THE KEY FIX: on Android, is_visible() returns false even when the Activity
        // is in the foreground. compute_foreground(is_android=true) must NOT require
        // visible=true — it uses only focused (is_focused()) as the authoritative signal.
        //
        // Before fix: is_foreground(focused=true, minimized=false, visible=false) = false
        //   → foreground=false → should_suppress(respectFocus=true, false)=false → notification fires
        // After fix: compute_foreground(focused=true, ..., is_android=true) = true
        //   → foreground=true → should_suppress(true, true)=true → notification suppressed ✓
        assert!(
            compute_foreground(true, false, false, true),
            "Android: focused=true + visible=false must be treated as foreground \
             (is_visible() is unreliable on Android WebView)"
        );
        assert!(
            compute_foreground(true, false, true, true),
            "Android: focused=true + visible=true is also foreground"
        );
        assert!(
            !compute_foreground(false, false, true, true),
            "Android: focused=false must be background regardless of visible"
        );
        assert!(
            !compute_foreground(false, false, false, true),
            "Android: focused=false + visible=false is background"
        );
    }

    #[test]
    fn compute_foreground_desktop_preserves_existing_three_signal_rule() {
        // Desktop behaviour must be unchanged: focused && !minimized && visible.
        assert!(
            compute_foreground(true, false, true, false),
            "focused+visible+not-minimized"
        );
        assert!(
            !compute_foreground(false, false, true, false),
            "not-focused"
        );
        assert!(!compute_foreground(true, true, true, false), "minimized");
        assert!(
            !compute_foreground(true, false, false, false),
            "not-visible"
        );
    }

    #[test]
    fn android_foreground_suppresses_notification_when_respect_focus_true() {
        // Integration check: with the fix in place, an Android window that is
        // focused (but is_visible()=false) + respectFocus=true must suppress.
        let android_foreground = compute_foreground(true, false, false, true);
        assert!(android_foreground);
        assert!(should_suppress(true, android_foreground));
    }

    #[test]
    fn result_raw_diagnostic_fields_serialized_independently() {
        // Raw fields allow the frontend to log the exact platform signals that
        // led to the foreground determination, independently of the effective value.
        let result = DesktopNotifyResult {
            delivered: false,
            focused: true,  // effective foreground = true (Android: focused=true)
            visible: false, // raw_visible = false (Android is_visible() bug)
            raw_focused: true,
            raw_visible: false,
            effective_foreground: true,
            attention_requested: false,
            error: None,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["focused"], true, "focused = effective foreground");
        assert_eq!(v["visible"], false, "visible = raw is_visible()");
        assert_eq!(v["rawFocused"], true);
        assert_eq!(v["rawVisible"], false);
        assert_eq!(v["effectiveForeground"], true);
        // error absent when None
        assert!(v.get("error").is_none() || v["error"].is_null());
    }
}
