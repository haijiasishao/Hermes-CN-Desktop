package cn.org.hermesagent.mobile.bridge

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native command surface injected as `window.HermesBridge`.
 *
 * Contract:
 *   - `HermesBridge.invoke(command, argsJson, callbackId)` is called by the
 *     frontend adapter (web/src/lib/hermes-native-bridge.ts). The result is
 *     delivered asynchronously via
 *     `window.__hermesBridgeResolve(callbackId, resultJson)` or
 *     `window.__hermesBridgeReject(callbackId, errorJson)`.
 *   - Native → JS events are pushed via `window.__hermesBridgeEmit(event, payloadJson)`.
 *
 * Commands are dispatched to registered [BridgeService] handlers by name,
 * mirroring the Tauri command surface so the frontend protocol layer is
 * byte-identical. Unknown commands resolve to a structured error so the
 * frontend can classify them like a Tauri AppError.
 */
class HermesBridge(
    private val activity: android.app.Activity,
    private val services: HermesServiceLocator,
    private val relay: cn.org.hermesagent.mobile.net.GatewayRelay,
) {
    private var webView: WebView? = null

    fun attach(view: WebView) {
        webView = view
        view.addJavascriptInterface(this, "HermesBridge")
    }

    /** Async invocation entry point. Never throws synchronously. */
    @JavascriptInterface
    fun invoke(command: String, argsJson: String, callbackId: String) {
        dispatch(command, argsJson, callbackId)
    }

    private fun dispatch(command: String, argsJson: String, callbackId: String) {
        val raw = runCatching { JSONObject(argsJson) }.getOrNull() ?: JSONObject()
        // Frontend contract: most commands pass `{ input: {...} }` (Tauri style),
        // a few pass flat fields (`{ remoteUrl }`, `{ content }`). Unwrap `input`
        // when present so handlers always receive the actual argument object.
        val args = if (raw.has("input") && raw.optJSONObject("input") != null) {
            raw.getJSONObject("input")
        } else {
            raw
        }
        val handler = services.handlerFor(command)
        if (handler == null) {
            reject(callbackId, "unknown command: $command")
            return
        }
        try {
            // Contract: a handler either returns a synchronous result (non-null)
            // or calls the callback asynchronously. If it returns null it MUST
            // call the callback eventually; never reject preemptively here,
            // otherwise async coroutine results would race the rejection and
            // the frontend would see "command returned no result" for valid
            // commands (connection config, login, API proxy, ...).
            val syncResult = handler.handle(command, args) { result ->
                resolve(callbackId, result)
            }
            if (syncResult != null) {
                resolve(callbackId, syncResult)
            }
        } catch (t: Throwable) {
            reject(callbackId, "${t.javaClass.simpleName}: ${t.message}")
        }
    }

    /** Deliver a successful command result to the renderer. */
    fun resolve(callbackId: String, result: Any?) {
        runOnUiThread {
            val json = result?.let { serialize(it) } ?: "null"
            evaluate("window.__hermesBridgeResolve(${jsString(callbackId)}, $json)")
        }
    }

    /** Deliver a command failure to the renderer (mirrors Tauri AppError). */
    fun reject(callbackId: String, message: String, code: String? = null) {
        runOnUiThread {
            val payload = JSONObject()
                .put("message", message)
                .apply { if (code != null) put("code", code) }
            evaluate("window.__hermesBridgeReject(${jsString(callbackId)}, ${JSONObject.quote(payload.toString())})")
        }
    }

    /** Push a native → JS event (e.g. gateway-ws-message). */
    fun emit(event: String, payload: Any? = null) {
        runOnUiThread {
            val payloadJson = payload?.let { serialize(it) } ?: "null"
            evaluate("window.__hermesBridgeEmit(${jsString(event)}, $payloadJson)")
        }
    }

    private fun serialize(value: Any): String {
        return when (value) {
            is String -> JSONObject.quote(value)
            is JSONObject, is JSONArray -> value.toString()
            is Map<*, *> -> JSONObject(value).toString()
            is Boolean -> value.toString()
            is Int, is Long -> value.toString()
            is Double, is Float -> value.toString()
            else -> JSONObject.quote(value.toString())
        }
    }

    private fun evaluate(script: String) {
        val view = webView ?: return
        view.evaluateJavascript(script, null)
    }

    private fun runOnUiThread(block: () -> Unit) {
        activity.runOnUiThread(block)
    }

    private fun jsString(value: String): String = JSONObject.quote(value)
}

typealias BridgeCallback = (Any?) -> Unit

/** A named command handler registered in the service locator. */
interface BridgeService {
    /** Commands this service handles (e.g. "get_connection_config"). */
    fun commands(): List<String>

    /**
     * Handle one command. Return the result synchronously, or call [cb] if
     * asynchronous work is required. Exactly one of them must fire.
     */
    fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any?
}
