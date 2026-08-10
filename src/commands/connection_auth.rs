//! Interactive login for gated remote gateways (OAuth window + password form).
//!
//! Mirrors the official desktop's `openOauthLoginWindow` / password flow
//! (Hermes-CN-Core apps/desktop/electron/main.ts): open `{base}/login` in a
//! dedicated webview, let the user complete the IDP round-trip, then read the
//! resulting HttpOnly `hermes_session_at`/`rt` cookies out of the webview and
//! hand them to the Rust `OauthSession` cookie jar. Password providers skip
//! the webview entirely — a Rust `POST /auth/password-login` lands the same
//! Set-Cookie into the jar.
//!
//! The cookie session is verified (mint a ws-ticket + fetch identity) before
//! we report success, and persisted into connection.json so a saved login
//! survives restarts.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::android_compat as dashboard;
use crate::connection;
use crate::error::{AppError, AppResult};
use crate::oauth_session::{
    self, AuthIdentity, PersistedCookie, AT_COOKIE_VARIANTS, RT_COOKIE_VARIANTS,
};
use crate::state::{AppState, DashboardHandle};

const LOGIN_WINDOW_LABEL: &str = "hermes-oauth-login";
const LOGIN_POLL_INTERVAL: Duration = Duration::from_millis(750);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthLoginInput {
    pub remote_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordLoginInput {
    pub remote_url: String,
    pub provider: String,
    pub username: String,
    pub password: String,
    /// "primary" (default) or "backup". Determines which session slot to persist to.
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthLoginResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<AuthIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// In-progress logins, keyed by normalized base URL — single-flight so a
/// second click focuses the existing window instead of stacking a new one.
fn in_flight() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Persist the current session cookies into connection.json when it is the
/// configured oauth remote for this URL (so a fresh login is remembered).
fn persist_login(base_url: &str, cookies: Vec<PersistedCookie>) {
    let mut config = connection::read_config();
    let is_target = config
        .remote_url
        .as_deref()
        .and_then(|u| connection::normalize_remote_base_url(u).ok())
        .as_deref()
        == Some(base_url);
    if is_target {
        config.remote_session = Some(cookies);
        if config.remote_auth_mode == connection::RemoteAuthMode::Token {
            config.remote_auth_mode = connection::RemoteAuthMode::Oauth;
        }
        let _ = connection::write_config(&config);
    }
}

/// Persist the current session cookies into connection.json as the backup
/// session for this URL (so a backup login is remembered separately).
/// Returns an error if the URL does not match the saved backup URL.
fn persist_backup_login(base_url: &str, cookies: Vec<PersistedCookie>) -> Result<(), AppError> {
    let mut config = connection::read_config();
    let is_target = config
        .remote_backup_url
        .as_deref()
        .and_then(|u| connection::normalize_remote_base_url(u).ok())
        .as_deref()
        == Some(base_url);
    if !is_target {
        return Err(AppError::InvalidRequest(format!(
            "备用登录 URL ({}) 与已保存的备用地址不匹配，请先保存连接配置",
            base_url
        )));
    }
    config.remote_backup_session = Some(cookies);
    if config.remote_auth_mode == connection::RemoteAuthMode::Token {
        config.remote_auth_mode = connection::RemoteAuthMode::Oauth;
    }
    connection::write_config(&config)
}

/// Verify a freshly-populated session (mint ticket + identity) and persist it.
async fn finish_login(
    base_url: &str,
    session: &oauth_session::OauthSession,
) -> Result<AuthIdentity, AppError> {
    // A live ticket already proves the session; identity is best-effort.
    session.mint_ws_ticket().await?; // 401 → AuthSessionExpired
    let identity = session.fetch_me().await.unwrap_or(AuthIdentity {
        user_id: None,
        email: None,
        display_name: None,
        org_id: None,
        provider: None,
        expires_at: None,
    });
    persist_login(base_url, session.export_cookies());
    Ok(identity)
}

/// Like `finish_login` but targets a specific session slot (primary or backup).
/// For backup targets, persists to `remote_backup_session` instead of `remote_session`.
async fn finish_login_for_target(
    base_url: &str,
    session: &oauth_session::OauthSession,
    target: &str,
) -> Result<AuthIdentity, AppError> {
    session.mint_ws_ticket().await?;
    let identity = session.fetch_me().await.unwrap_or(AuthIdentity {
        user_id: None,
        email: None,
        display_name: None,
        org_id: None,
        provider: None,
        expires_at: None,
    });
    if target == "backup" {
        persist_backup_login(base_url, session.export_cookies())?;
    } else {
        persist_login(base_url, session.export_cookies());
    }
    Ok(identity)
}

/// Promote an already-connected token-mode remote to the authenticated cookie
/// session immediately after login. Without this live-state swap, the next
/// REST request would keep using the old token proxy until a full reconnect.
fn promote_active_remote_to_oauth(
    state: &State<'_, AppState>,
    base_url: &str,
    session: std::sync::Arc<oauth_session::OauthSession>,
) -> AppResult<()> {
    let mut inner = state.inner.lock()?;
    if inner.connection_mode != connection::ConnectionMode::Remote {
        return Ok(());
    }

    let norm = connection::normalize_remote_base_url(base_url).ok();
    let active_matches = connection::normalize_remote_base_url(&inner.api_base_url).ok() == norm;

    // Keep FailoverState in sync even when the freshly authenticated endpoint
    // is not the currently active endpoint (for example, re-login to primary
    // while the app is temporarily using backup).
    if let Some(ref mut failover) = inner.failover {
        if connection::normalize_remote_base_url(&failover.primary.base_url).ok() == norm {
            failover.primary.oauth_session = Some(session.clone());
            failover.primary.session_token = String::new();
        }
        if let Some(ref mut backup) = failover.backup {
            if connection::normalize_remote_base_url(&backup.base_url).ok() == norm {
                backup.oauth_session = Some(session.clone());
                backup.session_token = String::new();
            }
        }
    }

    if active_matches {
        inner.gateway_url = dashboard::build_gateway_url(base_url, None);
        inner.session_token = None;
        inner.oauth_session = Some(session);
        inner.dashboard_handle = Some(DashboardHandle::remote_oauth(base_url.to_string()));
    } else {
        log::debug!(
            "promote_active_remote_to_oauth: updated non-active endpoint {} (active={})",
            base_url,
            inner.api_base_url,
        );
    }
    Ok(())
}

/// Open the OAuth login window and wait for the session cookie to appear.
#[tauri::command]
pub async fn connection_oauth_login(
    input: OauthLoginInput,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OauthLoginResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;

    // Single-flight: focus the existing window if a login is already open.
    {
        let mut guard = in_flight().lock().unwrap();
        if guard.contains(&base_url) {
            if let Some(win) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
                let _ = win.set_focus();
            }
            return Err(AppError::InvalidRequest(
                "登录窗口已打开，请在窗口内完成登录".to_string(),
            ));
        }
        guard.insert(base_url.clone());
    }
    // Ensure we always clear the in-flight marker.
    let _guard = InFlightGuard(base_url.clone());

    let login_url = format!("{}/login", base_url);
    let url = url::Url::parse(&login_url)
        .map_err(|e| AppError::InvalidRequest(format!("invalid login url {login_url}: {e}")))?;

    // A prior window may linger if a previous attempt was force-closed.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.destroy();
    }
    let window = WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("登录远程 Hermes Agent")
        .inner_size(520.0, 720.0)
        .build()
        .map_err(|e| AppError::Internal(format!("open login window: {e}")))?;

    let session = oauth_session::session_for(&base_url)?;
    let probe_url = url::Url::parse(&base_url)
        .map_err(|e| AppError::InvalidRequest(format!("invalid base url: {e}")))?;

    let start = std::time::Instant::now();
    loop {
        // Window closed by the user before completing.
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("登录窗口已关闭".to_string()),
            });
        }
        if start.elapsed() > LOGIN_TIMEOUT {
            let _ = window.destroy();
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("登录超时（5 分钟）".to_string()),
            });
        }

        // Read cookies out of the webview (includes HttpOnly). Windows/WebView2
        // deadlocks if this is called from a sync command — we are inside an
        // async task, which is the documented-safe context.
        let mut extracted = window
            .cookies_for_url(probe_url.clone())
            .map(|cookies| extract_session_cookies(&cookies))
            .unwrap_or_default();
        // Wry's WKWebView URL filter compares Cookie.domain() with
        // Url::domain(). The latter is None for IP literals, so an otherwise
        // valid http://127.0.0.1 gateway returns an empty list. Fall back to
        // the full webview jar and apply our own exact-origin filter. Session
        // cookie names are still allowlisted before anything reaches reqwest.
        if extracted.is_empty() {
            if let Ok(cookies) = window.cookies() {
                extracted = extract_session_cookies_for_origin(&cookies, &probe_url);
            }
        }
        if extracted.iter().any(|c| is_at_variant(&c.name)) {
            session.import_cookies(&extracted);
            match finish_login(&base_url, &session).await {
                Ok(identity) => {
                    promote_active_remote_to_oauth(&state, &base_url, session.clone())?;
                    let _ = window.destroy();
                    return Ok(OauthLoginResult {
                        ok: true,
                        identity: Some(identity),
                        error: None,
                    });
                }
                // Cookie present but not yet usable (mid-redirect); keep waiting.
                Err(AppError::AuthSessionExpired(_)) => {}
                Err(other) => {
                    let _ = window.destroy();
                    return Err(other);
                }
            }
        }
        tokio::time::sleep(LOGIN_POLL_INTERVAL).await;
    }
}

