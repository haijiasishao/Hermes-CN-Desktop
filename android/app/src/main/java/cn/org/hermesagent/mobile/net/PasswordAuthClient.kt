package cn.org.hermesagent.mobile.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.LinkedHashMap
import java.util.concurrent.TimeUnit

/** Result of one password-auth HTTP operation. Secrets are never part of it. */
internal data class PasswordAuthResult(
    val ok: Boolean,
    val identity: JSONObject? = null,
    val cookieHeader: String? = null,
    val error: String? = null,
)

/**
 * JVM-friendly HTTP implementation for the password provider flow.
 *
 * This class deliberately owns only the two requests needed by this slice:
 * POST /auth/password-login and GET /api/auth/me. AuthManager remains the
 * Android bridge/persistence adapter.
 */
internal class PasswordAuthClient(
    private val client: OkHttpClient = defaultClient(),
) {
    fun login(
        remoteUrl: String,
        provider: String,
        username: String,
        password: String,
    ): PasswordAuthResult {
        return try {
            val body = JSONObject()
                .put("provider", provider)
                .put("username", username)
                .put("password", password)
                .toString()
                .toByteArray(Charsets.UTF_8)
                .toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder()
                .url(endpoint(remoteUrl, "/auth/password-login"))
                .header("Content-Type", "application/json")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return PasswordAuthResult(ok = false, error = passwordLoginError(response.code))
                }

                val cookieHeader = extractSessionCookieHeader(response.headers("Set-Cookie"))
                    ?: return PasswordAuthResult(ok = false, error = "登录未生效，请重试")

                val authMe = authMe(remoteUrl, cookieHeader)
                if (!authMe.ok) {
                    return authMe.copy(cookieHeader = null)
                }
                authMe.copy(cookieHeader = cookieHeader)
            }
        } catch (error: Exception) {
            PasswordAuthResult(ok = false, error = error.message ?: "登录失败")
        }
    }

    /** Fetch identity using exactly the persisted session Cookie header. */
    fun authMe(remoteUrl: String, cookieHeader: String): PasswordAuthResult {
        if (cookieHeader.isBlank()) {
            return PasswordAuthResult(ok = false, error = "登录未生效，请重试")
        }

        return try {
            val request = Request.Builder()
                .url(endpoint(remoteUrl, "/api/auth/me"))
                .header("Cookie", cookieHeader)
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return PasswordAuthResult(ok = false, error = authMeError(response.code))
                }

                val body = response.body?.string().orEmpty()
                val identity = runCatching { normalizeIdentity(JSONObject(body)) }.getOrNull()
                    ?: return PasswordAuthResult(ok = false, error = "登录未生效，请重试")
                PasswordAuthResult(ok = true, identity = identity)
            }
        } catch (error: Exception) {
            PasswordAuthResult(ok = false, error = error.message ?: "登录状态检查失败")
        }
    }

    private fun normalizeIdentity(raw: JSONObject): JSONObject = JSONObject()
        .put("userId", valueOrNull(raw, "user_id", "userId"))
        .put("email", valueOrNull(raw, "email", "email"))
        .put("displayName", valueOrNull(raw, "display_name", "displayName"))
        .put("orgId", valueOrNull(raw, "org_id", "orgId"))
        .put("provider", valueOrNull(raw, "provider", "provider"))
        .put("expiresAt", valueOrNull(raw, "expires_at", "expiresAt"))

    private fun valueOrNull(raw: JSONObject, snakeKey: String, camelKey: String): Any {
        val key = when {
            raw.has(snakeKey) -> snakeKey
            raw.has(camelKey) -> camelKey
            else -> return JSONObject.NULL
        }
        return raw.opt(key) ?: JSONObject.NULL
    }

    /**
     * Keep all valid cookie pairs for the follow-up request, but require one
     * of the server's access/refresh session cookie names before proceeding.
     */
    private fun extractSessionCookieHeader(setCookies: List<String>): String? {
        val pairs = LinkedHashMap<String, String>()
        setCookies.forEach { raw ->
            val pair = raw.substringBefore(';')
            val separator = pair.indexOf('=')
            if (separator <= 0) return@forEach
            val name = pair.substring(0, separator).trim()
            val value = pair.substring(separator + 1).trim()
            if (name.isNotEmpty() && value.isNotEmpty()) pairs[name] = value
        }
        if (pairs.keys.none { it in SESSION_COOKIE_NAMES }) return null
        return pairs.entries.joinToString("; ") { (name, value) -> "$name=$value" }
    }

    private fun endpoint(remoteUrl: String, path: String): String =
        "${remoteUrl.trimEnd('/')}$path"

    private fun passwordLoginError(status: Int): String = when (status) {
        401 -> "用户名或密码错误"
        404 -> "该网关不支持密码登录（provider 未启用）"
        429 -> "尝试过于频繁，请稍后再试"
        503 -> "网关未注册任何登录方式"
        else -> "登录失败（HTTP $status）"
    }

    private fun authMeError(status: Int): String = when (status) {
        401 -> "登录未生效，请重试"
        429 -> "尝试过于频繁，请稍后再试"
        503 -> "网关未注册任何登录方式"
        404 -> "登录状态接口不可用（HTTP 404）"
        else -> "登录状态检查失败（HTTP $status）"
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
        val SESSION_COOKIE_NAMES = setOf(
            "__Host-hermes_session_at",
            "__Secure-hermes_session_at",
            "hermes_session_at",
            "__Host-hermes_session_rt",
            "__Secure-hermes_session_rt",
            "hermes_session_rt",
        )

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()
    }
}
