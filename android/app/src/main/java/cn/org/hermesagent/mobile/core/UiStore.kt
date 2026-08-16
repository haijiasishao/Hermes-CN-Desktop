package cn.org.hermesagent.mobile.core

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Frontend UI store (KV + turn stats + event log), DataStore-backed.
 * Replaces the Rust ui_store command surface with identical JSON shapes.
 */
private val Context.uiDataStore by preferencesDataStore(name = "hermes_ui")

class UiStore(private val context: Context) : BridgeService {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    companion object {
        const val KV_PREFIX = "kv."
        const val TURNS_KEY = "turn_stats"
        const val EVENTS_KEY = "events"
    }

    private suspend fun prefs() = context.uiDataStore.data.first()

    private suspend fun readRaw(): Map<String, Any> =
        context.uiDataStore.data.first().asMap().mapKeys { it.key.name }

    private suspend fun write(key: String, value: String) {
        context.uiDataStore.edit { p -> p[stringPreferencesKey(key)] = value }
    }

    override fun commands(): List<String> = listOf(
        "ui_store_snapshot",
        "ui_store_set_kv",
        "ui_store_remove_kv",
        "ui_store_record_turn_stats",
        "ui_store_get_turn_stats",
        "ui_store_get_turn_stats_window",
        "ui_store_record_event",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "ui_store_snapshot" -> {
                scope.launch {
                    val raw = readRaw()
                    val kv = JSONObject()
                    raw.forEach { (k, v) ->
                        if (k.startsWith(KV_PREFIX)) {
                            try { kv.put(k.removePrefix(KV_PREFIX), parseJsonOrString(v)) } catch (_: Exception) {}
                        }
                    }
                    cb(JSONObject().put("kv", kv))
                }
                return null
            }
            "ui_store_set_kv" -> {
                val key = args.optString("key")
                val value = args.opt("value")
                scope.launch { write(KV_PREFIX + key, value.toString()); cb(true) }
                return null
            }
            "ui_store_remove_kv" -> {
                val key = args.optString("key")
                scope.launch {
                    context.uiDataStore.edit { p -> p.remove(stringPreferencesKey(KV_PREFIX + key)) }
                    cb(true)
                }
                return null
            }
            "ui_store_record_turn_stats" -> {
                val stats = args.optJSONObject("stats") ?: args
                scope.launch {
                    val list = readTurnsList()
                    val id = stats.optString("id")
                    var idx = -1
                    for (i in 0 until list.length()) {
                        if (list.optJSONObject(i)?.optString("id") == id) { idx = i; break }
                    }
                    if (idx >= 0) list.put(idx, stats) else list.put(stats)
                    write(TURNS_KEY, list.toString())
                    cb(true)
                }
                return null
            }
            "ui_store_get_turn_stats" -> {
                val sessionId = args.optString("sessionId")
                scope.launch {
                    val list = readTurnsList()
                    val out = JSONArray()
                    for (i in 0 until list.length()) {
                        if (list.optJSONObject(i)?.optString("sessionId") == sessionId) out.put(list.optJSONObject(i))
                    }
                    cb(out)
                }
                return null
            }
            "ui_store_get_turn_stats_window" -> {
                val sinceMs = args.optLong("sinceMs", 0)
                val limit = args.optInt("limit", 200)
                scope.launch {
                    val list = readTurnsList()
                    val out = JSONArray()
                    for (i in 0 until list.length()) {
                        val item = list.optJSONObject(i) ?: continue
                        if (item.optLong("startedAt", 0) >= sinceMs) out.put(item)
                    }
                    // newest first, capped
                    val trimmed = JSONArray()
                    var i = out.length() - 1
                    while (i >= 0 && trimmed.length() < limit) {
                        trimmed.put(out.optJSONObject(i))
                        i--
                    }
                    cb(trimmed)
                }
                return null
            }
            "ui_store_record_event" -> {
                val event = args
                scope.launch {
                    val events = readEventsList()
                    events.put(event)
                    if (events.length() > 500) {
                        val trimmed = JSONArray()
                        for (j in events.length() - 500 until events.length()) trimmed.put(events.optJSONObject(j))
                        write(EVENTS_KEY, trimmed.toString())
                    } else {
                        write(EVENTS_KEY, events.toString())
                    }
                    cb(true)
                }
                return null
            }
            else -> { cb(null); return null }
        }
    }

    private suspend fun readTurnsList(): JSONArray {
        return try {
            JSONArray(readRaw()[TURNS_KEY] ?: "[]")
        } catch (_: Exception) { JSONArray() }
    }

    private suspend fun readEventsList(): JSONArray {
        return try {
            JSONArray(readRaw()[EVENTS_KEY] ?: "[]")
        } catch (_: Exception) { JSONArray() }
    }

    private fun parseJsonOrString(raw: Any): Any {
        val text = raw.toString()
        return try {
            when {
                text.startsWith("{") -> JSONObject(text)
                text.startsWith("[") -> JSONArray(text)
                text == "true" -> true
                text == "false" -> false
                text == "null" -> JSONObject.NULL
                else -> raw
            }
        } catch (_: Exception) { raw }
    }
}
