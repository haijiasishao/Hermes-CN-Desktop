package cn.org.hermesagent.mobile.notify

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import cn.org.hermesagent.mobile.R
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import org.json.JSONObject

/**
 * Native task notifications (desktop_notify / notification_permission),
 * replacing the Rust notify command surface.
 *
 * Foreground policy (Android): the app is "focused" when the Activity is
 * resumed and visible. Android's is_focused()/is_visible() unreliability seen
 * in Tauri is avoided because we own the lifecycle directly.
 */
class Notifier(private val activity: Activity) : BridgeService {

    companion object {
        const val CHANNEL_TASK = "hermes_task"
        const val CHANNEL_TASK_NAME = "任务通知"
    }

    private val notificationManager: NotificationManager =
        activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private var permissionPromptInFlight = false

    init {
        createChannel()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_TASK, CHANNEL_TASK_NAME,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                enableVibration(true)
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    override fun commands(): List<String> = listOf(
        "desktop_notify",
        "notification_permission",
        "open_external_url",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "desktop_notify" -> {
                val kind = args.optString("kind", "complete")
                val title = args.optString("title")
                val body = args.optString("body")
                val showSystem = args.optBoolean("showSystemNotification", true)
                val withSound = args.optBoolean("withSound", false)
                val respectFocus = args.optBoolean("respectFocus", true)
                val requestAttention = args.optBoolean("requestAttention", false)

                val focused = isFocused()
                val shouldSuppress = respectFocus && focused
                val delivered = !shouldSuppress && showSystem && hasPermission()

                if (delivered) {
                    showNotification(kind, title, body, withSound)
                }

                cb(JSONObject()
                    .put("delivered", delivered)
                    .put("focused", focused)
                    .put("visible", focused)
                    .put("rawFocused", focused)
                    .put("rawVisible", hasVisibleActivity())
                    .put("effectiveForeground", focused)
                    .put("attentionRequested", requestAttention && !delivered)
                    .put("error", if (shouldSuppress) JSONObject.NULL else JSONObject.NULL))
                return null
            }
            "notification_permission" -> {
                val request = args.optBoolean("request", false)
                if (request && !permissionPromptInFlight) {
                    permissionPromptInFlight = true
                    if (Build.VERSION.SDK_INT >= 33 && !hasPermission()) {
                        ActivityCompat.requestPermissions(
                            activity,
                            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                            4101
                        )
                    }
                }
                val state = when {
                    hasPermission() -> "granted"
                    Build.VERSION.SDK_INT < 33 -> "granted"
                    else -> "denied"
                }
                cb(JSONObject().put("state", state).put("granted", hasPermission()))
                return null
            }
            "open_external_url" -> {
                val url = args.optString("url")
                val opened = runCatching {
                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                    true
                }.getOrDefault(false)
                cb(JSONObject().put("ok", opened).put("message", if (opened) null else "no browser available"))
                return null
            }
            else -> { cb(null); return null }
        }
    }

    /** Effective foreground: the hosting Activity is resumed. */
    fun isFocused(): Boolean {
        val owner = activity as? androidx.lifecycle.LifecycleOwner
        return owner?.lifecycle?.currentState?.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
            ?: activity.hasWindowFocus()
    }

    private fun hasVisibleActivity(): Boolean {
        return activity.window != null && activity.window.decorView.isShown
    }

    fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            return ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    private fun showNotification(kind: String, title: String, body: String, withSound: Boolean) {
        val importance = if (withSound) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
        val builder = NotificationCompat.Builder(activity, CHANNEL_TASK)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(importance)
            .setAutoCancel(true)
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))

        // The task-complete notification must be tappable: without a content
        // intent Android drops the tap (user-reported: completion notification
        // did not open the app while the FGS notification did). Route to the
        // main activity; the app resolves the session from its persisted state.
        builder.setContentIntent(notificationLaunchPendingIntent())

        if (!withSound) {
            builder.setSilent(true)
        }

        try {
            NotificationManagerCompat.from(activity).notify(kind.hashCode(), builder.build())
        } catch (_: SecurityException) {
            // permission revoked after check — silent drop
        }
    }

    private fun notificationLaunchPendingIntent(): android.app.PendingIntent {
        return android.app.PendingIntent.getActivity(
            activity, 0,
            android.content.Intent(activity, cn.org.hermesagent.mobile.MainActivity::class.java).apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
            },
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
