package cn.org.hermesagent.mobile.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** Result of minting one authenticated Gateway WebSocket ticket. */
internal data class WsTicketResult(
    val ok: Boolean,
    val ticket: String? = null,
    val status: Int? = null,
    val error: String? = null,
)

/**
 * Small JVM-friendly client for the cookie-authenticated WS ticket endpoint.
 *
 * The cookie is supplied explicitly for each request instead of being logged
 * or copied into an OkHttp cookie jar. This keeps the OAuth bridge slice
 * narrow while allowing the probe, connection test, and relay to share the
 * persisted cookie header.
 */
internal class AuthenticatedSessionClient(
    private val client: OkHttpClient = defaultClient(),
) {
    fun mintWsTicket(remoteUrl: String, cookieHeader: String): WsTicketResult {
        if (cookieHeader.isBlank()) {
            return WsTicketResult(
                ok = false,
                error = "登录已过期，请重新登录",
            )
        }

        return try {
            val request = Request.Builder()
                .url("${remoteUrl.trimEnd('/')}/api/auth/ws-ticket")
                .header("Cookie", cookieHeader)
                .post(ByteArray(0).toRequestBody(null))
                .build()

            client.newCall(request).execute().use { response ->
                if (response.code == 401) {
                    return WsTicketResult(
                        ok = false,
                        status = response.code,
                        error = "登录已过期，请重新登录",
                    )
                }
                if (!response.isSuccessful) {
                    return WsTicketResult(
                        ok = false,
                        status = response.code,
                        error = "HTTP ${response.code}",
                    )
                }

                val ticket = response.body
                    ?.string()
                    ?.let { raw -> runCatching { org.json.JSONObject(raw).optString("ticket") }.getOrNull() }
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() }
                if (ticket == null) {
                    return WsTicketResult(
                        ok = false,
                        status = response.code,
                        error = "ws-ticket 响应缺少 ticket",
                    )
                }
                WsTicketResult(ok = true, ticket = ticket, status = response.code)
            }
        } catch (_: Exception) {
            WsTicketResult(ok = false, error = "获取 WS ticket 失败")
        }
    }

    private companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()
    }
}
