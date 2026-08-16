package cn.org.hermesagent.mobile.core

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import cn.org.hermesagent.mobile.net.AuthenticatedSessionClient
import cn.org.hermesagent.mobile.net.RemoteProbeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Persisted connection configuration (DataStore-backed).
 *
 * Mirrors the Rust AppState connection config contract so
 * get_connection_config / save_connection_config / apply_connection_config
 * return identical shapes to the frontend protocol layer.
 */
private val Context.connectionDataStore by preferencesDataStore(name = "hermes_connection")

class ConnectionStore(private val context: Context) : BridgeService {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        const val DEFAULT_LOCAL_URL = "http://127.0.0.1:9119"
        const val DEFAULT_REMOTE_URL = ""

        private val KEY_MODE = stringPreferencesKey("mode")
        private val KEY_LOCAL_URL = stringPreferencesKey("local_url")
        private val KEY_REMOTE_URL = stringPreferencesKey("remote_url")
        private val KEY_REMOTE_TOKEN = stringPreferencesKey("remote_token")
        private val KEY_REMOTE_AUTH_MODE = stringPreferencesKey("remote_auth_mode")
        private val KEY_OAUTH_SESSION_SET = booleanPreferencesKey("oauth_session_set")
        private val KEY_OAUTH_COOKIES = stringPreferencesKey("oauth_cookies")
    }

    data class Config(
        var mode: String = "remote",          // "local" | "remote"
        var localUrl: String = DEFAULT_LOCAL_URL,
        var remoteUrl: String = DEFAULT_REMOTE_URL,
        var remoteToken: String = "",
        var remoteAuthMode: String = "token", // "token" | "oauth"
        var oauthSessionSet: Boolean = false,
        var oauthCookies: String = "",
    )

    @Volatile
    private var cached: Config = Config()
    @Volatile
    private var loaded = false

    private val remoteProbeClient = RemoteProbeClient()
    private val authenticatedSessionClient = AuthenticatedSessionClient()

    suspend fun load(): Config {
        if (loaded) return cached
        val prefs = context.connectionDataStore.data.first()
        cached = Config(
            mode = prefs[KEY_MODE] ?: "remote",
            localUrl = prefs[KEY_LOCAL_URL] ?: DEFAULT_LOCAL_URL,
            remoteUrl = prefs[KEY_REMOTE_URL] ?: DEFAULT_REMOTE_URL,
            remoteToken = prefs[KEY_REMOTE_TOKEN] ?: "",
            remoteAuthMode = prefs[KEY_REMOTE_AUTH_MODE] ?: "token",
            oauthSessionSet = prefs[KEY_OAUTH_SESSION_SET] ?: false,
            oauthCookies = prefs[KEY_OAUTH_COOKIES] ?: "",
        )
        loaded = true
        return cached
    }

    suspend fun persist(config: Config) {
        cached = config
        context.connectionDataStore.edit { prefs ->
            prefs[KEY_MODE] = config.mode
            prefs[KEY_LOCAL_URL] = config.localUrl
            prefs[KEY_REMOTE_URL] = config.remoteUrl
            if (config.remoteToken.isNotEmpty()) prefs[KEY_REMOTE_TOKEN] = config.remoteToken
            // empty remoteToken keeps previously saved token (contract)
            prefs[KEY_REMOTE_AUTH_MODE] = config.remoteAuthMode
            prefs[KEY_OAUTH_SESSION_SET] = config.oauthSessionSet
            prefs[KEY_OAUTH_COOKIES] = config.oauthCookies
        }
        loaded = true
    }

    suspend fun clearOauth() {
        val c = load()
        c.oauthSessionSet = false
        c.oauthCookies = ""
        persist(c)
    }

    suspend fun saveOauthSession(cookies: String) {
        val c = load()
        c.oauthSessionSet = cookies.isNotBlank()
        c.oauthCookies = cookies
        persist(c)
    }

    fun currentConfig(): Config = if (loaded) cached else Config()

    /** View shape consumed by get_connection_config (envOverride=false on Android). */
    fun toView(): JSONObject {
        val c = currentConfig()
        return JSONObject()
            .put("mode", c.mode)
            .put("localUrl", c.localUrl)
            .put("remoteUrl", c.remoteUrl)
            .put("remoteTokenSet", c.remoteToken.isNotEmpty())
            .put("remoteTokenPreview", if (c.remoteToken.isEmpty()) JSONObject.NULL else maskToken(c.remoteToken))
            .put("remoteAuthMode", c.remoteAuthMode)
            .put("remoteSessionSet", c.oauthSessionSet)
            .put("envOverride", false)
            .put("effectiveMode", c.mode)
    }

    private fun maskToken(token: String): String {
        if (token == "set") return "set"
        return if (token.length <= 6) "set" else "...${token.takeLast(6)}"
    }

    // ── BridgeService ────────────────────────────────────────────────────────

    override fun commands(): List<String> = listOf(
        "get_connection_config",
        "save_connection_config",
        "probe_connection_config",
        "test_connection_config",
        "apply_connection_config",
        "refresh_gateway_url",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "get_connection_config" -> {
                loadAnd(::toView, cb)
                return null
            }
            "save_connection_config" -> {
                scope.launch {
                    val c = load()
                    args.optStringOrNull("mode")?.let { c.mode = it }
                    args.optStringOrNull("localUrl")?.let { c.localUrl = it }
                    args.optStringOrNull("remoteUrl")?.let { c.remoteUrl = it }
                    args.optStringOrNull("remoteAuthMode")?.let { c.remoteAuthMode = it }
                    val token = args.optStringOrNull("remoteToken")
                    if (!token.isNullOrEmpty()) c.remoteToken = token
                    persist(c)
                    cb(toView())
                }
                return null
            }
            "probe_connection_config" -> {
                scope.launch {
                    val c = load()
                    val target = args.optStringOrNull("remoteUrl") ?: c.remoteUrl
                    probe(target, cb)
                }
                return null
            }
            "test_connection_config" -> {
                // input: { mode?, localUrl?, remoteUrl?, remoteToken?, remoteAuthMode? }
                scope.launch {
                    val c = load()
                    val effective = Config(
                        mode = args.optStringOrNull("mode") ?: c.mode,
                        localUrl = args.optStringOrNull("localUrl") ?: c.localUrl,
                        remoteUrl = args.optStringOrNull("remoteUrl") ?: c.remoteUrl,
                        remoteToken = args.optStringOrNull("remoteToken") ?: c.remoteToken,
                        remoteAuthMode = args.optStringOrNull("remoteAuthMode") ?: c.remoteAuthMode,
                        oauthSessionSet = c.oauthSessionSet,
                        oauthCookies = c.oauthCookies,
                    )
                    cb(testConnection(effective))
                }
                return null
            }
            "apply_connection_config" -> {
                scope.launch {
                    val c = load()
                    val incoming = Config(
                        mode = args.optStringOrNull("mode") ?: c.mode,
                        localUrl = args.optStringOrNull("localUrl") ?: c.localUrl,
                        remoteUrl = args.optStringOrNull("remoteUrl") ?: c.remoteUrl,
                        remoteToken = args.optStringOrNull("remoteToken") ?: c.remoteToken,
                        remoteAuthMode = args.optStringOrNull("remoteAuthMode") ?: c.remoteAuthMode,
                        oauthSessionSet = c.oauthSessionSet,
                        oauthCookies = c.oauthCookies,
                    )
                    val testResult = testConnection(incoming)
                    if (testResult.optBoolean("ok")) {
                        // Do not replace the active configuration until the
                        // candidate has passed HTTP, auth, and WS checks.
                        persist(incoming)
                        cb(JSONObject()
                            .put("ok", true)
                            .put("mode", incoming.mode)
                            .put("apiBaseUrl", incoming.remoteUrl.trimEnd('/'))
                            .put("gatewayUrl", buildGatewayUrl(incoming))
                            .put("sessionToken", sessionTokenFor(incoming)))
                    } else {
                        cb(JSONObject()
                            .put("ok", false)
                            .put("mode", incoming.mode)
                            .put("error", safeError(testResult.opt("error"))))
                    }
                }
                return null
            }
            "refresh_gateway_url" -> {
                scope.launch {
                    val c = load()
                    cb(JSONObject()
                        .put("gatewayUrl", buildGatewayUrl(c))
                        .put("sessionToken", sessionTokenFor(c)))
                }
                return null
            }
            else -> {
                cb(null)
                return null
            }
        }
    }

    fun buildGatewayUrl(c: Config = currentConfig(), ticket: String? = null): String {
        val base = c.remoteUrl.trimEnd('/')
        val wsBase = if (base.startsWith("https://")) base.replaceFirst("https://", "wss://") else base.replaceFirst("http://", "ws://")
        val query = if (c.remoteAuthMode == "token" && c.remoteToken.isNotEmpty()) {
            "token=${URLEncoder.encode(c.remoteToken, "UTF-8")}"
        } else if (c.remoteAuthMode == "oauth" && !ticket.isNullOrBlank()) {
            "ticket=${URLEncoder.encode(ticket, "UTF-8")}"
        } else {
            ""
        }
        return if (query.isEmpty()) "$wsBase/api/ws" else "$wsBase/api/ws?$query"
    }

    // ── Network probes (probe / test / apply) ──────────────────────────────

    /** GET /api/status on the remote and summarize reachability/auth. */
    private suspend fun probe(targetUrl: String, cb: BridgeCallback) {
        val result = probeInternal(targetUrl)
        cb(result)
    }

    private suspend fun probeInternal(targetUrl: String, cookieHeader: String? = null): JSONObject {
        return withContext(Dispatchers.IO) {
            remoteProbeClient.probe(targetUrl, cookieHeader).toJson()
        }
    }

    /** Full connection test: HTTP /api/status + WS handshake. */
    internal suspend fun testConnection(c: Config): JSONObject {
        val base = c.remoteUrl.trimEnd('/')
        val oauth = c.remoteAuthMode == "oauth"
        val cookieHeader = c.oauthCookies.takeIf { oauth && it.isNotBlank() }
        val probeResult = probeInternal(c.remoteUrl, cookieHeader)
        val httpOk = probeResult.optBoolean("reachable")
        val authRequired = probeResult.optBoolean("authRequired")

        val ticketResult = if (oauth && httpOk) {
            withContext(Dispatchers.IO) {
                authenticatedSessionClient.mintWsTicket(c.remoteUrl, cookieHeader.orEmpty())
            }
        } else {
            null
        }
        val authOk = !oauth || (ticketResult?.ok == true && !ticketResult.ticket.isNullOrBlank())
        val wsOk = if (httpOk && authOk) {
            openWebSocket(
                wsUrl = buildGatewayUrl(c, ticketResult?.ticket),
                cookieHeader = cookieHeader,
            )
        } else {
            false
        }

        val ok = httpOk && authOk && wsOk
        val error = when {
            ok -> JSONObject.NULL
            !httpOk -> safeError(probeResult.opt("error"))
            !authOk -> safeError(ticketResult?.error)
            else -> "WebSocket 握手失败"
        }
        return JSONObject()
            .put("ok", ok)
            .put("baseUrl", base)
            .put("httpOk", httpOk)
            .put("httpStatus", if (httpOk) 200 else 0)
            .put("wsOk", wsOk)
            .put("authRequired", authRequired)
            .put("version", probeResult.optString("version"))
            .put("ticketOk", if (oauth) authOk else JSONObject.NULL)
            .put("needsOauthLogin", oauth && !authOk)
            .put("error", error)
    }

    private suspend fun openWebSocket(wsUrl: String, cookieHeader: String?): Boolean =
        withContext(Dispatchers.IO) {
            var socket: WebSocket? = null
            try {
                val requestBuilder = Request.Builder().url(wsUrl)
                if (!cookieHeader.isNullOrBlank()) requestBuilder.header("Cookie", cookieHeader)
                val wsClient = OkHttpClient.Builder()
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(8, TimeUnit.SECONDS)
                    .build()
                var opened = false
                val latch = CountDownLatch(1)
                socket = wsClient.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                        opened = true
                        webSocket.close(1000, "test")
                        latch.countDown()
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                        latch.countDown()
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        latch.countDown()
                    }
                })
                if (!latch.await(8, TimeUnit.SECONDS)) socket?.cancel()
                wsClient.dispatcher.executorService.shutdown()
                wsClient.connectionPool.evictAll()
                opened
            } catch (_: Exception) {
                socket?.cancel()
                false
            }
        }

    private fun sessionTokenFor(c: Config): Any =
        if (c.remoteAuthMode == "token" && c.remoteToken.isNotEmpty()) c.remoteToken else JSONObject.NULL

    private fun safeError(value: Any?): String = when (value) {
        is String -> value.takeIf { it.isNotBlank() } ?: "连接失败"
        else -> "连接失败"
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key)

    private fun loadAnd(block: () -> JSONObject, cb: BridgeCallback) {
        scope.launch {
            load()
            cb(block())
        }
    }
}
