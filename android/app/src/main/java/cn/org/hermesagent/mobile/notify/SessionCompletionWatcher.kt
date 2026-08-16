package cn.org.hermesagent.mobile.notify

import android.content.Context
import android.util.Log
import cn.org.hermesagent.mobile.core.ConnectionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Native fallback completion detector for the foreground session notification.
 *
 * The WebView JS layer drives the FGS state while it is alive, but Android
 * freezes the renderer while the app is backgrounded — the WS reconnect and
 * snapshot convergence logic (all JS) stops, so the notification stays on
 * 思考中/重连中 even after the backend finished the turn
 * (hermes-debug-1786788674550: 10:06:34 → 10:11:03 no FGS update until the
 * user reopened the app).
 *
 * This watcher polls the REST session-messages endpoint natively (OkHttp +
 * the persisted connection config, same auth path as ApiProxy) while the FGS
 * has seen no frontend update for [QUIET_BEFORE_PROBE_MS]. It converges the
 * notification to the terminal state as soon as REST proves the turn
 * finished, independent of the WebView JS.
 *
 * Detection contract mirrors the frontend `findCompletedSnapshotAssistant`:
 * the LAST stored message must be an assistant message in a terminal state
 * (complete/error), without a pending (running) tool part, and with final
 * text content. Mid-turn assistant round-trips (tool-call rounds the backend
 * persisted as complete) stay non-terminal — the false-positive root cause
 * from hermes-debug-1786772272797.
 */
class SessionCompletionWatcher(
    private val context: Context,
    private var onTerminal: (state: String) -> Unit,
) : AutoCloseable {

    companion object {
        private const val TAG = "SessionCompletionWatcher"

        // Start probing only after the frontend has been silent this long;
        // an active WebView keeps sending updates and needs no native help.
        const val QUIET_BEFORE_PROBE_MS = 60_000L
        const val PROBE_INTERVAL_MS = 15_000L
        const val PROBE_TIMEOUT_MS = 10_000L
        const val MAX_CONSECUTIVE_FAILURES = 6

        // Allow a small clock skew between the device and the backend when
        // comparing stored-message creation time against the turn start.
        const val TURN_START_CLOCK_SKEW_MS = 5_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()
    private val connectionStore = ConnectionStore(context)

    private var job: Job? = null
    private var sessionId: String? = null
    private var turnStartedAtMs: Long? = null
    private var lastFrontendEventMs: Long = 0L
    private var consecutiveFailures = 0

    /** Track the freshest frontend heartbeat; quiet detection uses it. */
    fun noteFrontendEvent() {
        lastFrontendEventMs = System.currentTimeMillis()
    }

    /** (Re)target the watcher at a session turn. */
    fun watch(sessionId: String, turnStartedAtMs: Long?) {
        this.sessionId = sessionId
        this.turnStartedAtMs = turnStartedAtMs
        consecutiveFailures = 0
        noteFrontendEvent()
        ensureRunning()
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun ensureRunning() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                delay(PROBE_INTERVAL_MS)
                probeIfQuiet()
            }
        }
    }

    private suspend fun probeIfQuiet() {
        val sid = sessionId ?: return
        val quietMs = System.currentTimeMillis() - lastFrontendEventMs
        if (quietMs < QUIET_BEFORE_PROBE_MS) return

        // The JS layer is either frozen (backgrounded) or dead. Ask REST
        // directly whether this turn has reached a terminal assistant.
        val result = probeTerminalState(sid)
        when {
            result == null -> {
                // REST unreachable / auth failure. Retry a few times, then
                // park: the FGS stall watchdog handles the long-haul UI.
                consecutiveFailures++
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    Log.w(TAG, "probe failing repeatedly (session=$sid, failures=$consecutiveFailures); parking probe")
                    stop()
                }
            }
            result.isTerminal -> {
                Log.i(TAG, "REST probe: turn terminal (session=$sid, state=${result.state})")
                stop()
                onTerminal(result.state)
            }
            else -> {
                consecutiveFailures = 0
                // Turn still running; keep polling quietly.
            }
        }
    }

    internal suspend fun probeTerminalState(sessionId: String): TerminalProbeResult? {
        val config = try {
            connectionStore.load()
        } catch (error: Exception) {
            Log.w(TAG, "connection config load failed: ${error.message}")
            return null
        }
        val base = config.remoteUrl.trimEnd('/')
        if (base.isBlank() || config.mode != "remote") return null

        val url = "$base/api/sessions/${java.net.URLEncoder.encode(sessionId, "UTF-8")}/messages"
        val requestBuilder = Request.Builder().url(url).get()
        if (config.remoteAuthMode == "token" && config.remoteToken.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer ${config.remoteToken}")
        } else if (config.remoteAuthMode == "oauth" && config.oauthCookies.isNotBlank()) {
            requestBuilder.header("Cookie", config.oauthCookies)
        }
        val bodyText = try {
            client.newCall(requestBuilder.build()).execute().use { response ->
                if (!response.isSuccessful) return null
                response.body?.string() ?: return null
            }
        } catch (error: Exception) {
            Log.w(TAG, "probe REST failed (session=$sessionId): ${error.message}")
            return null
        }

        return try {
            val root = JSONObject(bodyText)
            val uiMessages = root.optJSONArray("ui_messages")
            val stored = if (uiMessages != null && uiMessages.length() > 0) {
                uiMessages
            } else {
                root.optJSONArray("messages") ?: JSONArray()
            }
            CompletionDetector.detectTerminal(stored, turnStartedAtMs)
        } catch (error: Exception) {
            Log.w(TAG, "probe parse failed (session=$sessionId): ${error.message}")
            null
        }
    }

    data class TerminalProbeResult(val isTerminal: Boolean, val state: String)

    override fun close() {
        stop()
        scope.cancel()
        client.dispatcher.cancelAll()
    }
}

