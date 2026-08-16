package cn.org.hermesagent.mobile.net

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(15, TimeUnit.SECONDS)
    .build()

/**
 * The connection probe used by the Android settings page. It remains public
 * by default, but can attach the current OAuth Cookie header for a live
 * authenticated connection test.
 *
 * This component deliberately has no Android/DataStore dependency so the
 * status/providers contract can be exercised against a real HTTP fixture in
 * JVM unit tests. It mirrors the Rust probe sequence:
 * status first, then the public providers endpoint only for an explicit
 * boolean auth_required=true response.
 */
data class AuthProviderInfo(
    val name: String,
    val displayName: String,
    val supportsPassword: Boolean,
)

data class RemoteProbeResult(
    val reachable: Boolean,
    val authRequired: Boolean,
    val version: String,
    val authProviders: List<AuthProviderInfo>,
    val error: String? = null,
) {
    /** Serialize only the Android bridge contract, never raw service JSON. */
    fun toJson(): JSONObject {
        val providers = JSONArray()
        authProviders.forEach { provider ->
            providers.put(
                JSONObject()
                    .put("name", provider.name)
                    .put("displayName", provider.displayName)
                    .put("supportsPassword", provider.supportsPassword),
            )
        }
        val json = JSONObject()
            .put("reachable", reachable)
            .put("authRequired", authRequired)
            .put("version", version)
            .put("authProviders", providers)
        if (error != null) json.put("error", error)
        return json
    }
}

class RemoteProbeClient(
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {
    fun probe(targetUrl: String, cookieHeader: String? = null): RemoteProbeResult {
        val baseUrl = targetUrl.trimEnd('/')
        return try {
            val statusRequest = Request.Builder()
                    .url("$baseUrl/api/status")
                    .header("Accept", "application/json")
                    .get()
                    .applyCookie(cookieHeader)
                    .build()
            val statusResponse = httpClient.newCall(statusRequest).execute()

            statusResponse.use { response ->
                val body = parseObject(response.body?.string())
                val authRequired = body?.opt("auth_required") as? Boolean ?: false
                val providers = if (authRequired) {
                    fetchAuthProviders(baseUrl, cookieHeader)
                } else {
                    emptyList()
                }
                RemoteProbeResult(
                    reachable = response.code in 200..299 || response.code == 401,
                    authRequired = authRequired,
                    version = readVersion(body),
                    authProviders = providers,
                )
            }
        } catch (error: Exception) {
            RemoteProbeResult(
                reachable = false,
                authRequired = false,
                version = "",
                authProviders = emptyList(),
                error = "${error.javaClass.simpleName}: ${error.message.orEmpty()}",
            )
        }
    }

    private fun fetchAuthProviders(baseUrl: String, cookieHeader: String?): List<AuthProviderInfo> {
        return try {
            val request = Request.Builder()
                    .url("$baseUrl/api/auth/providers")
                    .header("Accept", "application/json")
                    .get()
                    .applyCookie(cookieHeader)
                    .build()
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return emptyList()
                val body = parseObject(response.body?.string()) ?: return emptyList()
                AuthProviderNormalizer.normalize(body.opt("providers"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun parseObject(raw: String?): JSONObject? {
        if (raw.isNullOrBlank()) return null
        return runCatching { JSONObject(raw) }.getOrNull()
    }

    private fun readVersion(body: JSONObject?): String {
        if (body == null) return ""
        return listOf("version", "hermes_version", "app_version")
            .asSequence()
            .mapNotNull { key -> (body.opt(key) as? String)?.takeIf { it.isNotEmpty() } }
            .firstOrNull()
            .orEmpty()
    }

    private fun Request.Builder.applyCookie(cookieHeader: String?): Request.Builder = apply {
        if (!cookieHeader.isNullOrBlank()) header("Cookie", cookieHeader)
    }
}

internal object AuthProviderNormalizer {
    fun normalize(raw: Any?): List<AuthProviderInfo> {
        val providers = raw as? JSONArray ?: return emptyList()
        val normalized = ArrayList<AuthProviderInfo>(providers.length())
        for (index in 0 until providers.length()) {
            val provider = providers.opt(index) as? JSONObject ?: continue
            val rawName = provider.opt("name") as? String ?: continue
            val name = rawName.trim()
            if (name.isEmpty()) continue

            val displayName = (provider.opt("display_name") as? String)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?: name
            val supportsPassword = provider.opt("supports_password") as? Boolean ?: false
            normalized += AuthProviderInfo(name, displayName, supportsPassword)
        }
        return normalized
    }
}
