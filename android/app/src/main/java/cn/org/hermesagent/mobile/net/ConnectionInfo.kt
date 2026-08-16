package cn.org.hermesagent.mobile.net

/**
 * Connection information shared between native services (computed from
 * ConnectionStore). Kept tiny to avoid circular imports.
 */
object ConnectionInfo {
    fun isOAuthMode(authMode: String): Boolean = authMode == "oauth"
}