/**
 * Pure JSON-level finality detection shared by the watcher and unit tests.
 *
 * Mirrors the frontend's findCompletedSnapshotAssistant semantics:
 *  - scan from the LAST stored message
 *  - must be role=assistant, status complete|error
 *  - must NOT carry a running tool part (mid-turn round-trip)
 *  - must carry final text content (or be an error)
 *  - createdAt must be >= turn start (with small clock-skew allowance)
 */
object CompletionDetector {

    private const val TAG = "CompletionDetector"

    data class Detection(val isTerminal: Boolean, val state: String)

    fun detectTerminal(
        storedMessages: JSONArray,
        turnStartedAtMs: Long?,
    ): SessionCompletionWatcher.TerminalProbeResult {
        val detection = inspect(storedMessages, turnStartedAtMs)
        return SessionCompletionWatcher.TerminalProbeResult(detection.isTerminal, detection.state)
    }

    internal fun inspect(
        storedMessages: JSONArray,
        turnStartedAtMs: Long?,
    ): Detection {
        // Scan from the end: we care about the LAST stored message.
        var index = storedMessages.length() - 1
        while (index >= 0) {
            val message = storedMessages.optJSONObject(index)
            if (message != null) {
                val role = message.optString("role")
                if (role == "assistant") {
                    val analysis = analyzeAssistant(message, turnStartedAtMs)
                    if (analysis != null) return analysis
                }
            }
            index--
        }
        return Detection(false, "")
    }

    private fun analyzeAssistant(
        message: JSONObject,
        turnStartedAtMs: Long?,
    ): Detection? {
        // ui_messages carry status + parts; legacy stored messages carry
        // finish_reason + tool_calls + text content fields.
        val status = message.optString("status", "").ifBlank {
            if (message.optString("finish_reason") == "error") "error" else "complete"
        }
        val terminal = status == "complete" || status == "error"
        if (!terminal) return null

        // Mid-turn tool-call round-trips are persisted with a complete status
        // but still have a running tool part — NOT the terminal answer.
        if (hasRunningTool(message)) return null

        if (status == "error") return Detection(true, "failed")

        // A terminal answer needs final text content.
        val hasText = hasFinalText(message)
        if (!hasText) return null

        // createdAt (ms epoch) must be >= the turn start (with clock skew).
        val createdAtVal = message.optDouble("createdAt", 0.0)
        val createdAtMs = if (createdAtVal > 0) createdAtVal else message.optDouble("timestamp", 0.0)
        if (turnStartedAtMs != null && createdAtMs > 0 &&
            createdAtMs < (turnStartedAtMs - SessionCompletionWatcher.TURN_START_CLOCK_SKEW_MS)
        ) {
            return null
        }

        return Detection(true, "completed")
    }

    private fun hasRunningTool(message: JSONObject): Boolean {
        // ui_messages: parts[].type == "tool" && state == "running"
        val parts = message.optJSONArray("parts")
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                if (part.optString("type") == "tool" && part.optString("state") == "running") return true
            }
        }
        // legacy stored message: non-empty tool_calls array
        val toolCalls = message.opt("tool_calls")
        if (toolCalls is JSONArray && toolCalls.length() > 0) return true
        if (toolCalls is JSONObject && toolCalls.length() > 0) return true
        return false
    }

    private fun hasFinalText(message: JSONObject): Boolean {
        // ui_messages: text parts
        val parts = message.optJSONArray("parts")
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.optJSONObject(i) ?: continue
                if (part.optString("type") == "text" && part.optString("text").isNotBlank()) return true
            }
            return false
        }
        // legacy stored message: content text field
        val content = message.opt("content")
        if (content is String && content.isNotBlank()) return true
        if (content is JSONObject) {
            // { type: "text", text: "..." } or { type: "tool_call", ... }
            if (content.optString("type") == "text" && content.optString("text").isNotBlank()) return true
        }
        return false
    }
}
