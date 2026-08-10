// HTTP proxy commands: api_request, external_request, upload_file.
//
// Replaces the Electron ipcMain handlers at
// hermes-cn-ui-v1/apps/desktop/src/main/main.ts lines 532-650.
//
// api_request is the most complex: it intercepts certain routes locally
// (session logs, archive, runtime update) and proxies everything else
// to the hermes dashboard with auth header injection.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::android_compat::{build_gateway_url, fetch_session_token};
use crate::cron_runs;
use crate::error::AppError;
use crate::session_archive;
use crate::session_log;
use crate::state::AppState;

const SESSION_LOG_ROUTE_PREFIX: &str = "/__hermes_session_log/";
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(15);
const DASHBOARD_PROXY_TIMEOUT: Duration = Duration::from_secs(30);
const DASHBOARD_AUDIO_PROXY_TIMEOUT: Duration = Duration::from_secs(180);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_UPLOAD_BASE64_LEN: usize = MAX_UPLOAD_BYTES.div_ceil(3) * 4;
const MAX_EXTERNAL_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXTERNAL_IMAGE_REDIRECTS: usize = 5;
// Dashboard-facing clients never follow redirects: a gated dashboard answers
// unauthenticated requests with 401 JSON, but a misconfigured one could 302 →
// /login. Following that silently would turn a 401 into a 200 whose body is
// login-page HTML (and drop auth headers on a cross-host hop). Fail loud.
static DASHBOARD_PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DASHBOARD_PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid dashboard proxy HTTP client")
});
static DASHBOARD_AUDIO_PROXY_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DASHBOARD_AUDIO_PROXY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid dashboard audio proxy HTTP client")
});
static UPLOAD_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid upload HTTP client")
});
static EXTERNAL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(EXTERNAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid external HTTP client")
});

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestResult {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageInput {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageResult {
    pub final_url: String,
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: usize,
}

fn json_result(status: u16, status_text: &str, body: serde_json::Value) -> ApiRequestResult {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text: status_text.to_string(),
        headers,
        body: serde_json::to_string(&body).unwrap_or_default(),
    }
}

/// Extract the URL path component (strip query string).
fn url_path(path: &str) -> String {
    if let Ok(url) = url::Url::parse(&format!("http://x{}", path)) {
        url.path().to_string()
    } else {
        path.split('?').next().unwrap_or(path).to_string()
    }
}

fn is_audio_api_path(path: &str) -> bool {
    url_path(path).starts_with("/api/audio/")
}

fn upload_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "upload_file exceeds {} MiB limit",
        MAX_UPLOAD_BYTES / 1024 / 1024
    ))
}

fn external_image_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "download_external_image exceeds {} MiB limit",
        MAX_EXTERNAL_IMAGE_BYTES / 1024 / 1024
    ))
}

fn ensure_upload_base64_size(encoded_len: usize) -> Result<(), AppError> {
    if encoded_len > MAX_UPLOAD_BASE64_LEN {
        return Err(upload_limit_error());
    }
    Ok(())
}

fn ensure_upload_decoded_size(decoded_len: usize) -> Result<(), AppError> {
    if decoded_len > MAX_UPLOAD_BYTES {
        return Err(upload_limit_error());
    }
    Ok(())
}

fn is_blocked_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_blocked_external_ip(IpAddr::V4(v4)))
        }
    }
}

fn is_allowed_local_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

fn is_allowed_local_external_domain(host: &str) -> bool {
    let lower_host = host.trim_end_matches('.').to_ascii_lowercase();
    lower_host == "localhost" || lower_host.ends_with(".localhost")
}