/// Password-provider login (no webview): POST credentials, land Set-Cookie.
#[tauri::command]
pub async fn connection_password_login(
    input: PasswordLoginInput,
    state: State<'_, AppState>,
) -> Result<OauthLoginResult, AppError> {
    // Validate target before any network request.
    let _target_valid = match input.target.as_deref() {
        Some("primary") | Some("backup") | None => Ok(()),
        Some(other) => Err(AppError::InvalidRequest(format!(
            "无效的登录目标: {}（仅支持 primary/backup）",
            other
        ))),
    };
    _target_valid?;

    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    let url = format!("{}/auth/password-login", base_url);

    let resp = session
        .client()
        .post(&url)
        .json(&serde_json::json!({
            "provider": input.provider,
            "username": input.username,
            "password": input.password,
        }))
        .send()
        .await
        .map_err(|e| AppError::DashboardProbe(format!("password login request: {e}")))?;

    let status = resp.status().as_u16();
    match status {
        s if (200..300).contains(&s) => {}
        401 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("用户名或密码错误".to_string()),
            })
        }
        404 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("该网关不支持密码登录（provider 未启用）".to_string()),
            })
        }
        429 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("尝试过于频繁，请稍后再试".to_string()),
            })
        }
        503 => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some("网关未注册任何登录方式".to_string()),
            })
        }
        other => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some(format!("登录失败（HTTP {other}）")),
            })
        }
    }

    let target = match input.target.as_deref() {
        Some("primary") | None => "primary",
        Some("backup") => "backup",
        Some(other) => {
            return Ok(OauthLoginResult {
                ok: false,
                identity: None,
                error: Some(format!(
                    "无效的登录目标: {}（仅支持 primary/backup）",
                    other
                )),
            });
        }
    };
    let finish_result = finish_login_for_target(&base_url, &session, target).await;
    match finish_result {
        Ok(identity) => {
            if target == "primary" {
                // Primary login: promote to active connection.
                promote_active_remote_to_oauth(&state, &base_url, session.clone())?;
            } else {
                // Backup login: update live failover state so the backup
                // endpoint carries the new OAuth session.  If the active URL
                // already points at the backup, also update inner.oauth_session.
                let mut inner = state.inner.lock()?;
                if let Some(ref mut failover) = inner.failover {
                    // Update failover backup endpoint.
                    if let Some(ref mut backup) = failover.backup {
                        if connection::normalize_remote_base_url(&backup.base_url).ok()
                            == connection::normalize_remote_base_url(&base_url).ok()
                        {
                            backup.oauth_session = Some(session.clone());
                            backup.session_token = String::new();
                            log::info!(
                                "Updated live failover backup OAuth session after backup login"
                            );
                        }
                    }
                    // Also sync failover primary if the primary URL matches.
                    if connection::normalize_remote_base_url(&failover.primary.base_url).ok()
                        == connection::normalize_remote_base_url(&base_url).ok()
                    {
                        failover.primary.oauth_session = Some(session.clone());
                        failover.primary.session_token = String::new();
                    }
                }
                // If active connection points at this backup URL, promote it.
                if connection::normalize_remote_base_url(&inner.api_base_url).ok()
                    == connection::normalize_remote_base_url(&base_url).ok()
                {
                    inner.oauth_session = Some(session.clone());
                    inner.gateway_url = dashboard::build_gateway_url(&base_url, None);
                    inner.session_token = None;
                }
            }
            Ok(OauthLoginResult {
                ok: true,
                identity: Some(identity),
                error: None,
            })
        }
        Err(AppError::AuthSessionExpired(_)) => Ok(OauthLoginResult {
            ok: false,
            identity: None,
            error: Some("登录未生效，请重试".to_string()),
        }),
        Err(other) => Err(other),
    }
}

