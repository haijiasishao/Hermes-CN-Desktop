package cn.org.hermesagent.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class SaveDebugBundleArgs {
    lateinit var sourcePath: String
    var fileName: String? = null
}

@TauriPlugin
class DebugExportPlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingSource: File? = null

    @Command
    fun saveDebugBundle(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveDebugBundleArgs::class.java)
            val source = validateSource(args.sourcePath)
            pendingSource = source

            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/zip"
                putExtra(Intent.EXTRA_TITLE, safeFileName(args.fileName ?: source.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            startActivityForResult(invoke, intent, "saveDebugBundleResult")
        } catch (ex: Exception) {
            pendingSource = null
            invoke.reject(ex.message ?: "无法打开 Android 文件保存窗口")
        }
    }

    @ActivityCallback
    fun saveDebugBundleResult(invoke: Invoke, result: ActivityResult) {
        val source = pendingSource
        pendingSource = null

        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().apply {
                put("ok", false)
                put("canceled", true)
            })
            return
        }

        try {
            if (result.resultCode != Activity.RESULT_OK) {
                throw IllegalStateException("Android 文件保存窗口返回失败")
            }
            val sourceFile = source ?: throw IllegalStateException("debug 包临时文件已失效")
            val uri: Uri = result.data?.data
                ?: throw IllegalStateException("未获得 Android 文件保存位置")
            val output = activity.contentResolver.openOutputStream(uri, "w")
                ?: throw IllegalStateException("无法写入所选文件位置")
            output.use { stream ->
                sourceFile.inputStream().use { input -> input.copyTo(stream) }
            }

            val bytes = sourceFile.length()
            sourceFile.delete()
            invoke.resolve(JSObject().apply {
                put("ok", true)
                put("canceled", false)
                put("bytes", bytes)
                put("uri", uri.toString())
            })
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "无法写入 Android 文件位置")
        }
    }

    private fun validateSource(rawPath: String): File {
        val cacheRoot = activity.cacheDir.canonicalFile
        val source = File(rawPath).canonicalFile
        val cachePrefix = cacheRoot.path + File.separator
        if (!source.path.startsWith(cachePrefix) || !source.isFile) {
            throw IllegalArgumentException("debug 包临时文件路径无效")
        }
        return source
    }

    private fun safeFileName(rawName: String): String {
        val baseName = File(rawName).name
        return if (baseName.endsWith(".zip", ignoreCase = true)) baseName else "$baseName.zip"
    }
}
