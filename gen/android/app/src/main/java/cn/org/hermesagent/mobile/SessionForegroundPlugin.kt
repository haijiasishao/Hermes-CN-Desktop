package cn.org.hermesagent.mobile

import android.content.Intent
import androidx.core.content.ContextCompat
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SessionForegroundArgs {
  lateinit var action: String
  lateinit var persistentSessionId: String
  var title: String? = null
  var state: String? = null
  var heartbeatSequence: Long = 0
  var timestampMs: Long = 0
  var status: Int? = null
  var category: String? = null
  var errorCode: String? = null
}

@TauriPlugin
class SessionForegroundPlugin(private val activity: android.app.Activity) : Plugin(activity) {
  @Command
  fun sessionForeground(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SessionForegroundArgs::class.java)
      require(args.persistentSessionId.isNotBlank()) { "persistentSessionId required" }
      require(args.action in setOf("start", "update", "stop", "diagnostic")) { "invalid foreground action" }
      if (args.action == "diagnostic") {
        logProbeFailure(args)
        invoke.resolve()
        return
      }
      val state = requireNotNull(args.state) { "foreground state required" }
      Log.e("SessionForegroundPlugin", "DIAG action=${args.action} sessionId=${args.persistentSessionId} state=$state seq=${args.heartbeatSequence} ts=${args.timestampMs} now=${System.currentTimeMillis()}")
      require(state in setOf("starting", "connected", "probe_failed", "completed", "failed", "stopped")) {
        "invalid foreground state"
      }
      require((args.action == "start" && state == "starting") ||
        (args.action == "update" && state in setOf("connected", "probe_failed", "completed", "failed")) ||
        (args.action == "stop" && state == "stopped")) { "invalid foreground action/state" }
      val intent = Intent(activity, SessionForegroundService::class.java).apply {
        putExtra(SessionForegroundService.EXTRA_SESSION_ID, args.persistentSessionId)
        putExtra(SessionForegroundService.EXTRA_STATE, safe(state))
        putExtra(SessionForegroundService.EXTRA_SEQUENCE, args.heartbeatSequence)
        putExtra(SessionForegroundService.EXTRA_TIMESTAMP, args.timestampMs)
      }
      when (args.action) {
        "start" -> {
          intent.action = SessionForegroundService.ACTION_UPDATE
          ContextCompat.startForegroundService(activity, intent)
        }
        "update" -> {
          intent.action = SessionForegroundService.ACTION_UPDATE
          activity.startService(intent)
        }
        "stop" -> {
          intent.action = SessionForegroundService.ACTION_STOP
          activity.startService(intent)
        }
        else -> error("invalid foreground action")
      }
      Log.e("SessionForegroundPlugin", "DIAG action=${args.action} RESOLVED ok sessionId=${args.persistentSessionId}")
      invoke.resolve()
    } catch (error: Exception) {
      Log.e("SessionForegroundPlugin", "DIAG REJECTED: ${error.message}", error)
      invoke.reject(error.message ?: "无法启动后台链路诊断服务")
    }
  }

  private fun logProbeFailure(args: SessionForegroundArgs) {
    val sessionId = args.persistentSessionId
      .replace(Regex("[^A-Za-z0-9_.:-]"), "_")
      .take(64)
      .ifEmpty { "unknown" }
    val sequence = args.heartbeatSequence.coerceIn(0, 1_000_000)
    val status = args.status?.takeIf { it in 100..599 }?.toString() ?: "none"
    val category = args.category?.takeIf { it in SAFE_DIAGNOSTIC_CATEGORIES } ?: "unknown"
    val errorCode = args.errorCode?.takeIf { it in SAFE_DIAGNOSTIC_CODES } ?: "unknown"
    Log.e(
      "SessionForegroundPlugin",
      "probe_error sessionId=$sessionId sequence=$sequence status=$status category=$category code=$errorCode",
    )
  }

  private fun safe(value: String): String = value.replace(Regex("[\\r\\n]"), " ").trim().take(32)

  companion object {
    private val SAFE_DIAGNOSTIC_CATEGORIES = setOf("auth", "http", "network", "parse", "internal", "error")
    private val SAFE_DIAGNOSTIC_CODES = setOf(
      "http_unauthorized",
      "http_forbidden",
      "http_status",
      "invalid_messages_payload",
      "dashboard_unreachable",
      "dashboard_probe",
      "auth_session_expired",
      "state_lock_poisoned",
      "internal_error",
      "api_proxy_error",
      "request_error",
      "unknown",
    )
  }
}
