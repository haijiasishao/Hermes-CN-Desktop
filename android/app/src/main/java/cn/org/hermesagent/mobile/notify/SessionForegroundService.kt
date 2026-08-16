package cn.org.hermesagent.mobile.notify

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import cn.org.hermesagent.mobile.MainActivity
import cn.org.hermesagent.mobile.R
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import org.json.JSONObject

/**
 * Android foreground service that keeps the task session alive and shows the
 * persistent session notification (启动/思考/执行/待审批/重连/完成/失败/中断).
 *
 * Native Kotlin replacement for the Tauri SessionForegroundService +
 * Rust monitor pair. Terminal states (completed/failed) detach the FGS while
 * keeping the final notification visible — same contract as before.
 *
 * Watchdog: the FGS state is driven exclusively by the WebView JS layer. If
 * the renderer dies or is frozen while backgrounded, the notification would
 * otherwise stay on 思考中… forever. A stall watchdog flips a non-terminal
 * entry to 连接中断 after a long silence; any later ACTION_UPDATE resumes
 * normal state tracking.
 */
class SessionForegroundService : Service() {

    companion object {
        const val ACTION_START = "cn.org.hermesagent.mobile.FGS_START"
        const val ACTION_UPDATE = "cn.org.hermesagent.mobile.FGS_UPDATE"
        const val ACTION_STOP = "cn.org.hermesagent.mobile.FGS_STOP"
        const val ACTION_DETACH = "cn.org.hermesagent.mobile.FGS_DETACH"

        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_TITLE = "title"
        const val EXTRA_STATE = "state"
        const val EXTRA_SEQUENCE = "sequence"
        const val EXTRA_TIMESTAMP = "timestamp"
        const val EXTRA_ALERT = "alert"

        const val CHANNEL_ID = "hermes_session"
        const val CHANNEL_COMPLETE = "hermes_session_complete"
        const val DIAGNOSTIC_TITLE = "后台链路诊断"

        // Persistent status entry (id 1) and the merged completion alert
        // (id 2) are separate notifications on separate channels. Keeping the
        // completion alert on its own id lets it use the HIGH channel without
        // the Android limitation of switching channels on an existing id.
        const val FGS_NOTIFICATION_ID = 1
        const val COMPLETION_NOTIFICATION_ID = 2

        // If no frontend update arrives for this long while the service is in
        // a non-terminal state, the WebView JS is presumed dead/frozen — flip
        // the entry to a visible "连接受阻" state instead of a permanent
        // 思考中… (hermes-debug-1786772272797 / 1786721948960 family).
        const val WATCHDOG_STALL_MS = 10 * 60 * 1000L
        const val STATE_STALLED = "stalled"

        fun start(context: Context, sessionId: String, title: String, state: String, seq: Long, tsMs: Long) {
            val intent = Intent(context, SessionForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_STATE, state)
                putExtra(EXTRA_SEQUENCE, seq)
                putExtra(EXTRA_TIMESTAMP, tsMs)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun update(context: Context, sessionId: String, title: String, state: String, seq: Long, tsMs: Long, alert: Boolean = false) {
            val intent = Intent(context, SessionForegroundService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_STATE, state)
                putExtra(EXTRA_SEQUENCE, seq)
                putExtra(EXTRA_TIMESTAMP, tsMs)
                putExtra(EXTRA_ALERT, alert)
            }
            // startForegroundService (not startService) so an update can also
            // re-create the service after the system killed it; the 5s
            // startForeground requirement is satisfied by updateForeground()
            // which always drives the foreground notification itself.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context, sessionId: String) {
            val intent = Intent(context, SessionForegroundService::class.java).apply {
                action = ACTION_STOP
                putExtra(EXTRA_SESSION_ID, sessionId)
            }
            context.startService(intent)
        }

        fun detach(context: Context, sessionId: String) {
            val intent = Intent(context, SessionForegroundService::class.java).apply {
                action = ACTION_DETACH
                putExtra(EXTRA_SESSION_ID, sessionId)
            }
            context.startService(intent)
        }
    }

    private var currentSessionId: String? = null
    private var currentTitle: String = "Hermes Agent"
    private var currentState: String = "starting"
    private var currentSeq: Long = 0

    private val watchdogHandler = Handler(Looper.getMainLooper())
    private val watchdogRunnable = Runnable {
        // JS has gone silent for WATCHDOG_STALL_MS while we claim a live
        // non-terminal turn. Surface the stall instead of a permanent 思考中…;
        // keep the session id so a later real update resumes tracking.
        val sessionId = currentSessionId
        if (isNonTerminal(currentState) && sessionId != null) {
            android.util.Log.w(
                "SessionForegroundService",
                "FGS watchdog: no updates for ${WATCHDOG_STALL_MS}ms, marking stalled (session=$sessionId state=$currentState)",
            )
            currentState = STATE_STALLED
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            nm.notify(FGS_NOTIFICATION_ID, buildNotification(sessionId, currentTitle, currentState))
        }
    }

