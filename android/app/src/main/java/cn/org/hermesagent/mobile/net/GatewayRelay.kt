package cn.org.hermesagent.mobile.net

import android.content.Context
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import cn.org.hermesagent.mobile.bridge.HermesBridge
import cn.org.hermesagent.mobile.core.ConnectionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native WebSocket relay for the Gateway /api/ws JSON-RPC channel.
 *
 * The Android WebView cannot connect directly to a remote ws(s):// host (CSP
 * connect-src restriction and credentials must stay native), so this class
 * owns the OkHttp WebSocket and shuttles frames to/from the renderer:
 *
 *   invoke gateway_ws_open   { connectionId } → handshake ok
 *   event  gateway-ws-message { connectionId, data }
 *   event  gateway-ws-closed  { connectionId, message, code? }
 *   invoke gateway_ws_send   { connectionId, data }
 *   invoke gateway_ws_close  { connectionId }
 *
 * This reproduces the Rust ws_proxy wire contract byte-for-byte, so the
 * frontend GatewayRelaySocket adapter needs no protocol changes.
 */
class GatewayRelay(
    private val context: Context,
    private val connectionStore: ConnectionStore,
    private val authManager: AuthManager,
    private val apiProxy: ApiProxy,
    appScope: CoroutineScope,
) : BridgeService, AutoCloseable {

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val ioScope = CoroutineScope(appScope.coroutineContext + Dispatchers.IO)
    private val authenticatedSessionClient = AuthenticatedSessionClient()

    private val sockets = ConcurrentHashMap<String, WebSocket>()

    private var bridge: HermesBridge? = null

    fun attachBridge(b: HermesBridge) {
        bridge = b
    }

    override fun commands(): List<String> = listOf(
        "gateway_ws_open",
        "gateway_ws_send",
        "gateway_ws_close",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "gateway_ws_open" -> {
                val connectionId = args.optString("connectionId")
                val callbackSent = AtomicBoolean(false)
                val report = { result: JSONObject ->
                    if (callbackSent.compareAndSet(false, true)) cb(result)
                }
                ioScope.launch {
                    try {
                        val config = connectionStore.load()
                        if (config.remoteUrl.isBlank()) {
                            report(openError("gateway URL not configured"))
                            return@launch
                        }

                        if (config.remoteAuthMode == "oauth") {
                            val ticketResult = authenticatedSessionClient.mintWsTicket(
                                remoteUrl = config.remoteUrl,
                                cookieHeader = config.oauthCookies,
                            )
                            if (!ticketResult.ok || ticketResult.ticket.isNullOrBlank()) {
                                report(openError(
                                    ticketResult.error ?: "获取 WS ticket 失败",
                                    ticketResult.status,
                                ))
                                return@launch
                            }
                            openSocket(connectionId, config, ticketResult.ticket, report)
                        } else {
                            openSocket(connectionId, config, null, report)
                        }
                    } catch (_: Exception) {
                        report(openError("打开 Gateway WebSocket 失败"))
                    }
                }
                return null
            }
            "gateway_ws_send" -> {
                val connectionId = args.optString("connectionId")
                val data = args.optString("data")
                val ws = sockets[connectionId]
                if (ws == null) {
                    cb(JSONObject().put("ok", false).put("error", "no socket for $connectionId"))
                    return null
                }
                val sent = ws.send(data)
                cb(JSONObject().put("ok", sent))
                return null
            }
            "gateway_ws_close" -> {
                val connectionId = args.optString("connectionId")
                sockets.remove(connectionId)?.close(1000, "client close")
                cb(JSONObject().put("ok", true))
                return null
            }
            else -> { cb(null); return null }
        }
    }

    private fun openSocket(
        connectionId: String,
        config: ConnectionStore.Config,
        ticket: String?,
        report: (JSONObject) -> Unit,
    ) {
        val url = connectionStore.buildGatewayUrl(config, ticket)
        if (url.isBlank()) {
            report(openError("gateway URL not configured"))
            return
        }

        val requestBuilder = Request.Builder().url(url)
        if (config.remoteAuthMode == "oauth" && config.oauthCookies.isNotBlank()) {
            requestBuilder.header("Cookie", config.oauthCookies)
        }
        val ws = client.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val result = JSONObject().put("ok", true)
                // Never return an OAuth ticket to the renderer. Token mode
                // keeps the existing response shape for compatibility.
                if (config.remoteAuthMode != "oauth") result.put("url", url)
                report(result)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                bridge?.emit("gateway-ws-message", JSONObject()
                    .put("connectionId", connectionId)
                    .put("data", text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                socketClosed(connectionId, code, reason, webSocket)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socketClosed(connectionId, code, reason, webSocket)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                report(openError(webSocketError(response?.code), response?.code))
                socketClosed(connectionId, response?.code ?: -1, webSocketError(response?.code), webSocket)
            }
        })
        sockets[connectionId] = ws
    }

    private fun socketClosed(connectionId: String, code: Int, reason: String, socket: WebSocket) {
        if (!sockets.remove(connectionId, socket)) return
        bridge?.emit("gateway-ws-closed", JSONObject()
            .put("connectionId", connectionId)
            .put("message", reason)
            .apply { if (code >= 0) put("code", code) })
    }

    private fun openError(message: String, status: Int? = null): JSONObject = JSONObject()
        .put("ok", false)
        .put("error", message)
        .apply {
            if (status != null) put("status", status)
            if (status == 401) put("code", "AUTH_SESSION_EXPIRED")
        }

    private fun webSocketError(status: Int?): String = when (status) {
        401 -> "登录已过期，请重新登录"
        403 -> "WebSocket 握手被拒绝（HTTP 403）"
        else -> "WebSocket 握手失败"
    }

    override fun close() {
        sockets.values.forEach { it.close(1000, "shutdown") }
        sockets.clear()
        client.dispatcher.cancelAll()
    }
}
