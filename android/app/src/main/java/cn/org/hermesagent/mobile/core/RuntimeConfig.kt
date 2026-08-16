package cn.org.hermesagent.mobile.core

import android.content.Context
import android.os.Build
import cn.org.hermesagent.mobile.BuildConfig
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Runtime configuration surface for the frontend bootstrap:
 * get_runtime_config / runtime_info / get_runtime_info.
 *
 * Android Remote-only identity: the app never manages a local Hermes runtime;
 * it connects exclusively to the remote Dashboard/Gateway. Shapes mirror the
 * desktop Tauri contract so the frontend boots identically.
 */
class RuntimeConfig(
    private val context: Context,
    private val connectionStore: ConnectionStore,
    private val appScope: CoroutineScope,
) : BridgeService {

    override fun commands(): List<String> = listOf(
        "get_runtime_config",
        "runtime_info",
        "get_runtime_info",
        "get_desktop_control_state",
        "set_guide_state",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "get_runtime_config" -> {
                appScope.launch(Dispatchers.IO) {
                    val c = connectionStore.load()
                    val baseUrl = c.remoteUrl.trimEnd('/')
                    cb(JSONObject()
                        .put("apiBaseUrl", baseUrl)
                        .put("gatewayUrl", connectionStore.buildGatewayUrl(c))
                        .put(
                            "sessionToken",
                            if (c.remoteAuthMode == "token" && c.remoteToken.isNotEmpty()) {
                                c.remoteToken
                            } else {
                                JSONObject.NULL
                            },
                        )
                        .put("currentProfile", "default")
                        .put("connectionMode", "remote")
                        .put("portable", false)
                        .put("backendReady", true)
                        .put("guideState", JSONObject.NULL)
                        .put("managedRuntimeDesiredState", "stopped")
                        .put("managedRuntimeLifecycleState", "none")
                        .put("androidRemoteOnly", true))
                }
                return null
            }
            "runtime_info", "get_runtime_info" -> {
                appScope.launch(Dispatchers.IO) {
                    val c = connectionStore.load()
                    cb(JSONObject()
                        .put("mode", "external-command")
                        .put("packaged", true)
                        .put("platform", "android")
                        .put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a")
                        .put("runtimeRoot", context.filesDir.absolutePath)
                        .put("currentRecordPath", "")
                        .put("versionsDir", context.filesDir.absolutePath)
                        .put("downloadsDir", context.cacheDir.absolutePath)
                        .put("gatewayRuntimeDir", context.filesDir.absolutePath)
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("commit", BuildConfig.BUILD_COMMIT ?: "")
                        .put("remoteUrl", c.remoteUrl))
                }
                return null
            }
            "get_desktop_control_state" -> {
                cb(JSONObject()
                    .put("managedRuntimeDesiredState", "stopped")
                    .put("managedRuntimeLifecycleState", "none"))
                return null
            }
            "set_guide_state" -> {
                cb(JSONObject().put("ok", true))
                return null
            }
            else -> { cb(null); return null }
        }
    }
}