    // Native completion fallback: while the frontend JS is frozen (app
    // backgrounded), REST-poll the session and converge the notification to
    // the terminal state by ourselves (hermes-debug-1786788674550).
    private val completionWatcher: SessionCompletionWatcher by lazy {
        SessionCompletionWatcher(this) { state ->
            val sessionId = currentSessionId
            if (sessionId != null && isNonTerminal(currentState)) {
                android.util.Log.i(
                    "SessionForegroundService",
                    "native completion probe: terminal state=$state (session=$sessionId)",
                )
                updateForeground(sessionId, currentTitle, if (state == "failed") "failed" else "completed", currentSeq, System.currentTimeMillis(), alert = true)
            }
        }
    }

    private fun isNonTerminal(state: String): Boolean =
        state != "completed" && state != "failed" && state != "interrupted" && state != STATE_STALLED

    private fun armWatchdog() {
        watchdogHandler.removeCallbacks(watchdogRunnable)
        if (isNonTerminal(currentState) && currentSessionId != null) {
            watchdogHandler.postDelayed(watchdogRunnable, WATCHDOG_STALL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        when (action) {
            ACTION_START -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
                val title = intent.getStringExtra(EXTRA_TITLE) ?: "Hermes Agent"
                val state = intent.getStringExtra(EXTRA_STATE) ?: "starting"
                val seq = intent.getLongExtra(EXTRA_SEQUENCE, 0)
                val tsMs = intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis())
                beginForeground(sessionId, title, state, seq, tsMs)
            }
            ACTION_UPDATE -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: currentSessionId ?: ""
                val title = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
                val state = intent.getStringExtra(EXTRA_STATE) ?: currentState
                val seq = intent.getLongExtra(EXTRA_SEQUENCE, currentSeq)
                val tsMs = intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis())
                val alert = intent.getBooleanExtra(EXTRA_ALERT, false)
                updateForeground(sessionId, title, state, seq, tsMs, alert)
            }
            ACTION_STOP -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: currentSessionId
                val matches = sessionId == null || sessionId == currentSessionId ||
                    // A stop for a terminal current state is always safe: the
                    // task is already finished and no new task can be waiting
                    // behind it (start() overwrites currentState).
                    currentState == "completed" || currentState == "failed" || currentState == "interrupted"
                if (!matches) {
                    android.util.Log.w(
                        "SessionForegroundService",
                        "FGS stop id mismatch: stop=$sessionId current=$currentSessionId state=$currentState — " +
                            "refusing to kill a newer foreground session",
                    )
                    return START_NOT_STICKY
                }
                watchdogHandler.removeCallbacks(watchdogRunnable)
                completionWatcher.stop()
                stopSelf()
            }
            ACTION_DETACH -> {
                // terminal: keep the final notification, stop the service
                updateForeground(
                    currentSessionId ?: intent.getStringExtra(EXTRA_SESSION_ID) ?: "",
                    currentTitle,
                    currentState,
                    currentSeq,
                    System.currentTimeMillis()
                )
                stopForeground(STOP_FOREGROUND_DETACH)
            }
        }
        return START_NOT_STICKY
    }

    private fun beginForeground(sessionId: String, title: String, state: String, seq: Long, tsMs: Long) {
        currentSessionId = sessionId
        currentTitle = title
        currentState = state
        currentSeq = seq

        // Re-target the native completion watcher at this turn. tsMs (the
        // frontend's start timestamp) approximates the turn start; the
        // watcher only probes after a long frontend silence.
        if (isNonTerminal(state)) {
            completionWatcher.watch(sessionId, tsMs)
        } else {
            completionWatcher.stop()
        }

        val notification = buildNotification(sessionId, title, state)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FGS_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FGS_NOTIFICATION_ID, notification)
        }
        armWatchdog()
    }

    private fun updateForeground(sessionId: String, title: String, state: String, seq: Long, tsMs: Long, alert: Boolean = false) {
        currentSessionId = sessionId
        currentTitle = title
        currentState = state
        currentSeq = seq

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val isTerminal = state == "completed" || state == "failed"
        if (isTerminal) {
            // Frontend drove us terminal — the native watcher's job is done.
            completionWatcher.stop()
        } else {
            // A live frontend update resets the watcher's quiet timer.
            completionWatcher.noteFrontendEvent()
        }
        // startForegroundService may have just created this instance (system
        // killed the old one); Android 12+ requires startForeground within 5s.
        // Calling it here is idempotent when already foreground, and satisfies
        // the deadline before the terminal detach below.
        val preliminary = buildNotification(sessionId, title, state)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FGS_NOTIFICATION_ID, preliminary, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(FGS_NOTIFICATION_ID, preliminary)
        }
        if (isTerminal) {
            // The persistent entry flips to its terminal label; the merged
            // completion alert goes to its own id/channel (sound/vibrate/
            // big text/tappable) so the HIGH channel is not blocked by the
            // existing LOW-channel entry.
            nm.notify(FGS_NOTIFICATION_ID, buildNotification(sessionId, title, state))
            if (alert) {
                nm.notify(COMPLETION_NOTIFICATION_ID, buildCompletionNotification(sessionId, state))
            }
            watchdogHandler.removeCallbacks(watchdogRunnable)
            stopForeground(STOP_FOREGROUND_DETACH)
        } else {
            nm.notify(FGS_NOTIFICATION_ID, preliminary)
            armWatchdog()
        }
    }

    private fun buildNotification(sessionId: String, title: String, state: String, alert: Boolean = false): Notification {
        val stateLabel = when (state) {
            "starting" -> "启动中…"
            "thinking" -> "思考中…"
            "working" -> "执行中…"
            "waiting_approval" -> "待审批"
            "connected" -> "已连接"
            "probe_failed" -> "连接恢复中…"
            "reconnecting" -> "重连中…"
            STATE_STALLED -> "连接中断，等待恢复"
            "completed" -> "任务完成"
            "failed" -> "执行失败"
            "interrupted" -> "已中断"
            else -> state
        }
        val launchIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                putExtra(EXTRA_SESSION_ID, sessionId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val isTerminal = state == "completed" || state == "failed"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(stateLabel)
            .setContentIntent(launchIntent)
            .setOngoing(!isTerminal && state != STATE_STALLED)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun buildCompletionNotification(sessionId: String, state: String): Notification {
        val isCompleted = state == "completed"
        val label = if (isCompleted) "任务完成" else "执行失败"
        val launchIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                putExtra(EXTRA_SESSION_ID, sessionId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_COMPLETE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("后台链路诊断 · $label")
            .setContentText("任务已${if (isCompleted) "完成" else "失败"}，点击查看")
            .setContentIntent(launchIntent)
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(
                "Hermes 后台任务已${if (isCompleted) "完成" else "失败"}，点击进入查看结果。"
            ))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_SOUND or Notification.DEFAULT_VIBRATE)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            val channel = android.app.NotificationChannel(
                CHANNEL_ID,
                "会话状态",
                android.app.NotificationManager.IMPORTANCE_LOW
            ).apply {
                setShowBadge(false)
                setSound(null, null)
            }
            nm.createNotificationChannel(channel)
            // Completion alert channel: high importance + system sound/vibrate
            // so the terminal update actually interrupts while backgrounded.
            val completeChannel = android.app.NotificationChannel(
                CHANNEL_COMPLETE,
                "任务完成提醒",
                android.app.NotificationManager.IMPORTANCE_HIGH
            ).apply {
                setShowBadge(true)
                enableVibration(true)
            }
            nm.createNotificationChannel(completeChannel)
        }
    }

    override fun onDestroy() {
        watchdogHandler.removeCallbacks(watchdogRunnable)
        completionWatcher.close()
        super.onDestroy()
    }
}

