package com.diva.mangabrowser

import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var urlBar: EditText
    private lateinit var progress: ProgressBar
    private lateinit var customContainer: FrameLayout
    private lateinit var btnShield: ImageButton
    private lateinit var store: Store
    private lateinit var adBlocker: AdBlocker

    private val token = UUID.randomUUID().toString()
    private var bridge: TranslateBridge? = null
    private var translateReady = false
    private val scriptHandlers = mutableListOf<ScriptHandler>()

    @Volatile private var pageHost: String? = null
    @Volatile private var adblockGlobal = true
    @Volatile private var offHosts: Set<String> = emptySet()
    private var typedHost: String? = null

    @Volatile private var currentUA = ""
    private lateinit var mobileUA: String
    private var desktop = false

    private var customView: View? = null
    private var customCb: WebChromeClient.CustomViewCallback? = null
    private var fileCb: ValueCallback<Array<Uri>>? = null

    private val fileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCb = null
    }
    private val settingsLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        web.reload() // terapkan pengaturan/font baru
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.webView)
        urlBar = findViewById(R.id.urlBar)
        progress = findViewById(R.id.progress)
        customContainer = findViewById(R.id.customContainer)
        btnShield = findViewById(R.id.btnShield)

        store = Store(applicationContext)
        adBlocker = AdBlocker(applicationContext)
        adBlocker.load()
        adblockGlobal = store.adblockGlobal
        offHosts = store.adblockOffHosts()

        setupWebView()
        setupBridge()
        installScripts()
        setupBars()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> hideCustomView()
                    web.canGoBack() -> web.goBack()
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
                }
            }
        })

        val start = intent?.data?.toString()
        go(start ?: "https://duckduckgo.com")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.toString()?.let { go(it) }
    }

    override fun onPause() {
        store.blockedTotal = store.blockedTotal + adBlocker.sessionBlocked.getAndSet(0)
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    /* ======================= WebView ======================= */

    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false) // kurangi pelacakan lintas situs
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false // window.open tanpa gestur pengguna ditolak
            mediaPlaybackRequiresUserGesture = true       // tidak ada autoplay video iklan
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
        }
        mobileUA = web.settings.userAgentString
        currentUA = mobileUA

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!adblockActive() || request.isForMainFrame) return null
                val u = request.url
                if (adBlocker.isBlockedUrl(u.toString(), u.host)) {
                    adBlocker.pageBlocked.incrementAndGet()
                    adBlocker.sessionBlocked.incrementAndGet()
                    return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                }
                return null
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                when (uri.scheme) {
                    "http", "https" -> {
                        if (adblockActive() && uri.host != typedHost && adBlocker.isBlockedHost(uri.host)) {
                            countBlocked()
                            return true // redirect/pop-under ke jaringan iklan
                        }
                        return false
                    }
                    "about", "blob", "data" -> return false
                    "file", "content" -> return true
                    else -> {
                        // intent:, market:, mailto:, tel:, dll. -> hanya dengan gestur pengguna + konfirmasi
                        if (!request.hasGesture()) { countBlocked(); return true }
                        confirmExternal(uri.toString())
                        return true
                    }
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                pageHost = Uri.parse(url).host
                adBlocker.pageBlocked.set(0)
                if (!urlBar.hasFocus()) urlBar.setText(url)
                progress.visibility = View.VISIBLE
                updateShield()
            }

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.INVISIBLE
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                Toast.makeText(this@MainActivity, "Sertifikat situs tidak valid – dibatalkan.", Toast.LENGTH_LONG).show()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val html = "<html><body style='font-family:sans-serif;background:#12141b;color:#e8eaf2;padding:24px'>" +
                    "<h2>Halaman tidak dapat dibuka</h2><p>${error.description}</p><p style='color:#8f97b3'>${request.url}</p></body></html>"
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", request.url.toString())
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 0..99) View.VISIBLE else View.INVISIBLE
            }

            /** Pop-up: tolak tanpa gestur; dengan gestur dimuat di tab yang sama (kecuali host iklan). */
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (adblockActive() && !isUserGesture) { countBlocked(); return false }
                val temp = WebView(this@MainActivity)
                temp.settings.javaScriptEnabled = false
                var handled = false
                fun handle(url: String?) {
                    if (handled || url.isNullOrEmpty() || url == "about:blank") return
                    handled = true
                    val uri = Uri.parse(url)
                    if (adblockActive() && adBlocker.isBlockedUrl(url, uri.host)) countBlocked()
                    else if (uri.scheme == "http" || uri.scheme == "https") web.post { web.loadUrl(url) }
                    temp.post { temp.stopLoading(); temp.destroy() }
                }
                temp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                        handle(r.url.toString()); return true
                    }
                    override fun onPageStarted(v: WebView, url: String?, f: Bitmap?) = handle(url)
                }
                val transport = resultMsg.obj as WebView.WebViewTransport
                transport.webView = temp
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCb = callback
                customContainer.addView(view)
                customContainer.visibility = View.VISIBLE
                WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
            }

            override fun onHideCustomView() = hideCustomView()

            override fun onShowFileChooser(
                webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = callback
                return try {
                    fileLauncher.launch(params.createIntent()); true
                } catch (e: Exception) {
                    fileCb = null; false
                }
            }

            // izin kamera/mikrofon/lokasi ditolak secara default
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
                callback.invoke(origin, false, false)
        }

        web.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mime, _ ->
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                Toast.makeText(this, "Unduhan jenis ini belum didukung.", Toast.LENGTH_SHORT).show()
                return@DownloadListener
            }
            val name = URLUtil.guessFileName(url, contentDisposition, mime)
            AlertDialog.Builder(this).setTitle("Unduh file?").setMessage(name)
                .setPositiveButton("Unduh") { _, _ ->
                    val req = DownloadManager.Request(Uri.parse(url))
                        .setMimeType(mime)
                        .addRequestHeader("User-Agent", userAgent)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                    CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
                    (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                }
                .setNegativeButton("Batal", null).show()
        })

        web.setOnLongClickListener {
            val hit = web.hitTestResult
            val extra = hit.extra
            if (extra != null && (hit.type == WebView.HitTestResult.IMAGE_TYPE ||
                    hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE)) {
                showImageMenu(extra); true
            } else if (extra != null && hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE) {
                showLinkMenu(extra); true
            } else false
        }
    }

    private fun adblockActive(): Boolean {
        val h = pageHost
        return adblockGlobal && !(h != null && offHosts.contains(h))
    }

    private fun countBlocked() {
        adBlocker.pageBlocked.incrementAndGet()
        adBlocker.sessionBlocked.incrementAndGet()
    }

    private fun updateShield() {
        btnShield.alpha = if (adblockActive()) 1f else 0.35f
    }

    private fun hideCustomView() {
        val v = customView ?: return
        customContainer.removeView(v)
        customContainer.visibility = View.GONE
        customView = null
        customCb?.onCustomViewHidden()
        customCb = null
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    }

    /* ======================= penerjemah (jembatan + skrip suntikan) ======================= */

    private fun setupBridge() {
        translateReady = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (!translateReady) {
            Toast.makeText(
                this, "WebView perangkat terlalu lama: penerjemah gambar nonaktif. Perbarui Android System WebView.",
                Toast.LENGTH_LONG
            ).show()
            return
        }
        val b = TranslateBridge(
            ctx = applicationContext, store = store, trusted = false, token = token, scope = lifecycleScope,
            ua = { currentUA }, onOpenSettings = { openSettings() }
        )
        bridge = b
        WebViewCompat.addWebMessageListener(web, "MLNative", setOf("*"), b)
    }

    private fun readAsset(path: String) = assets.open(path).bufferedReader().readText()

    /** (Re)pasang skrip dokumen-awal. Dipanggil lagi saat daftar situs pengecualian anti-iklan berubah. */
    private fun installScripts() {
        scriptHandlers.forEach { it.remove() }
        scriptHandlers.clear()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val rules = setOf("*")
        val off = JSONArray(offHosts.toList()).toString()
        scriptHandlers += WebViewCompat.addDocumentStartJavaScript(
            web,
            readAsset("ml/adblock.js").replace("__ENABLED__", adblockGlobal.toString()).replace("__OFF__", off),
            rules
        )
        if (translateReady) {
            scriptHandlers += WebViewCompat.addDocumentStartJavaScript(
                web, readAsset("ml/bundle.js").replace("__ML_TOKEN__", token), rules
            )
        }
    }

    private fun openSettings() {
        settingsLauncher.launch(Intent(this, SettingsActivity::class.java))
    }

    private fun pushEvt(type: String, extra: (JSONObject) -> Unit = {}) {
        val evt = JSONObject().put("type", type).also(extra)
        if (bridge?.push(evt) != true) {
            Toast.makeText(this, "Penerjemah belum siap di halaman ini (tunggu sebentar / muat ulang).", Toast.LENGTH_SHORT).show()
        }
    }

    /* ======================= UI ======================= */

    private fun setupBars() {
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener { if (web.canGoBack()) web.goBack() }
        findViewById<ImageButton>(R.id.btnForward).setOnClickListener { if (web.canGoForward()) web.goForward() }
        findViewById<ImageButton>(R.id.btnReload).setOnClickListener {
            if (progress.visibility == View.VISIBLE) web.stopLoading() else web.reload()
        }
        findViewById<ImageButton>(R.id.btnTranslate).setOnClickListener { pushEvt("translatePage") }
        findViewById<ImageButton>(R.id.btnMenu).setOnClickListener { showMenu(it) }
        btnShield.setOnClickListener { toggleSiteAdblock() }

        urlBar.setOnEditorActionListener { v, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                go(v.text.toString())
                v.clearFocus()
                (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(v.windowToken, 0)
                true
            } else false
        }
    }

    private fun go(input: String) {
        val t = input.trim()
        if (t.isEmpty()) return
        val url = when {
            t.startsWith("http://") || t.startsWith("https://") -> t
            !t.contains(' ') && (t.contains('.') || t.startsWith("localhost")) -> "https://$t"
            else -> "https://duckduckgo.com/?q=" + Uri.encode(t)
        }
        typedHost = Uri.parse(url).host
        web.loadUrl(url)
    }

    private fun toggleSiteAdblock() {
        val h = pageHost ?: return
        val nowOff = !offHosts.contains(h)
        store.setAdblockOff(h, nowOff)
        offHosts = store.adblockOffHosts()
        installScripts()
        updateShield()
        Toast.makeText(this, if (nowOff) "Anti iklan dimatikan untuk $h" else "Anti iklan aktif untuk $h", Toast.LENGTH_SHORT).show()
        web.reload()
    }

    private fun showMenu(anchor: View) {
        val pm = PopupMenu(this, anchor)
        val m = pm.menu
        m.add(0, 1, 0, "Terjemahkan semua gambar di halaman")
        m.add(0, 2, 0, "Tampilkan asli ⇄ terjemahan")
        m.add(0, 3, 0, "Hentikan penerjemahan")
        m.add(0, 4, 0, "Anti iklan di situs ini").apply { isCheckable = true; isChecked = adblockActive() }
        m.add(0, 5, 0, "Diblokir di halaman ini: ${adBlocker.pageBlocked.get()} (total ${store.blockedTotal + adBlocker.sessionBlocked.get()})")
            .isEnabled = false
        m.add(0, 6, 0, "Perbarui daftar filter iklan (${adBlocker.size} domain)")
        m.add(0, 7, 0, "Situs desktop").apply { isCheckable = true; isChecked = desktop }
        m.add(0, 8, 0, "Pengaturan MangaLens (API key, gaya, font)")
        pm.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> pushEvt("translatePage")
                2 -> pushEvt("toggleAll")
                3 -> pushEvt("stop")
                4 -> toggleSiteAdblock()
                6 -> updateFilters()
                7 -> toggleDesktop()
                8 -> openSettings()
            }
            true
        }
        pm.show()
    }

    private fun updateFilters() {
        Toast.makeText(this, "Mengunduh daftar filter…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val n = adBlocker.update()
                Toast.makeText(this@MainActivity, "Daftar diperbarui: $n domain", Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Gagal memperbarui: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun toggleDesktop() {
        desktop = !desktop
        val ua = if (desktop) {
            mobileUA.replace(Regex("\\(Linux; Android [^)]*\\)"), "(X11; Linux x86_64)").replace(" Mobile", "")
        } else mobileUA
        web.settings.userAgentString = ua
        currentUA = ua
        web.settings.loadWithOverviewMode = desktop
        web.reload()
    }

    private fun showImageMenu(imageUrl: String) {
        val items = arrayOf("Terjemahkan gambar ini", "Buka gambar", "Salin alamat gambar")
        AlertDialog.Builder(this).setItems(items) { _, which ->
            when (which) {
                0 -> pushEvt("translateSrc") { it.put("src", imageUrl) }
                1 -> web.loadUrl(imageUrl)
                2 -> copy(imageUrl)
            }
        }.show()
    }

    private fun showLinkMenu(url: String) {
        AlertDialog.Builder(this).setTitle(url).setItems(arrayOf("Buka", "Salin tautan")) { _, which ->
            if (which == 0) go(url) else copy(url)
        }.show()
    }

    private fun copy(text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("url", text))
        Toast.makeText(this, "Disalin", Toast.LENGTH_SHORT).show()
    }

    private fun confirmExternal(url: String) {
        AlertDialog.Builder(this).setTitle("Buka aplikasi lain?").setMessage(url.take(160))
            .setPositiveButton("Buka") { _, _ ->
                try {
                    val i = if (url.startsWith("intent:")) Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    i.addCategory(Intent.CATEGORY_BROWSABLE)
                    i.component = null
                    i.selector = null
                    startActivity(i)
                } catch (e: Exception) {
                    Toast.makeText(this, "Tidak ada aplikasi untuk membuka ini.", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Batal", null).show()
    }
}
