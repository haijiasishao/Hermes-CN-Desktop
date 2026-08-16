package cn.org.hermesagent.mobile.net

import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import cn.org.hermesagent.mobile.core.ConnectionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Authenticated REST proxy for Dashboard APIs.
 *
 * The WebView `fetch()` context must NOT reach the remote Dashboard directly
 * — it does not share the native cookie jar. All REST calls (including
 * /api/sessions, /api/memory, downloads) go through [api_request] here, with
 * OAuth cookies or the session token attached natively.
 */
class ApiProxy(
    private val connectionStore: ConnectionStore,
) : BridgeService, AutoCloseable {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: okhttp3.HttpUrl, cookies: List<Cookie>) {
                val current = connectionStore.currentConfig()
                if (cookies.isEmpty()) return
                val hostDomain = url.host
                val all = cookieStore[hostDomain] ?: mutableListOf()
                // replace same-name cookies
                val retained = all.filter { old -> cookies.none { it.name == old.name } }.toMutableList()
                retained.addAll(cookies)
                cookieStore[hostDomain] = retained
                // persist OAuth session indicator if any cookie looks session-ish
                if (cookies.any { it.name.contains("session", ignoreCase = true) || it.name.contains("token", ignoreCase = true) }) {
                    val flat = retained.joinToString("; ") { "${it.name}=${it.value}" }
                    scope.launch { connectionStore.saveOauthSession(flat) }
                }
            }

            override fun loadForRequest(url: okhttp3.HttpUrl): List<Cookie> {
                val hostDomain = url.host
                val persisted = loadPersistedCookies(url.host)
                return (cookieStore[hostDomain] ?: emptyList()) + persisted.filter { persistedCookie ->
                    cookieStore[hostDomain]?.none { it.name == persistedCookie.name } != false
                }
            }
        })
        .build()

    private val cookieStore = mutableMapOf<String, MutableList<Cookie>>()

    private fun loadPersistedCookies(host: String): List<Cookie> {
        val c = connectionStore.currentConfig()
        if (c.oauthCookies.isBlank() || c.remoteAuthMode != "oauth") return emptyList()
        return try {
            c.oauthCookies.split("; ").mapNotNull { pair ->
                val idx = pair.indexOf('=')
                if (idx <= 0) return@mapNotNull null
                Cookie.Builder()
                    .domain(host)
                    .path("/")
                    .name(pair.substring(0, idx))
                    .value(pair.substring(idx + 1))
                    .build()
            }
        } catch (_: Exception) { emptyList() }
    }

    override fun commands(): List<String> = listOf(
        "api_request",
        "external_request",
        "upload_file",
        "download_file",
        "download_external_image",
        "open_external_url",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "api_request" -> {
                val path = args.optString("path")
                val method = args.optString("method", "GET").uppercase()
                val headers = args.optJSONObject("headers") ?: JSONObject()
                val body = if (args.isNull("body")) null else args.optString("body")
                val useToken = connectionStore.currentConfig().remoteAuthMode == "token"
                val base = connectionStore.currentConfig().remoteUrl.trimEnd('/')
                val url = normalizeUrl(base, path)
                val req = buildRequest(url, method, headers, body, useToken)
                asyncRequest(req, cb)
                return null
            }
            "external_request" -> {
                val path = args.optString("path") ?: args.optString("url")
                val method = args.optString("method", "GET").uppercase()
                val body = if (args.isNull("body")) null else args.optString("body")
                val req = buildRequest(path, method, JSONObject(), body, false)
                asyncRequest(req, cb)
                return null
            }
            "download_external_image" -> {
                val url = args.optString("url")
                val req = Request.Builder().url(url).get().build()
                asyncRequest(req, cb)
                return null
            }
            "download_file" -> {
                val path = args.optString("filePath") ?: args.optString("path")
                val base = connectionStore.currentConfig().remoteUrl.trimEnd('/')
                val useToken = connectionStore.currentConfig().remoteAuthMode == "token"
                val req = buildRequest(normalizeUrl(base, path), "GET", JSONObject(), null, useToken)
                asyncRequest(req, cb)
                return null
            }
            "upload_file" -> {
                val sessionId = args.optString("sessionId")
                val name = args.optString("name")
                val mime = args.optString("type", "application/octet-stream")
                val dataB64 = args.optString("dataBase64", args.optString("data"))
                val base = connectionStore.currentConfig().remoteUrl.trimEnd('/')
                val path = "/api/files/attach?session_id=${java.net.URLEncoder.encode(sessionId, "UTF-8")}&name=${java.net.URLEncoder.encode(name, "UTF-8")}"
                val bytes = try { android.util.Base64.decode(dataB64, android.util.Base64.DEFAULT) } catch (_: Exception) { ByteArray(0) }
                val useToken = connectionStore.currentConfig().remoteAuthMode == "token"
                val req = buildRequest(
                    base + path,
                    "POST",
                    JSONObject().put("Content-Type", mime),
                    null,
                    useToken,
                    body2 = bytes.toRequestBody(mime.toMediaType())
                )
                asyncRequest(req, cb)
                return null
            }
            "open_external_url" -> {
                // Delegated to Notifier (native Intent). Kept for completeness.
                cb(JSONObject().put("ok", false).put("error", "use notifier"))
                return null
            }
            else -> { cb(null); return null }
        }
    }

    private fun normalizeUrl(base: String, path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val trimmedBase = base.trimEnd('/')
        return if (path.startsWith("/")) trimmedBase + path else "$trimmedBase/$path"
    }

    private fun buildRequest(
        url: String,
        method: String,
        headers: JSONObject,
        body: String?,
        useToken: Boolean,
        body2: RequestBody? = null,
    ): Request {
        val builder = Request.Builder().url(url)
        val headersMap = mutableMapOf<String, String>()
        headers.keys().forEach { k -> headersMap[k] = headers.optString(k) }
        headersMap.forEach { (k, v) -> builder.header(k, v) }
        if (useToken) {
            val token = connectionStore.currentConfig().remoteToken
            if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        }
        when (method) {
            "GET", "HEAD", "DELETE" -> builder.method(method, null)
            else -> {
                val entity = body2 ?: body?.toRequestBody("application/json".toMediaType())
                builder.method(method, entity ?: RequestBody.create(null, ByteArray(0)))
            }
        }
        return builder.build()
    }

    private fun asyncRequest(request: Request, cb: BridgeCallback) {
        scope.launch {
            withContext(Dispatchers.IO) {
                try {
                    client.newCall(request).execute().use { response ->
                        val bodyText = response.body?.string() ?: ""
                        val headers = JSONObject()
                        response.headers.forEach { (k, v) -> headers.put(k, v) }
                        val result = JSONObject()
                            .put("ok", response.isSuccessful)
                            .put("status", response.code)
                            .put("statusText", response.message)
                            .put("headers", headers)
                            .put("body", bodyText)
                        cb(result)
                    }
                } catch (e: IOException) {
                    cb(JSONObject()
                        .put("ok", false).put("status", 0).put("statusText", e.javaClass.simpleName)
                        .put("headers", JSONObject())
                        .put("body", e.message ?: ""))
                }
            }
        }
    }

    override fun close() {
        client.dispatcher.cancelAll()
    }
}