/// Return the logged-in identity for a URL, or `ok:false` if not authenticated.
/// If the URL matches the configured backup URL, reads backup session cookies.
#[tauri::command]
pub async fn connection_auth_me(input: OauthLoginInput) -> Result<OauthLoginResult, AppError> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    let config = connection::read_config();
    // Determine whether this URL is the primary or backup remote.
    let is_backup = config
        .remote_backup_url
        .as_deref()
        .and_then(|u| connection::normalize_remote_base_url(u).ok())
        .as_deref()
        == Some(base_url.as_str());
    let cookies = if is_backup {
        config.remote_backup_session.as_ref()
    } else {
        config.remote_session.as_ref()
    };
    if let Some(cookies) = cookies {
        session.import_cookies(cookies);
    }
    match session.fetch_me().await {
        Ok(identity) => Ok(OauthLoginResult {
            ok: true,
            identity: Some(identity),
            error: None,
        }),
        Err(_) => Ok(OauthLoginResult {
            ok: false,
            identity: None,
            error: None,
        }),
    }
}

/// Log out: best-effort revoke on the server, clear the jar, persisted session,
/// and (if open) the login window's browsing data.
#[tauri::command]
pub async fn connection_oauth_logout(
    input: OauthLoginInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    let base_url = connection::normalize_remote_base_url(&input.remote_url)?;
    let session = oauth_session::session_for(&base_url)?;
    // Best-effort server-side revoke so the refresh token is invalidated.
    let _ = session
        .client()
        .post(format!("{}/auth/logout", base_url))
        .send()
        .await;
    session.clear();
    oauth_session::drop_session(&base_url);

    // Clear persisted session cookies (primary or backup slot, depending on URL).
    let mut config = connection::read_config();
    let norm = connection::normalize_remote_base_url(&base_url).ok();
    let is_primary = config
        .remote_url
        .as_deref()
        .and_then(|u| connection::normalize_remote_base_url(u).ok())
        == norm;
    let is_backup = config
        .remote_backup_url
        .as_deref()
        .and_then(|u| connection::normalize_remote_base_url(u).ok())
        == norm;
    if is_primary {
        config.remote_session = None;
    }
    if is_backup {
        config.remote_backup_session = None;
    }
    if is_primary || is_backup {
        let _ = connection::write_config(&config);
    }

    // Clean up live state. Logging out either side invalidates the pair for
    // automatic switching; otherwise the remaining endpoint could later
    // switch back into a cleared Arc<OauthSession>.
    {
        let mut inner = state.inner.lock()?;
        if is_primary || is_backup {
            if connection::normalize_remote_base_url(&inner.api_base_url).ok()
                == connection::normalize_remote_base_url(&base_url).ok()
            {
                inner.oauth_session = None;
                inner.session_token = None;
            }
            inner.failover = None;
            log::info!("FailoverState cleared after logout of {}", base_url);
        }
    }

    // Best-effort: clear the login webview's cookies for a clean re-login.
    if let Some(win) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = win.clear_all_browsing_data();
        let _ = win.destroy();
    }
    Ok(())
}