fn is_allowed_local_external_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => is_allowed_local_external_domain(host),
        Some(url::Host::Ipv4(ip)) => is_allowed_local_external_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_allowed_local_external_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn validate_external_url_shape(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw)?;
    let is_local_url = is_allowed_local_external_url(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && is_local_url) {
        return Err(AppError::InvalidRequest(
            "external_request only allows https URLs; http is only allowed for local URLs"
                .to_string(),
        ));
    }

    match url.host().ok_or_else(|| {
        AppError::InvalidRequest("external_request URL must include a host".to_string())
    })? {
        url::Host::Domain(_) => {}
        url::Host::Ipv4(ip) => {
            let ip = IpAddr::V4(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
        url::Host::Ipv6(ip) => {
            let ip = IpAddr::V6(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

async fn validate_external_url(raw: &str) -> Result<url::Url, AppError> {
    let url = validate_external_url_shape(raw)?;

    if let Some(url::Host::Domain(host)) = url.host() {
        if is_allowed_local_external_domain(host) {
            return Ok(url);
        }
        let port = url.port_or_known_default().ok_or_else(|| {
            AppError::InvalidRequest("external_request URL must include a port".to_string())
        })?;
        let resolved = tokio::net::lookup_host((host, port)).await.map_err(|e| {
            AppError::InvalidRequest(format!("external_request DNS lookup failed: {}", e))
        })?;
        for addr in resolved {
            if is_blocked_external_ip(addr.ip()) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses hosts resolving to private or local IPs".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn url_path_strips_query_string() {
        assert_eq!(url_path("/api/foo?bar=1&baz=2"), "/api/foo");
    }

    #[test]
    fn url_path_passes_through_without_query() {
        assert_eq!(url_path("/api/foo"), "/api/foo");
    }

    #[test]
    fn url_path_handles_empty_path() {
        assert_eq!(url_path(""), "/");
    }

    #[test]
    fn url_path_handles_root() {
        assert_eq!(url_path("/"), "/");
    }

    #[test]
    fn audio_api_path_matches_audio_routes_with_queries() {
        assert!(is_audio_api_path("/api/audio/transcribe"));
        assert!(is_audio_api_path("/api/audio/speak?debug=1"));
        assert!(!is_audio_api_path("/api/model/info"));
    }

    #[test]
    fn json_result_2xx_is_ok() {
        let r = json_result(200, "OK", serde_json::json!({"x": 1}));
        assert!(r.ok);
        assert_eq!(r.status, 200);
        assert_eq!(r.status_text, "OK");
        assert_eq!(
            r.headers.get("content-type"),
            Some(&"application/json".to_string())
        );
        assert_eq!(r.body, "{\"x\":1}");
    }

    #[test]
    fn json_result_4xx_is_not_ok() {
        let r = json_result(404, "Not Found", serde_json::json!({"message": "nope"}));
        assert!(!r.ok);
        assert_eq!(r.status, 404);
    }

    #[test]
    fn json_result_5xx_is_not_ok() {
        let r = json_result(503, "Down", serde_json::json!(null));
        assert!(!r.ok);
        assert_eq!(r.status, 503);
    }

    #[test]
    fn json_result_boundary_300_is_not_ok() {
        // 300..399 redirects are explicitly not "ok" by this convention.
        let r = json_result(301, "Moved", serde_json::json!(null));
        assert!(!r.ok);
    }

    #[test]
    fn upload_base64_limit_is_checked_before_decode() {
        assert!(ensure_upload_base64_size(MAX_UPLOAD_BASE64_LEN).is_ok());
        let err = ensure_upload_base64_size(MAX_UPLOAD_BASE64_LEN + 1).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(msg) if msg.contains("100 MiB")));
    }

    #[test]
    fn upload_decoded_limit_is_checked_after_decode() {
        assert!(ensure_upload_decoded_size(MAX_UPLOAD_BYTES).is_ok());
        let err = ensure_upload_decoded_size(MAX_UPLOAD_BYTES + 1).unwrap_err();
        assert!(matches!(err, AppError::InvalidRequest(msg) if msg.contains("100 MiB")));
    }

    #[test]
    fn external_url_shape_requires_https() {
        let err = validate_external_url_shape("http://api.example.com/models").unwrap_err();
        assert!(err.to_string().contains("only allows https"));
    }

    #[test]
    fn external_url_shape_accepts_local_http_targets() {
        for raw in [
            "http://localhost:1234/v1/models",
            "http://service.localhost:1234/v1/models",
            "http://127.0.0.1:1234/v1/models",
            "http://0.0.0.0:1234/v1/models",
            "http://[::1]:1234/v1/models",
        ] {
            let url = validate_external_url_shape(raw).unwrap();
            assert_eq!(url.scheme(), "http");
        }
    }

    #[tokio::test]
    async fn external_url_allows_localhost_without_dns_rejection() {
        let url = validate_external_url("http://localhost:1234/v1/models")
            .await
            .unwrap();
        assert_eq!(url.host_str(), Some("localhost"));
    }

    #[test]
    fn external_url_shape_rejects_private_ip_literals() {
        for raw in [
            "https://10.0.0.1/status",
            "https://172.16.0.1/status",
            "https://192.168.1.1/status",
            "https://169.254.169.254/latest/meta-data",
            "https://[fc00::1]/status",
            "https://[fe80::1]/status",
        ] {
            let err = validate_external_url_shape(raw).unwrap_err();
            assert!(
                err.to_string().contains("private or local")
                    || err.to_string().contains("localhost"),
                "unexpected error for {raw}: {err}"
            );
        }
    }

    #[test]
    fn auth_expired_detection_requires_a_401_auth_envelope() {
        assert!(should_emit_auth_expired(
            401,
            r#"{"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}"#,
        ));
        assert!(!should_emit_auth_expired(
            502,
            r#"{"error":"unauthenticated"}"#,
        ));
        assert!(!should_emit_auth_expired(401, r#"{"error":"other"}"#));
    }

    #[test]
    fn external_url_shape_accepts_public_https_hosts() {
        let url = validate_external_url_shape("https://api.example.com/v1/models").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.example.com"));
    }
}

/// Core implementation of `api_request` with no Tauri State dependency.
/// Exposed for integration tests; production callers go through the
/// `#[tauri::command]` wrapper below.
pub async fn api_request_impl(
    input: ApiRequestInput,
    api_base_url: &str,
    session_token: Option<&str>,
    hermes_home: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_with_home_base(input, api_base_url, session_token, hermes_home, hermes_home)
        .await
}

/// How the proxied dashboard request authenticates.
enum ProxyAuth<'a> {
    /// Legacy loopback/local/remote-token: inject Bearer + X-Hermes-Session-Token.
    Token(Option<&'a str>),
    /// Gated remote: use the cookie-aware session client, inject no headers.
    Oauth(&'a crate::oauth_session::OauthSession),
}

/// Core implementation variant used by the Tauri command so local desktop
/// intercepts can read both the active profile home and the profile root.
/// Token-auth entry point (loopback/local/remote-token + all existing tests).
pub async fn api_request_impl_with_home_base(
    input: ApiRequestInput,
    api_base_url: &str,
    session_token: Option<&str>,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_inner(
        input,
        api_base_url,
        ProxyAuth::Token(session_token),
        hermes_home,
        hermes_home_base,
    )
    .await
}

/// OAuth-auth entry point for gated remote gateways (cookie session client).
pub async fn api_request_impl_oauth(
    input: ApiRequestInput,
    api_base_url: &str,
    session: &crate::oauth_session::OauthSession,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    api_request_impl_inner(
        input,
        api_base_url,
        ProxyAuth::Oauth(session),
        hermes_home,
        hermes_home_base,
    )
    .await
}

async fn api_request_impl_inner(
    input: ApiRequestInput,
    api_base_url: &str,
    auth: ProxyAuth<'_>,
    hermes_home: &str,
    hermes_home_base: &str,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let path = &input.path;
    let url_p = url_path(path);

    // 1. Session log intercept
    if let Some(rest) = url_p.strip_prefix(SESSION_LOG_ROUTE_PREFIX) {
        let session_id = urlencoding::decode(rest).unwrap_or_default().to_string();
        let (status, body) = session_log::handle_session_log_request(&session_id, hermes_home);
        let status_text = if status == 200 { "OK" } else { "Not Found" };
        return Ok(json_result(status, status_text, body));
    }

    // 2. Session archive intercept
    if let Some((status, body)) = session_archive::handle_archive_request(path, method, hermes_home)
    {
        let status_text = if status == 200 { "OK" } else { "Error" };
        return Ok(json_result(status, status_text, body));
    }

    // 3. Cron run history intercept (desktop-local, read-only)
    if let Some((status, body)) =
        cron_runs::handle_cron_runs_request(path, method, hermes_home_base)
    {
        let status_text = if status == 200 { "OK" } else { "Error" };
        return Ok(json_result(status, status_text, body));
    }

    // 4. Runtime update intercept
    if url_p == "/api/hermes/update" && method.to_uppercase() == "POST" {
        let result = crate::android_compat::install_runtime_update(None).await;
        let status = if result.ok { 200 } else { 503 };
        let status_text = if result.ok {
            "OK"
        } else {
            "Runtime Update Failed"
        };
        let body = serde_json::to_value(&result).unwrap_or_default();
        return Ok(json_result(status, status_text, body));
    }

    // 5. Proxy to dashboard
    let full_url = if path.starts_with("http://") || path.starts_with("https://") {
        // Validate same origin
        let base = url::Url::parse(api_base_url)?;
        let target = url::Url::parse(path)?;
        if target.origin() != base.origin() {
            return Err(AppError::OriginViolation(
                base.origin().ascii_serialization(),
            ));
        }
        path.to_string()
    } else {
        let base = api_base_url.trim_end_matches('/');
        let p = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        format!("{}{}", base, p)
    };

    let is_audio = is_audio_api_path(path);
    let http_method = method.parse().unwrap_or(reqwest::Method::GET);
    let mut req = match &auth {
        ProxyAuth::Token(_) => {
            let client = if is_audio {
                &*DASHBOARD_AUDIO_PROXY_HTTP_CLIENT
            } else {
                &*DASHBOARD_PROXY_HTTP_CLIENT
            };
            client.request(http_method, &full_url)
        }
        ProxyAuth::Oauth(session) => {
            // One cookie-aware client (30s default); override per-request for
            // long-poll audio so streaming TTS/STT is not cut short.
            let mut b = session.client().request(http_method, &full_url);
            if is_audio {
                b = b.timeout(DASHBOARD_AUDIO_PROXY_TIMEOUT);
            }
            b
        }
    };

    // Inject auth headers (token mode only; oauth rides the cookie jar).
    if let ProxyAuth::Token(Some(token)) = &auth {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", *token);
    }

    // Forward caller headers (don't override auth)
    if let Some(ref headers) = input.headers {
        for (key, value) in headers {
            let lower = key.to_lowercase();
            if lower != "authorization" && lower != "x-hermes-session-token" {
                req = req.header(key.as_str(), value.as_str());
            }
        }
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let res_headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let raw_body = res.text().await.unwrap_or_default();

    // 6. Post-process: filter archived sessions
    let body = session_archive::filter_archived_from_response(path, method, hermes_home, &raw_body);

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers: res_headers,
        body,
    })
}

/// Shared desktop proxy path used by both Tauri IPC and the loopback browser
/// companion. Keeping it here preserves local archive/session-log intercepts,
/// OAuth cookies and token-refresh behavior for both renderers.
pub async fn api_request_from_state(
    app: &tauri::AppHandle,
    input: ApiRequestInput,
    state: &AppState,
) -> Result<ApiRequestResult, AppError> {
    let (api_base_url, auth, hermes_home, hermes_home_base, mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.dashboard_auth(),
            inner.hermes_home.clone(),
            inner.hermes_home_base.clone(),
            inner.connection_mode,
        )
    };

    // Attached modes: the runtime-update intercept below manages the desktop
    // managed runtime, which is not what this shell is connected to.
    if mode != crate::connection::ConnectionMode::Managed
        && url_path(&input.path) == "/api/hermes/update"
        && input.method.as_deref().unwrap_or("GET").to_uppercase() == "POST"
    {
        return Ok(json_result(
            409,
            "Conflict",
            serde_json::json!({
                "ok": false,
                "error": "当前连接的不是本机内核，无法更新桌面端 managed runtime"
            }),
        ));
    }

    // OAuth remote: cookie-authed proxy. The server may rotate AT/RT on the
    // response (captured by the jar) — persist promptly. A 401 with a
    // session_expired/unauthenticated envelope means re-login is needed.
    if let crate::state::DashboardAuth::Oauth(session) = &auth {
        let result = api_request_impl_oauth(
            input,
            &api_base_url,
            session,
            &hermes_home,
            &hermes_home_base,
        )
        .await?;
        if session.take_dirty() {
            crate::oauth_session::persist_if_dirty(&api_base_url, session);
        }
        if should_emit_auth_expired(result.status, &result.body) {
            emit_auth_expired(app, state, &api_base_url, &result.body);
        }
        return Ok(result);
    }

    let session_token = match &auth {
        crate::state::DashboardAuth::Token(t) => t.clone(),
        crate::state::DashboardAuth::Oauth(_) => None,
    };
    let first_result = api_request_impl_with_home_base(
        input.clone(),
        &api_base_url,
        session_token.as_deref(),
        &hermes_home,
        &hermes_home_base,
    )
    .await;
    let first = match first_result {
        Ok(result) => result,
        Err(first_error) if mode == crate::connection::ConnectionMode::Remote => {
            if let Some((from_url, to_url, using_backup)) = activate_other_remote_target(app, state)
            {
                emit_remote_failover(app, &from_url, &to_url, using_backup);
                let (retry_url, retry_token) = {
                    let inner = state.inner.lock()?;
                    (inner.api_base_url.clone(), inner.session_token.clone())
                };
                match api_request_impl_with_home_base(
                    input,
                    &retry_url,
                    retry_token.as_deref(),
                    &hermes_home,
                    &hermes_home_base,
                )
                .await
                {
                    Ok(result) => {
                        if should_emit_auth_expired(result.status, &result.body) {
                            emit_auth_expired(app, state, &retry_url, &result.body);
                        }
                        return Ok(result);
                    }
                    Err(second_error) => return Err(second_error),
                }
            }
            return Err(first_error);
        }
        Err(error) => return Err(error),
    };
    if should_emit_auth_expired(first.status, &first.body) {
        emit_auth_expired(app, state, &api_base_url, &first.body);
    }
    // Remote tokens are static (entered in Settings or via env); the
    // refresh-by-scraping-the-dashboard-HTML recovery below only applies to
    // managed runtime and loopback local CLI dashboards, whose token may
    // rotate on restart.
    if first.status != 401 || mode == crate::connection::ConnectionMode::Remote {
        return Ok(first);
    }

    // Dashboard session tokens are process-local. If the dashboard restarts
    // while the Tauri process remains alive, the cached token becomes stale and
    // every proxied request fails with 401. Refresh from the dashboard HTML and
    // retry once so ordinary UI reads recover without requiring an app restart.
    let fresh_token = match std::env::var("HERMES_DESKTOP_SESSION_TOKEN")
        .ok()
        .or_else(|| std::env::var("HERMES_DASHBOARD_SESSION_TOKEN").ok())
    {
        Some(token) => Some(token),
        None => fetch_session_token(&api_base_url).await,
    };
    if fresh_token.is_none() || fresh_token == session_token {
        return Ok(first);
    }

    let fresh_gateway_url = build_gateway_url(&api_base_url, fresh_token.as_deref());
    {
        let mut inner = state.inner.lock()?;
        inner.session_token = fresh_token.clone();
        inner.gateway_url = fresh_gateway_url;
    }

    api_request_impl_with_home_base(
        input,
        &api_base_url,
        fresh_token.as_deref(),
        &hermes_home,
        &hermes_home_base,
    )
    .await
}

fn activate_other_remote_target(
    _app: &tauri::AppHandle,
    state: &AppState,
) -> Option<(String, String, bool)> {
    let mut inner = state.inner.lock().ok()?;
    inner.activate_other_remote_target()
}

fn emit_remote_failover(app: &tauri::AppHandle, from_url: &str, to_url: &str, using_backup: bool) {
    use tauri::Emitter;
    let _ = app.emit(
        "connection-failover",
        serde_json::json!({
            "fromUrl": from_url,
            "toUrl": to_url,
            "activeRemote": if using_backup { "backup" } else { "primary" },
            "failoverActive": using_backup,
        }),
    );
}

fn is_transport_error(error: &AppError) -> bool {
    matches!(
        error,
        AppError::DashboardUnreachable(_) | AppError::ProxyError(_)
    )
}

/// The main API proxy command. Handles local route intercepts and proxies
/// to the dashboard for everything else.
#[tauri::command]
pub async fn api_request(
    app: tauri::AppHandle,
    input: ApiRequestInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    api_request_from_state(&app, input, &state).await
}

/// True when a 401 body carries the gated-auth envelope signalling the remote
/// session is dead (needs re-login), vs a generic loopback `{detail:...}` 401.
fn is_auth_expired_body(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    json.get("error")
        .and_then(|e| e.as_str())
        .map(|e| e == "session_expired" || e == "unauthenticated")
        .unwrap_or(false)
        || json.get("login_url").is_some()
}

fn should_emit_auth_expired(status: u16, body: &str) -> bool {
    status == 401 && is_auth_expired_body(body)
}

/// Emit `connection-auth-expired` to the frontend so it can surface the
/// re-login banner. Debounced to 5s (a burst of 401s must not storm the UI).
fn emit_auth_expired(app: &tauri::AppHandle, state: &AppState, base_url: &str, body: &str) {
    use tauri::Emitter;
    {
        let mut inner = match state.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let now = std::time::Instant::now();
        if let Some(last) = inner.last_auth_expired_emit {
            if now.duration_since(last) < Duration::from_secs(5) {
                return;
            }
        }
        inner.last_auth_expired_emit = Some(now);
    }
    let json = serde_json::from_str::<serde_json::Value>(body).unwrap_or_default();
    let reason = json
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("unauthenticated")
        .to_string();
    let login_url = json
        .get("login_url")
        .and_then(|u| u.as_str())
        .map(String::from);
    let _ = app.emit(
        "connection-auth-expired",
        serde_json::json!({ "baseUrl": base_url, "reason": reason, "loginUrl": login_url }),
    );
}

/// Proxy an HTTP request to an arbitrary external URL (15s timeout).
#[tauri::command]
pub async fn external_request(input: ApiRequestInput) -> Result<ApiRequestResult, AppError> {
    let target_url = validate_external_url(&input.path).await?;
    external_request_impl(input, target_url).await
}

fn image_mime_from_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    None
}

fn image_extension(mime: &str) -> &'static str {
    match mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "png",
    }
}

fn content_type_mime(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

fn filename_from_url(url: &url::Url, mime_type: &str) -> String {
    let ext = image_extension(mime_type);
    let candidate = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .unwrap_or("external-image");
    let safe: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.').trim_matches('_');
    if safe.is_empty() {
        return format!("external-image.{ext}");
    }
    if safe.rsplit_once('.').is_some_and(|(_, suffix)| {
        (2..=8).contains(&suffix.len()) && suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    }) {
        safe.to_string()
    } else {
        format!("{safe}.{ext}")
    }
}

async fn read_response_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(external_image_limit_error());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppError::InvalidRequest(format!("download_external_image failed: {}", e))
        })?;
        if bytes.len() + chunk.len() > limit {
            return Err(external_image_limit_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn next_redirect_url(
    current: &url::Url,
    response: &reqwest::Response,
) -> Result<url::Url, AppError> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "download_external_image redirect missing Location".to_string(),
            )
        })?;
    let next = current.join(location)?;
    validate_external_url(next.as_str()).await
}

