package cn.org.hermesagent.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import cn.org.hermesagent.mobile.bridge.HermesBridge
import cn.org.hermesagent.mobile.bridge.HermesServiceLocator
import cn.org.hermesagent.mobile.core.AndroidCompatService
import cn.org.hermesagent.mobile.core.ConnectionStore
import cn.org.hermesagent.mobile.core.RuntimeConfig
import cn.org.hermesagent.mobile.core.UiStore
import cn.org.hermesagent.mobile.debug.DebugExport
import cn.org.hermesagent.mobile.file.FilePicker
import cn.org.hermesagent.mobile.net.ApiProxy
import cn.org.hermesagent.mobile.net.AuthManager
import cn.org.hermesagent.mobile.net.GatewayRelay
import cn.org.hermesagent.mobile.notify.Notifier
import cn.org.hermesagent.mobile.notify.SessionForegroundBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * Kotlin-native host for the Hermes Agent Android client.
 *
 * Replaces the Tauri/Rust shell: owns the WebView, hosts the React frontend
 * from assets, and exposes [HermesBridge] as the native command surface.
 * No Rust, no Tauri — transport (OkHttp), auth (DataStore), notifications and
 * the foreground service are all implemented natively in Kotlin.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: HermesBridge

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Native services created lazily so a splash/error screen can render even
    // when wiring fails; the bridge resolves them by name.
    private val services = HermesServiceLocator()

    private lateinit var debugExport: DebugExport
    private lateinit var filePicker: FilePicker

    // Serves bundled assets over https://appassets.androidplatform.net/
    // so ES modules (Vite output) load under a real, same-origin scheme.
    // file:///android_asset/ blocks <script type="module"> via CORS.
    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uiStore = UiStore(this)
        val connectionStore = ConnectionStore(this)
        val apiProxy = ApiProxy(connectionStore)
        val authManager = AuthManager(this, connectionStore, apiProxy)
        val relay = GatewayRelay(this, connectionStore, authManager, apiProxy, appScope)
        val notifier = Notifier(this)
        val runtimeConfig = RuntimeConfig(this, connectionStore, appScope)
        val fgBridge = SessionForegroundBridge(this)
        val compatService = AndroidCompatService { if (::webView.isInitialized) webView else null }
        debugExport = DebugExport(this)
        filePicker = FilePicker(this)

        services.register("ui_store", uiStore)
        services.register("connection_store", connectionStore)
        services.register("api_proxy", apiProxy)
        services.register("auth_manager", authManager)
        services.register("gateway_relay", relay)
        services.register("notifier", notifier)
        services.register("runtime_config", runtimeConfig)
        services.register("session_foreground", fgBridge)
        services.register("compat", compatService)
        services.register("debug_export", debugExport)
        services.register("file_picker", filePicker)

        bridge = HermesBridge(this, services, relay)
        relay.attachBridge(bridge)

        webView = WebView(this)
        configureWebView(webView)
        bridge.attach(webView)
        setContentView(webView)

        // Android system back → layered consumption by the frontend
        // (overlays → mobile drawer → sub-detail → SPA history → exit).
        // The renderer exposes window.__hermesBackRequest(): boolean; when it
        // returns false there is nothing left to consume and we finish().
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view == null) {
                    finish()
                    return
                }
                view.evaluateJavascript(
                    "window.__hermesBackRequest ? window.__hermesBackRequest() : false",
                ) { result ->
                    val consumed = result != null && result.trim() == "true"
                    if (!consumed && !isFinishing && !isDestroyed) {
                        finish()
                    }
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        debugExport.onActivityResult(requestCode, resultCode, data)
        filePicker.onActivityResult(requestCode, resultCode, data)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(view: WebView) {
        if (BuildConfig.DEBUG) {
            // Allow chrome://inspect debugging of the embedded frontend.
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.userAgentString = settings.userAgentString + " HermesAgentAndroid/0.7.0"

        view.webChromeClient = object : WebChromeClient() {
            // Let getUserMedia() work for voice input inside the WebView.
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { request.grant(request.resources) }
            }
        }

        view.webViewClient = object : WebViewClient() {
            // Serve bundled frontend assets through WebViewAssetLoader.
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): android.webkit.WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                // Everything lives in assets; never hand navigation to the OS.
                return false
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        appScope.cancel()
        services.shutdown()
    }
}
