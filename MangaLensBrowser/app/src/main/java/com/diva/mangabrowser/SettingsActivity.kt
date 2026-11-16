package com.diva.mangabrowser

import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** Halaman pengaturan MangaLens (options.html asli ekstensi) dimuat dari assets, terhubung ke Store lewat TranslateBridge tepercaya. */
class SettingsActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var fileCb: ValueCallback<Array<Uri>>? = null

    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCb = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Toast.makeText(this, "Perbarui Android System WebView untuk membuka pengaturan.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        web = WebView(this)
        setContentView(web)

        val origin = "https://appassets.androidplatform.net"
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.toString().startsWith(origin).not()
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = callback
                return try {
                    fileLauncher.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    fileCb = null
                    false
                }
            }
        }

        val bridge = TranslateBridge(
            ctx = applicationContext, store = Store(applicationContext), trusted = true, token = "",
            scope = lifecycleScope, ua = { "" }, onOpenSettings = { }
        )
        WebViewCompat.addWebMessageListener(web, "MLNative", setOf(origin), bridge)
        web.loadUrl("$origin/assets/mangalens/options.html")
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            (web.parent as? android.view.ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }
}