pub async fn download_external_image_impl(
    input: DownloadExternalImageInput,
    mut target_url: url::Url,
) -> Result<DownloadExternalImageResult, AppError> {
    use base64::Engine;

    for redirect_count in 0..=MAX_EXTERNAL_IMAGE_REDIRECTS {
        let response = EXTERNAL_HTTP_CLIENT
            .get(target_url.clone())
            .header(
                reqwest::header::ACCEPT,
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.3",
            )
            .send()
            .await
            .map_err(|e| {
                AppError::InvalidRequest(format!(
                    "download_external_image failed for {}: {}",
                    input.url, e
                ))
            })?;

        if response.status().is_redirection() {
            if redirect_count >= MAX_EXTERNAL_IMAGE_REDIRECTS {
                return Err(AppError::InvalidRequest(
                    "download_external_image followed too many redirects".to_string(),
                ));
            }
            target_url = next_redirect_url(&target_url, &response).await?;
            continue;
        }

        if !response.status().is_success() {
            return Err(AppError::InvalidRequest(format!(
                "download_external_image returned HTTP {}",
                response.status().as_u16()
            )));
        }

        let header_mime = content_type_mime(response.headers());
        let bytes = read_response_limited(response, MAX_EXTERNAL_IMAGE_BYTES).await?;
        let magic_mime = image_mime_from_magic(&bytes).map(str::to_string);
        let mime_type = match (header_mime, magic_mime) {
            // Trust explicit image/* for formats not covered by the small magic
            // table (for example avif), but still reject empty bodies below.
            (Some(header), _) if header.starts_with("image/") => header,
            (_, Some(magic)) => magic,
            _ => {
                return Err(AppError::InvalidRequest(
                    "download_external_image URL did not return image content".to_string(),
                ));
            }
        };
        if bytes.is_empty() {
            return Err(AppError::InvalidRequest(
                "download_external_image returned an empty image".to_string(),
            ));
        }
        let filename = filename_from_url(&target_url, &mime_type);
        return Ok(DownloadExternalImageResult {
            final_url: target_url.to_string(),
            filename,
            mime_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()),
            size: bytes.len(),
        });
    }

    Err(AppError::InvalidRequest(
        "download_external_image followed too many redirects".to_string(),
    ))
}

