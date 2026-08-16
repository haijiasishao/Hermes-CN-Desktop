package cn.org.hermesagent.mobile.debug

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Debug bundle export (save_debug_bundle / export_debug_bundle).
 *
 * Android cannot write to user-visible paths directly; the export flow is:
 *   1. frontend calls export_debug_bundle → we stage a ZIP in app cache
 *   2. frontend calls save_debug_bundle → ACTION_CREATE_DOCUMENT SAF dialog
 *      copies the staged ZIP to the user-selected location and returns the URI
 */
class DebugExport(private val activity: Activity) : BridgeService {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    data class StagedBundle(var path: String = "", var sizeBytes: Long = 0)

    @Volatile
    var staged: StagedBundle = StagedBundle()

    override fun commands(): List<String> = listOf(
        "export_debug_bundle",
        "save_debug_bundle",
        "export_log_snapshot",
        "export_session_json",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "export_debug_bundle" -> {
                val frontendDebug = args.opt("frontendDebug")
                val renderer = args.optJSONObject("rendererDiagnostics")
                val connection = args.optJSONObject("connection")
                scope.launch {
                    val zip = stageDebugZip(frontendDebug, renderer, connection)
                    staged = StagedBundle(zip.absolutePath, zip.length())
                    cb(JSONObject()
                        .put("ok", true)
                        .put("zipPath", zip.absolutePath)
                        .put("directoryPath", zip.parent)
                        .put("sizeBytes", zip.length())
                        .put("includedFiles", 1)
                        .put("warnings", JSONArray()))
                }
                return null
            }
            "save_debug_bundle" -> {
                val sourcePath = args.optString("sourcePath", staged.path)
                val fileName = args.optString("fileName", "hermes-debug.zip")
                val src = File(sourcePath)
                if (!src.exists()) {
                    cb(JSONObject().put("ok", false).put("error", "staged bundle missing: $sourcePath"))
                    return null
                }
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/zip"
                    putExtra(Intent.EXTRA_TITLE, fileName)
                    // SAF copy happens onActivityResult via SaveDebugCallback
                }
                pendingSave = PendingSave(src, cb)
                activity.startActivityForResult(intent, REQ_SAVE_DEBUG)
                return null
            }
            "export_log_snapshot" -> {
                val fileName = args.optString("fileName", "hermes-log.txt")
                val content = args.optString("content")
                val format = args.optString("format", "log")
                val ext = if (format == "jsonl") "jsonl" else "txt"
                val safeName = "${fileName.substringBeforeLast('.').ifBlank { "hermes-log" }}.$ext"
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TITLE, safeName)
                }
                pendingSave = PendingSaveText(safeName, content, cb)
                activity.startActivityForResult(intent, REQ_SAVE_LOG)
                return null
            }
            "export_session_json" -> {
                val fileName = args.optString("fileName", "session.json")
                val content = args.optString("content", args.optJSONObject("session")?.toString() ?: "{}")
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, fileName.substringBeforeLast('.').ifBlank { "session" } + ".json")
                }
                pendingSave = PendingSaveText(fileName, content, cb)
                activity.startActivityForResult(intent, REQ_SAVE_JSON)
                return null
            }
            else -> { cb(null); return null }
        }
    }

    /** Called by MainActivity.onActivityResult for ACTION_CREATE_DOCUMENT. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            val pending = pendingSave
            pendingSave = null
            val cancelCb: BridgeCallback? = when (pending) {
                is PendingSave -> pending.cb
                is PendingSaveText -> pending.cb
                else -> null
            }
            cancelCb?.invoke(JSONObject().put("ok", false).put("canceled", true))
            return
        }
        val uri = data.data!!
        val pending = pendingSave
        pendingSave = null
        when (requestCode) {
            REQ_SAVE_DEBUG -> (pending as? PendingSave)?.let { copyToUri(it.file, uri, it.cb) }
            REQ_SAVE_LOG, REQ_SAVE_JSON -> {
                val textPending = pending as? PendingSaveText
                textPending?.let {
                    scope.launch {
                        val ok = writeTextToUri(it.content, uri)
                        it.cb(JSONObject()
                            .put("ok", ok)
                            .put("bytes", if (ok) it.content.toByteArray().size else 0)
                            .put("uri", uri.toString()))
                    }
                }
            }
        }
    }

    private fun copyToUri(file: File, uri: Uri, cb: BridgeCallback) {
        scope.launch {
            val copied: Boolean = withContext(Dispatchers.IO) {
                runCatching {
                    val out = activity.contentResolver.openOutputStream(uri) ?: return@runCatching false
                    out.use { o -> file.inputStream().use { it.copyTo(o) } }
                    true
                }.getOrDefault(false)
            }
            cb(JSONObject()
                .put("ok", copied)
                .put("bytes", if (copied) file.length() else 0)
                .put("uri", uri.toString()))
        }
    }

    private suspend fun writeTextToUri(content: String, uri: Uri): Boolean =
        withContext(Dispatchers.IO) {
            runCatching {
                val out = activity.contentResolver.openOutputStream(uri) ?: return@runCatching false
                out.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                true
            }.getOrDefault(false)
        }

    private suspend fun stageDebugZip(
        frontendDebug: Any?,
        renderer: JSONObject?,
        connection: JSONObject?,
    ): File = withContext(Dispatchers.IO) {
        val dir = File(activity.cacheDir, "hermes-debug-reports").apply { mkdirs() }
        val stamp = System.currentTimeMillis()
        val zip = File(dir, "hermes-debug-$stamp.zip")
        ZipOutputStream(FileOutputStream(zip)).use { zos ->
            val entries = mutableMapOf<String, ByteArray>()
            if (frontendDebug != null) {
                entries["diagnostics/frontend-debug-bus.json"] = frontendDebug.toString().toByteArray()
            }
            renderer?.let {
                entries["diagnostics/renderer.json"] = it.toString().toByteArray()
            }
            connection?.let {
                entries["diagnostics/connection.json"] = it.toString().toByteArray()
            }
            entries["diagnostics/app.json"] = JSONObject()
                .put("platform", "android")
                .put("kotlinNative", true)
                .put("ts", System.currentTimeMillis())
                .toString().toByteArray()
            for ((name, bytes) in entries) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(bytes)
                zos.closeEntry()
            }
        }
        zip
    }

    data class PendingSave(val file: File, val cb: BridgeCallback)
    data class PendingSaveText(val fileName: String, val content: String, val cb: BridgeCallback)

    @Volatile
    var pendingSave: Any? = null

    companion object {
        const val REQ_SAVE_DEBUG = 4201
        const val REQ_SAVE_LOG = 4202
        const val REQ_SAVE_JSON = 4203
    }
}
