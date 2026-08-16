package cn.org.hermesagent.mobile.file

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import cn.org.hermesagent.mobile.bridge.BridgeCallback
import cn.org.hermesagent.mobile.bridge.BridgeService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android SAF file picking (pick_files) + upload_file data URL conversion.
 *
 * The WebView cannot hand browser File bytes to the native upload path
 * directly; we launch ACTION_GET_CONTENT and read the content URI back into
 * base64 on the native side, then the frontend uses file.attach via ApiProxy.
 * Contract mirrors Tauri pickFiles → FilePickerResult.
 */
class FilePicker(private val activity: Activity) : BridgeService {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var pendingCb: BridgeCallback? = null

    data class Picked(val name: String, val mime: String, val dataB64: String, val size: Int)

    override fun commands(): List<String> = listOf(
        "pick_files",
        "read_picked_upload",
    )

    override fun handle(command: String, args: JSONObject, cb: BridgeCallback): Any? {
        when (command) {
            "pick_files" -> {
                pendingCb = cb
                val multi = args.optBoolean("multiple", false)
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    if (multi) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
                activity.startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_PICK_FILES)
                return null
            }
            "read_picked_upload" -> {
                // fallback: frontend passes uri + name
                val uriStr = args.optString("uri")
                if (uriStr.isBlank()) {
                    cb(JSONObject().put("ok", false).put("error", "missing uri"))
                    return null
                }
                scope.launch {
                    val picked = readUri(Uri.parse(uriStr))
                    if (picked == null) cb(JSONObject().put("ok", false).put("error", "cannot read uri"))
                    else cb(JSONObject()
                        .put("ok", true)
                        .put("name", picked.name)
                        .put("type", picked.mime)
                        .put("dataBase64", picked.dataB64)
                        .put("size", picked.size))
                }
                return null
            }
            else -> { cb(null); return null }
        }
    }

    /** Called by MainActivity.onActivityResult for ACTION_GET_CONTENT. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_PICK_FILES) return
        val cb = pendingCb
        pendingCb = null
        if (resultCode != Activity.RESULT_OK) {
            cb?.invoke(JSONObject().put("canceled", true).put("paths", JSONArray()))
            return
        }
        val uris = mutableListOf<Uri>()
        if (data?.clipData != null) {
            for (i in 0 until data.clipData!!.itemCount) {
                data.clipData!!.getItemAt(i).uri?.let { uris.add(it) }
            }
        } else {
            data?.data?.let { uris.add(it) }
        }
        if (uris.isEmpty()) {
            cb?.invoke(JSONObject().put("canceled", true).put("paths", JSONArray()))
            return
        }

        scope.launch {
            val results = JSONArray()
            for (uri in uris) {
                val picked = readUri(uri) ?: continue
                results.put(JSONObject()
                    .put("uri", uri.toString())
                    .put("name", picked.name)
                    .put("path", "content://${uri.host}/${uri.lastPathSegment}")
                    .put("type", picked.mime)
                    .put("dataBase64", picked.dataB64)
                    .put("size", picked.size))
            }
            cb?.invoke(JSONObject()
                .put("canceled", false)
                .put("paths", JSONArray().put(results)))
        }
    }

    private suspend fun readUri(uri: Uri): Picked? = withContext(Dispatchers.IO) {
        runCatching {
            val resolver = activity.contentResolver
            var name = "file"
            var size = -1
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0) name = c.getString(nameIdx) ?: "file"
                    if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getInt(sizeIdx)
                }
            }
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
            Picked(name, mime, Base64.encodeToString(bytes, Base64.NO_WRAP), bytes.size)
        }.getOrNull()
    }

    companion object {
        const val REQ_PICK_FILES = 4301
    }
}