/// Download a public image URL for use as a composer attachment. URL validation
/// intentionally mirrors `external_request` and every redirect is revalidated.
#[tauri::command]
pub async fn download_external_image(
    input: DownloadExternalImageInput,
) -> Result<DownloadExternalImageResult, AppError> {
    let target_url = validate_external_url(&input.url).await?;
    download_external_image_impl(input, target_url).await
}

/// Core implementation of `external_request` with validation already handled by
/// the caller. Exposed for integration tests so wiremock can exercise request
/// forwarding without loosening production URL validation.
pub async fn external_request_impl(
    input: ApiRequestInput,
    target_url: url::Url,
) -> Result<ApiRequestResult, AppError> {
    external_request_impl_with_client(input, target_url, &EXTERNAL_HTTP_CLIENT).await
}

async fn external_request_impl_with_client(
    input: ApiRequestInput,
    target_url: url::Url,
    client: &reqwest::Client,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let display_url = target_url.as_str().to_string();

    fn build_request(
        client: &reqwest::Client,
        method: &str,
        target_url: url::Url,
        headers: &Option<HashMap<String, String>>,
        body: &Option<String>,
    ) -> reqwest::RequestBuilder {
        let mut req = client.request(method.parse().unwrap_or(reqwest::Method::GET), target_url);
        if let Some(ref headers) = headers {
            for (key, value) in headers {
                req = req.header(key.as_str(), value.as_str());
            }
        }
        if let Some(ref body) = body {
            req = req.body(body.clone());
        }
        req
    }

    // A credentialed request must be sent exactly once. In particular, never
    // bypass a configured system proxy after a connect failure: doing so both
    // violates the user's network policy and can replay API keys/request bodies
    // to a second network path.
    let result = build_request(client, method, target_url, &input.headers, &input.body)
        .send()
        .await;

    match result {
        Ok(res) => {
            let status = res.status().as_u16();
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            let headers: HashMap<String, String> = res
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = res.text().await.unwrap_or_default();
            Ok(ApiRequestResult {
                ok: (200..300).contains(&status),
                status,
                status_text,
                headers,
                body,
            })
        }
        Err(e) => {
            let is_timeout = e.is_timeout();
            Ok(ApiRequestResult {
                ok: false,
                status: if is_timeout { 408 } else { 0 },
                status_text: if is_timeout {
                    "Request Timeout".to_string()
                } else {
                    "Network Error".to_string()
                },
                headers: HashMap::new(),
                body: if is_timeout {
                    format!("Request to {} timed out after 15s", display_url)
                } else {
                    e.to_string()
                },
            })
        }
    }
}

