package cn.org.hermesagent.mobile.net

import android.content.Context
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import cn.org.hermesagent.mobile.core.ConnectionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Connection probing and auth flows (token / OAuth / password), mirroring the
 * Rust connection_auth command surface.
 *
 * Password login is delegated to a JVM-testable HTTP client; successful login
 * persists the verified cookie session in ConnectionStore so the existing
 * REST + WS/apply flow can reuse it.
 */
class AuthManager(
    private val context: Context,
    private val connectionStore: ConnectionStore,
    private val apiProxy: ApiProxy,
) : BridgeService {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val passwordAuthClient = PasswordAuthClient()

    override fun commands(): List<String> = listOf(
        "connection_oauth_login",
        "connection_password_login",
        "connection_auth_me",
        "connection_oauth_logout",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "connection_oauth_login" -> {
                val remoteUrl = args.optString("remoteUrl")
                // OAuth login requires a browser-like flow; Android uses the
                // system browser / Custom Tab. Full implementation in Phase C.
                cb(JSONObject().put("ok", false).put("error", "oauth login: 待 Phase C WebView 拦截回跳实现"))
                return null
            }
            "connection_password_login" -> {
                val remoteUrl = args.optString("remoteUrl")
                val provider = args.optString("provider")
                val username = args.optString("username")
                val password = args.optString("password")
                scope.launch { passwordLogin(remoteUrl, provider, username, password, cb) }
                return null
            }
            "connection_auth_me" -> {
                val remoteUrl = args.optString("remoteUrl")
                scope.launch { authMe(remoteUrl, cb) }
                return null
            }
            "connection_oauth_logout" -> {
                scope.launch {
                    connectionStore.clearOauth()
                    cb(JSONObject().put("ok", true))
                }
                return null
            }
            else -> { cb(null); return null }
        }
    }

    private suspend fun passwordLogin(
        remoteUrl: String,
        provider: String,
        username: String,
        password: String,
        cb: BridgeCallback,
    ) {
        withContext(Dispatchers.IO) {
            try {
                val result = passwordAuthClient.login(remoteUrl, provider, username, password)
                val cookieHeader = result.cookieHeader
                if (!result.ok || result.identity == null || cookieHeader.isNullOrBlank()) {
                    cb(JSONObject()
                        .put("ok", false)
                        .put("error", result.error ?: "登录未生效，请重试"))
                    return@withContext
                }

                // Persist only after the server accepted the cookie and auth/me
                // confirmed the session. The password never reaches this layer.
                connectionStore.saveOauthSession(cookieHeader)
                cb(JSONObject()
                    .put("ok", true)
                    .put("identity", result.identity))
            } catch (error: Exception) {
                cb(JSONObject().put("ok", false).put("error", error.message ?: "登录失败"))
            }
        }
    }

    private suspend fun authMe(remoteUrl: String, cb: BridgeCallback) {
        withContext(Dispatchers.IO) {
            try {
                val savedConfig = connectionStore.load()
                val result = passwordAuthClient.authMe(remoteUrl, savedConfig.oauthCookies)
                if (result.ok && result.identity != null) {
                    cb(JSONObject().put("ok", true).put("identity", result.identity))
                } else {
                    cb(JSONObject()
                        .put("ok", false)
                        .put("error", result.error ?: "登录未生效，请重试"))
                }
            } catch (error: Exception) {
                cb(JSONObject().put("ok", false).put("error", error.message ?: "登录状态检查失败"))
            }
        }
    }
}