/**
 * Bridge commands session_foreground_start / session_foreground_update /
 * session_foreground_stop.
 * Keeps the FGS state machine at the native layer.
 */
class SessionForegroundBridge(private val context: Context) : BridgeService {

    companion object {
        // valid update states (contract from the old Rust/Kotlin pair)
        private val VALID_UPDATE_STATES = setOf("starting", "connected", "probe_failed", "completed", "failed", "reconnecting", "waiting_approval", "thinking", "working", "interrupted")
    }

    override fun commands(): List<String> = listOf(
        "session_foreground_start",
        "session_foreground_update",
        "session_foreground_stop",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "session_foreground_start" -> {
                val sessionId = args.optString("persistentSessionId")
                val title = SessionForegroundService.DIAGNOSTIC_TITLE
                val state = args.optString("state", "starting")
                val seq = args.optLong("heartbeatSequence", 0)
                val tsMs = args.optLong("timestampMs", System.currentTimeMillis())
                if (sessionId.isBlank()) {
                    cb(JSONObject().put("ok", false).put("supported", true).put("error", "missing persistentSessionId"))
                    return null
                }
                SessionForegroundService.start(context, sessionId, title, state, seq, tsMs)
                cb(JSONObject().put("ok", true).put("supported", true))
                return null
            }
            "session_foreground_update" -> {
                val sessionId = args.optString("persistentSessionId")
                val title = SessionForegroundService.DIAGNOSTIC_TITLE
                val state = args.optString("state")
                val seq = args.optLong("heartbeatSequence", 0)
                val tsMs = args.optLong("timestampMs", System.currentTimeMillis())
                val alert = args.optBoolean("alert", false)
                if (sessionId.isBlank()) {
                    cb(JSONObject().put("ok", false).put("supported", true).put("error", "missing persistentSessionId"))
                    return null
                }
                if (!VALID_UPDATE_STATES.contains(state)) {
                    cb(JSONObject().put("ok", false).put("supported", true).put("error", "invalid foreground state"))
                    return null
                }
                SessionForegroundService.update(context, sessionId, title, state, seq, tsMs, alert)
                cb(JSONObject().put("ok", true).put("supported", true))
                return null
            }
            "session_foreground_stop" -> {
                val sessionId = args.optString("persistentSessionId")
                SessionForegroundService.stop(context, sessionId)
                cb(JSONObject().put("ok", true).put("supported", true))
                return null
            }
            else -> { cb(null); return null }
        }
    }
}