/// Core implementation of `upload_file` with no Tauri State dependency.
/// Exposed for integration tests.
pub async fn upload_file_impl(
    input: UploadFileInput,
    api_base_url: &str,
    session_token: Option<&str>,
) -> Result<ApiRequestResult, AppError> {
    use base64::Engine;

    ensure_upload_base64_size(input.data.len())?;
    let file_bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| AppError::InvalidRequest(format!("Invalid base64: {}", e)))?;
    ensure_upload_decoded_size(file_bytes.len())?;

    let mime_type = input
        .r#type
        .as_deref()
        .unwrap_or("application/octet-stream");

    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(input.name.clone())
        .mime_str(mime_type)?;

    let form = reqwest::multipart::Form::new()
        .text("session_id", input.session_id)
        .part("file", file_part);

    let url = format!("{}/api/upload", api_base_url.trim_end_matches('/'));
    let mut req = UPLOAD_HTTP_CLIENT.post(&url).multipart(form);

    if let Some(token) = session_token {
        req = req
            .header("Authorization", format!("Bearer {}", token))
            .header("X-Hermes-Session-Token", token);
    }

    let res = req.send().await?;
    let status = res.status().as_u16();
    let status_text = res.status().canonical_reason().unwrap_or("").to_string();
    let headers: HashMap<String, String> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = res.text().await.unwrap_or_default();

    Ok(ApiRequestResult {
        ok: (200..300).contains(&status),
        status,
        status_text,
        headers,
        body,
    })
}

