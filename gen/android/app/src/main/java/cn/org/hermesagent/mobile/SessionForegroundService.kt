package cn.org.hermesagent.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class SessionForegroundService : Service() {
  companion object {
    private const val TAG = "SessionForegroundService"
    const val NOTIFICATION_ID = 19041
    const val CHANNEL_ID = "session_foreground_diagnostic"
    const val ACTION_UPDATE = "cn.org.hermesagent.mobile.SESSION_FOREGROUND_UPDATE"
    const val ACTION_STOP = "cn.org.hermesagent.mobile.SESSION_FOREGROUND_STOP"
    const val EXTRA_SESSION_ID = "persistentSessionId"
    const val EXTRA_STATE = "state"
    const val EXTRA_SEQUENCE = "heartbeatSequence"
    const val EXTRA_TIMESTAMP = "timestampMs"
  }

  override fun onCreate() {
    super.onCreate()
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "后台链路诊断", NotificationManager.IMPORTANCE_LOW),
      )
    }
    logEvent("session-fgs.service.created", null)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID)
    val sequence = intent?.getLongExtra(EXTRA_SEQUENCE, 0L) ?: 0L
    val state = intent?.getStringExtra(EXTRA_STATE)
    val timestamp = intent?.getLongExtra(EXTRA_TIMESTAMP, 0L) ?: 0L
    logEvent("session-fgs.service.start-command", sessionId, sequence, state, timestamp)
    if (intent?.action == ACTION_STOP) {
      stopAndRemove(sessionId, sequence, state, timestamp)
      return START_NOT_STICKY
    }
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification(intent),
      android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )
    logEvent("session-fgs.notification.foreground-started", sessionId, sequence, state, timestamp)
    return START_NOT_STICKY
  }

  private fun notification(intent: Intent?): Notification {
    val state = safe(intent?.getStringExtra(EXTRA_STATE), "心跳")
    val sequence = intent?.getLongExtra(EXTRA_SEQUENCE, 0L) ?: 0L
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("后台链路诊断")
      .setContentText("$state · 心跳#$sequence")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
  }

  private fun safe(value: String?, fallback: String): String {
    val clean = value?.replace(Regex("[\\r\\n]"), " ")?.trim()?.take(80).orEmpty()
    return if (clean.isEmpty()) fallback else clean
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    logEvent("session-fgs.service.task-removed", rootIntent?.getStringExtra(EXTRA_SESSION_ID))
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    logEvent("session-fgs.service.destroyed", null)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    logEvent("session-fgs.service.timeout", null, startId.toLong(), fgsType.toString(), System.currentTimeMillis())
    stopAndRemove(null, startId.toLong(), fgsType.toString(), System.currentTimeMillis())
  }

  private fun stopAndRemove(sessionId: String?, sequence: Long, state: String?, timestamp: Long) {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    logEvent("session-fgs.service.stopped", sessionId, sequence, state, timestamp)
    stopSelf()
  }

  private fun logEvent(event: String, sessionId: String?, sequence: Long = 0L, state: String? = null, timestamp: Long = 0L) {
    Log.i(TAG, "$event sessionId=${sessionId ?: "unknown"} sequence=$sequence state=${state ?: "unknown"} timestamp=$timestamp")
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
