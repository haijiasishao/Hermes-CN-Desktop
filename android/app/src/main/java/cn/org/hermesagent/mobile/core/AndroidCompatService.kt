package cn.org.hermesagent.mobile.core

import android.webkit.WebView
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android Remote-only commands that have no real native counterpart and were
 * stubs in the Rust android build too: memory editing (remote MEMORY.md is
 * server-owned), profile switching, directory picking, devtools toggle and
 * WebView zoom. Returning contract-compatible shapes keeps the frontend
 * bootstrap path identical without touching business code.
 */
class AndroidCompatService(
    private val webViewProvider: () -> WebView?,
) : BridgeService {

    override fun commands(): List<String> = listOf(
        "read_memory",
        "add_memory_entry",
        "update_memory_entry",
        "remove_memory_entry",
        "write_user_profile",
        "switch_profile",
        "pick_directory",
        "toggle_devtools",
        "set_ui_zoom",
        "open_workspace_path",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "read_memory" -> {
                // Remote MEMORY.md is owned by the backend; Android has no local file.
                cb(JSONObject()
                    .put("memory", JSONObject()
                        .put("content", "")
                        .put("exists", false)
                        .put("lastModified", JSONObject.NULL)
                        .put("entries", JSONArray())
                        .put("charCount", 0)
                        .put("charLimit", 2000)))
                return null
            }
            "add_memory_entry", "update_memory_entry", "remove_memory_entry", "write_user_profile" -> {
                cb(JSONObject().put("ok", false).put("error", "远程后端管理 MEMORY.md"))
                return null
            }
            "switch_profile" -> {
                cb(JSONObject()
                    .put("ok", false)
                    .put("currentProfile", "default")
                    .put("error", "Android Remote 仅单一 profile"))
                return null
            }
            "pick_directory" -> {
                cb(JSONObject().put("canceled", true).put("paths", JSONArray()))
                return null
            }
            "toggle_devtools" -> {
                cb(JSONObject().put("ok", true))
                return null
            }
            "set_ui_zoom" -> {
                val zoom = args.optDouble("zoomFactor", 1.0)
                webViewProvider()?.evaluateJavascript(
                    "document.documentElement.style.zoom = ${if (zoom > 0) zoom else 1.0};",
                    null,
                )
                cb(JSONObject().put("ok", true))
                return null
            }
            "open_workspace_path" -> {
                cb(JSONObject().put("ok", false).put("status", 0)
                    .put("statusText", "unsupported").put("headers", JSONObject()).put("body", ""))
                return null
            }
            else -> { cb(null); return null }
        }
    }
}