/// Upload a file to the dashboard's /api/upload endpoint.
/// The file data arrives as a base64-encoded string from the frontend.
#[tauri::command]
pub async fn upload_file(
    app: tauri::AppHandle,
    input: UploadFileInput,
    state: State<'_, AppState>,
) -> Result<ApiRequestResult, AppError> {
    let (api_base_url, session_token, mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.session_token.clone(),
            inner.connection_mode,
        )
    };
    let first = upload_file_impl(input.clone(), &api_base_url, session_token.as_deref()).await;
    match first {
        Ok(result) => Ok(result),
        Err(error)
            if mode == crate::connection::ConnectionMode::Remote && is_transport_error(&error) =>
        {
            if let Some((from_url, to_url, using_backup)) =
                activate_other_remote_target(&app, &state)
            {
                emit_remote_failover(&app, &from_url, &to_url, using_backup);
                let (retry_url, retry_token) = {
                    let inner = state.inner.lock()?;
                    (inner.api_base_url.clone(), inner.session_token.clone())
                };
                return upload_file_impl(input, &retry_url, retry_token.as_deref()).await;
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileInput {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub r#type: Option<String>,
    /// Base64-encoded file content.
    pub data: String,
}

// ---------------------------------------------------------------------------
// download_file: cookie-auth aware native file download for Tauri/Android.
// ---------------------------------------------------------------------------

const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024; // 100 MiB

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileInput {
    /// Remote file path, e.g. "/data/report.pdf".
    /// Only paths under `/api/files/download` are allowed.
    pub file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFileResult {
    pub ok: bool,
    pub status: u16,
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: usize,
}

/// Safely extract a display filename from `Content-Disposition`.
///
/// Supports `filename*=UTF-8''...` (RFC 5987), plain `filename="..."`, and
/// falls back to `"download"` when nothing usable is present.  Path
/// separators and null bytes are sanitized.
fn safe_filename_from_content_disposition(headers: &reqwest::header::HeaderMap) -> String {
    let raw = match headers
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) => v,
        None => return "download".to_string(),
    };

    // 1. Try RFC 5987 extended-parameter: filename*=charset'language'value
    if let Some(after_eq) = raw.split("filename*=").nth(1) {
        let after_eq = after_eq.split(';').next().unwrap_or("").trim();
        if let Some(encoded) = after_eq.splitn(3, '\'').nth(2) {
            let decoded = urlencoding::decode(encoded)
                .unwrap_or_else(|_| encoded.into())
                .into_owned();
            if !decoded.is_empty() {
                return sanitize_filename(&decoded);
            }
        }
    }

    // 2. Try plain filename="value" (quotes optional)
    if let Some(after_eq) = raw.split("filename=").nth(1) {
        let candidate = after_eq.split(';').next().unwrap_or("").trim();
        let name = if candidate.starts_with('"') && candidate.ends_with('"') {
            candidate[1..candidate.len() - 1].to_string()
        } else {
            candidate.to_string()
        };
        if !name.is_empty() {
            return sanitize_filename(&name);
        }
    }

    "download".to_string()
}

/// Replace filesystem-unsafe characters with underscores.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other => other,
        })
        .collect()
}