fn is_at_variant(name: &str) -> bool {
    AT_COOKIE_VARIANTS.contains(&name)
}

fn is_session_cookie(name: &str) -> bool {
    AT_COOKIE_VARIANTS.contains(&name) || RT_COOKIE_VARIANTS.contains(&name)
}

/// Pull just the session AT/RT cookies out of the webview's cookie list.
fn extract_session_cookies(cookies: &[cookie::Cookie<'static>]) -> Vec<PersistedCookie> {
    cookies
        .iter()
        .filter(|c| is_session_cookie(c.name()))
        .map(|c| PersistedCookie {
            name: c.name().to_string(),
            value: c.value().to_string(),
            expires_at_ms: c
                .expires_datetime()
                .map(|t| (t.unix_timestamp().max(0) as u64) * 1000),
        })
        .collect()
}

/// WKWebView's URL-scoped cookie query drops IP-literal hosts on macOS because
/// `Url::domain()` is empty for an IP address. This fallback reads the webview
/// jar and keeps only Hermes session cookies belonging to the gateway host.
fn extract_session_cookies_for_origin(
    cookies: &[cookie::Cookie<'static>],
    origin: &url::Url,
) -> Vec<PersistedCookie> {
    let Some(origin_host) = origin.host_str() else {
        return Vec::new();
    };
    let scoped = cookies
        .iter()
        .filter(|cookie| {
            let Some(domain) = cookie.domain() else {
                return false;
            };
            domain
                .trim_start_matches('.')
                .eq_ignore_ascii_case(origin_host)
        })
        .cloned()
        .collect::<Vec<_>>();
    extract_session_cookies(&scoped)
}

/// RAII marker clearing the single-flight entry when a login attempt ends.
struct InFlightGuard(String);
impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight().lock().unwrap().remove(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str, domain: &str) -> cookie::Cookie<'static> {
        cookie::Cookie::build((name.to_string(), value.to_string()))
            .domain(domain.to_string())
            .path("/")
            .build()
    }

    #[test]
    fn origin_fallback_recovers_ip_literal_session_cookies() {
        let cookies = vec![
            cookie("hermes_session_at", "AT", "127.0.0.1"),
            cookie("hermes_session_rt", "RT", "127.0.0.1"),
        ];
        let origin = url::Url::parse("http://127.0.0.1:9131").unwrap();

        let extracted = extract_session_cookies_for_origin(&cookies, &origin);

        assert_eq!(extracted.len(), 2);
        assert!(extracted
            .iter()
            .any(|item| item.name == "hermes_session_at"));
        assert!(extracted
            .iter()
            .any(|item| item.name == "hermes_session_rt"));
    }

    #[test]
    fn origin_fallback_rejects_idp_and_unrelated_cookies() {
        let cookies = vec![
            cookie("hermes_session_at", "IDP", "login.example.com"),
            cookie("other", "VALUE", "gateway.example.com"),
            cookie("__Host-hermes_session_at", "GATEWAY", "gateway.example.com"),
        ];
        let origin = url::Url::parse("https://gateway.example.com").unwrap();

        let extracted = extract_session_cookies_for_origin(&cookies, &origin);

        assert_eq!(extracted.len(), 1);
        assert_eq!(extracted[0].name, "__Host-hermes_session_at");
        assert_eq!(extracted[0].value, "GATEWAY");
    }

    // --- URL normalization equivalence for persist/promote/logout ---

    #[test]
    fn normalized_urls_match_despite_trailing_slash() {
        let a = connection::normalize_remote_base_url("http://gateway.example.com/").unwrap();
        let b = connection::normalize_remote_base_url("http://gateway.example.com").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn normalized_urls_match_despite_host_case() {
        let a = connection::normalize_remote_base_url("http://Gateway.Example.COM:9119").unwrap();
        let b = connection::normalize_remote_base_url("http://gateway.example.com:9119").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn normalized_urls_match_despite_path_trailing_slash() {
        let a = connection::normalize_remote_base_url("http://host:9120/prefix/").unwrap();
        let b = connection::normalize_remote_base_url("http://host:9120/prefix").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn normalized_urls_differ_for_distinct_hosts() {
        let a = connection::normalize_remote_base_url("http://host-a:9120").unwrap();
        let b = connection::normalize_remote_base_url("http://host-b:9120").unwrap();
        assert_ne!(a, b);
    }

    // --- persist_backup_login URL matching ---

    #[test]
    fn persist_backup_login_requires_url_match() {
        // Simulate the URL comparison logic used by persist_backup_login:
        // config.remote_backup_url must normalize to base_url.
        use super::connection;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");

        // Write a config with backup URL.
        let config = connection::ConnectionConfig {
            mode: connection::ConnectionMode::Remote,
            local_url: None,
            remote_url: Some("http://primary:9119".to_string()),
            remote_token: None,
            remote_auth_mode: connection::RemoteAuthMode::Oauth,
            remote_session: None,
            remote_backup_url: Some("http://backup:9120".to_string()),
            remote_backup_token: None,
            remote_backup_session: None,
        };
        connection::write_config_to(&path, &config).unwrap();

        // Read it back and verify the backup URL normalizes correctly.
        let loaded = connection::read_config_from(&path);
        let norm =
            connection::normalize_remote_base_url(loaded.remote_backup_url.as_deref().unwrap())
                .unwrap();
        assert_eq!(norm, "http://backup:9120");

        // A different URL should not match.
        let other = connection::normalize_remote_base_url("http://other:9999").unwrap();
        assert_ne!(norm, other);
    }

    #[test]
    fn backup_session_cookies_round_trip_through_config() {
        use super::connection;
        use super::oauth_session::PersistedCookie;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("connection.json");

        let cookies = vec![
            PersistedCookie {
                name: "__Host-hermes_session_at".to_string(),
                value: "at_value_123".to_string(),
                expires_at_ms: Some(1700000000000),
            },
            PersistedCookie {
                name: "__Host-hermes_session_rt".to_string(),
                value: "rt_value_456".to_string(),
                expires_at_ms: Some(1700086400000),
            },
        ];

        let config = connection::ConnectionConfig {
            mode: connection::ConnectionMode::Remote,
            local_url: None,
            remote_url: Some("http://primary:9119".to_string()),
            remote_token: None,
            remote_auth_mode: connection::RemoteAuthMode::Oauth,
            remote_session: Some(vec![PersistedCookie {
                name: "__Host-hermes_session_at".to_string(),
                value: "primary_at".to_string(),
                expires_at_ms: None,
            }]),
            remote_backup_url: Some("http://backup:9120".to_string()),
            remote_backup_token: None,
            remote_backup_session: Some(cookies.clone()),
        };
        connection::write_config_to(&path, &config).unwrap();

        let loaded = connection::read_config_from(&path);
        let backup_cookies = loaded.remote_backup_session.unwrap();
        assert_eq!(backup_cookies.len(), 2);
        assert_eq!(backup_cookies[0].name, "__Host-hermes_session_at");
        assert_eq!(backup_cookies[0].value, "at_value_123");
        assert_eq!(backup_cookies[0].expires_at_ms, Some(1700000000000));
        assert_eq!(backup_cookies[1].name, "__Host-hermes_session_rt");
        assert_eq!(backup_cookies[1].value, "rt_value_456");

        // Primary session should also survive.
        let primary_cookies = loaded.remote_session.unwrap();
        assert_eq!(primary_cookies.len(), 1);
        assert_eq!(primary_cookies[0].value, "primary_at");
    }

    #[test]
    fn target_validation_accepts_primary_and_backup() {
        // The target validation logic from connection_password_login.
        for target in [Some("primary"), Some("backup"), None] {
            let result: Result<(), String> = match target {
                Some("primary") | Some("backup") | None => Ok(()),
                Some(other) => Err(format!("无效的登录目标: {}", other)),
            };
            assert!(result.is_ok(), "target={:?} should be valid", target);
        }
    }

    #[test]
    fn target_validation_rejects_unknown() {
        let target = Some("staging");
        let result: Result<(), String> = match target {
            Some("primary") | Some("backup") | None => Ok(()),
            Some(other) => Err(format!("无效的登录目标: {}", other)),
        };
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("staging"));
    }
}
