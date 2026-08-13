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
  lateinit var title: String
  lateinit var state: String
  var heartbeatSequence: Long = 0
  var timestampMs: Long = 0
}

@TauriPlugin
class SessionForegroundPlugin(private val activity: android.app.Activity) : Plugin(activity) {
  @Command
  fun sessionForeground(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SessionForegroundArgs::class.java)
      Log.e("SessionForegroundPlugin", "DIAG action=${args.action} sessionId=${args.persistentSessionId} state=${args.state} seq=${args.heartbeatSequence} ts=${args.timestampMs} now=${System.currentTimeMillis()}")
      require(args.persistentSessionId.isNotBlank()) { "persistentSessionId required" }
      require(args.action in setOf("start", "update", "stop")) { "invalid foreground action" }
      require(args.state in setOf("starting", "connected", "probe_failed", "completed", "failed", "stopped")) {
        "invalid foreground state"
      }
      require((args.action == "start" && args.state == "starting") ||
        (args.action == "update" && args.state in setOf("connected", "probe_failed", "completed", "failed")) ||
        (args.action == "stop" && args.state == "stopped")) { "invalid foreground action/state" }
      val intent = Intent(activity, SessionForegroundService::class.java).apply {
        putExtra(SessionForegroundService.EXTRA_SESSION_ID, args.persistentSessionId)
        putExtra(SessionForegroundService.EXTRA_STATE, safe(args.state))
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

  private fun safe(value: String): String = value.replace(Regex("[\\r\\n]"), " ").trim().take(32)
}