fn validate_download_file_path(file_path: &str) -> Result<(), AppError> {
    if file_path.is_empty() || file_path.contains("://") {
        return Err(AppError::InvalidRequest(
            "download_file: only /api/files/download paths are allowed".to_string(),
        ));
    }
    Ok(())
}

/// Core implementation: download a Dashboard file through cookie/token auth.
///
/// `file_path` is always encoded as the `path` query parameter of the fixed
/// same-origin `/api/files/download` endpoint. External URLs are rejected to
/// prevent turning this authenticated command into an SSRF primitive.
pub async fn download_file_impl(
    input: DownloadFileInput,
    api_base_url: &str,
    session_token: Option<&str>,
    oauth: Option<&crate::oauth_session::OauthSession>,
) -> Result<DownloadFileResult, AppError> {
    use base64::Engine;

    let file_path = input.file_path.trim();
    validate_download_file_path(file_path)?;

    // Construct full URL: base + /api/files/download?path=<file_path>
    let base = api_base_url.trim_end_matches('/');
    let full_url = format!(
        "{}/api/files/download?path={}",
        base,
        urlencoding::encode(file_path)
    );

    // Make the request using the appropriate auth strategy.
    let response = match oauth {
        Some(session) => session.client().get(&full_url).send().await?,
        None => {
            let mut req = DASHBOARD_PROXY_HTTP_CLIENT.get(&full_url);
            if let Some(token) = session_token {
                req = req
                    .header("Authorization", format!("Bearer {}", token))
                    .header("X-Hermes-Session-Token", token);
            }
            req.send().await?
        }
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(AppError::InvalidRequest(format!(
            "download_file: dashboard returned HTTP {}",
            status
        )));
    }

    let filename = safe_filename_from_content_disposition(response.headers());
    let mime_type = content_type_mime(response.headers())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let bytes = read_response_limited(response, MAX_DOWNLOAD_BYTES)
        .await
        .map_err(|_| {
            AppError::InvalidRequest(format!(
                "download_file exceeds {} MiB limit",
                MAX_DOWNLOAD_BYTES / 1024 / 1024
            ))
        })?;

    Ok(DownloadFileResult {
        ok: true,
        status,
        filename,
        mime_type,
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: bytes.len(),
    })
}

/// Tauri command: download a file through the Dashboard with cookie/token auth.
/// Called from the frontend via `invoke("download_file", { input })`.
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    input: DownloadFileInput,
    state: tauri::State<'_, AppState>,
) -> Result<DownloadFileResult, AppError> {
    let (api_base_url, auth, mode) = {
        let inner = state.inner.lock()?;
        (
            inner.api_base_url.clone(),
            inner.dashboard_auth(),
            inner.connection_mode,
        )
    };

    if api_base_url.is_empty() {
        return Err(AppError::NotReady);
    }

    match &auth {
        crate::state::DashboardAuth::Oauth(session) => {
            let result = download_file_impl(input, &api_base_url, None, Some(session)).await?;
            if session.take_dirty() {
                crate::oauth_session::persist_if_dirty(&api_base_url, session);
            }
            Ok(result)
        }
        crate::state::DashboardAuth::Token(token) => {
            let first =
                download_file_impl(input.clone(), &api_base_url, token.as_deref(), None).await;
            match first {
                Ok(result) => Ok(result),
                Err(error)
                    if mode == crate::connection::ConnectionMode::Remote
                        && is_transport_error(&error) =>
                {
                    if let Some((from_url, to_url, using_backup)) =
                        activate_other_remote_target(&app, &state)
                    {
                        emit_remote_failover(&app, &from_url, &to_url, using_backup);
                        let (retry_url, retry_token) = {
                            let inner = state.inner.lock()?;
                            (inner.api_base_url.clone(), inner.session_token.clone())
                        };
                        return download_file_impl(input, &retry_url, retry_token.as_deref(), None)
                            .await;
                    }
                    Err(error)
                }
                Err(error) => Err(error),
            }
        }
    }
}

#[cfg(test)]
mod external_request_tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn credentialed_post_is_not_replayed_without_the_proxy() {
        let target = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/secret"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&target)
            .await;

        let proxy = TcpListener::bind(("127.0.0.1", 0)).expect("bind proxy");
        let proxy_addr = proxy.local_addr().expect("proxy address");
        let (captured_tx, captured_rx) = mpsc::channel();
        let proxy_thread = thread::spawn(move || {
            let (mut stream, _) = proxy.accept().expect("accept proxied request");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut buf = vec![0_u8; 8192];
            let count = stream.read(&mut buf).unwrap_or(0);
            captured_tx
                .send(String::from_utf8_lossy(&buf[..count]).to_string())
                .expect("send captured request");
            // Drop without a response to emulate a proxy connection failure.
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .proxy(reqwest::Proxy::all(format!("http://{}", proxy_addr)).expect("valid proxy URL"))
            .build()
            .expect("build proxied client");
        let target_url: url::Url = format!("{}/secret", target.uri())
            .parse()
            .expect("valid target URL");

        let result = external_request_impl_with_client(
            ApiRequestInput {
                path: target_url.to_string(),
                method: Some("POST".to_string()),
                headers: Some(HashMap::from([(
                    "Authorization".to_string(),
                    "Bearer sk-sensitive".to_string(),
                )])),
                body: Some("{\"prompt\":\"hello\"}".to_string()),
            },
            target_url,
            &client,
        )
        .await
        .expect("network errors are returned as a result envelope");

        assert!(!result.ok);
        assert_eq!(result.status, 0);
        let captured = captured_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("proxy should receive exactly one request");
        assert!(captured.contains("Bearer sk-sensitive"));
        proxy_thread.join().expect("proxy thread");
        target.verify().await;
    }
}

#[cfg(test)]
mod download_file_tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn download_path_rejects_external_url_but_accepts_remote_file_path() {
        assert!(validate_download_file_path("/data/report.xlsx").is_ok());
        assert!(validate_download_file_path("/data/联合 督导 总台账.xlsx").is_ok());

        let error = validate_download_file_path("https://evil.example/file").unwrap_err();
        assert!(error.to_string().contains("only /api/files/download"));
        let error = validate_download_file_path("http://127.0.0.1:9119/api/profiles").unwrap_err();
        assert!(error.to_string().contains("only /api/files/download"));
    }

    #[tokio::test]
    async fn download_file_returns_base64_and_mime_with_token_auth() {
        let server = MockServer::start().await;
        let pdf_bytes: Vec<u8> = vec![0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
        Mock::given(method("GET"))
            .and(path("/api/files/download"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(pdf_bytes.clone())
                    .insert_header("content-type", "application/pdf")
                    .insert_header("content-disposition", "attachment; filename=\"report.pdf\""),
            )
            .mount(&server)
            .await;

        let result = download_file_impl(
            DownloadFileInput {
                file_path: "/data/report.pdf".to_string(),
            },
            &server.uri(),
            Some("test-token"),
            None,
        )
        .await
        .expect("download should succeed");

        assert!(result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(result.filename, "report.pdf");
        assert_eq!(result.mime_type, "application/pdf");
        assert_eq!(result.size, 5);
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&result.data_base64)
            .expect("valid base64");
        assert_eq!(decoded, pdf_bytes);
    }

    #[test]
    fn download_file_sanitizes_unicode_filename() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_DISPOSITION,
            "attachment; filename*=UTF-8''%E8%81%94%E5%90%88%20%E7%9D%A3%E5%AF%BC.xlsx"
                .parse()
                .expect("valid header"),
        );
        assert_eq!(
            safe_filename_from_content_disposition(&headers),
            "联合 督导.xlsx"
        );
    }
}
