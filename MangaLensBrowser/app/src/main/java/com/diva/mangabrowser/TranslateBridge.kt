package com.diva.mangabrowser

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Jembatan antara JavaScript (shim chrome.* di halaman) dan kode native.
 *
 * Keamanan:
 *  - Hanya frame utama yang dilayani (iframe iklan ditolak).
 *  - Halaman web biasa (trusted = false) wajib menyertakan token acak yang hanya ada di dalam closure skrip suntikan.
 *  - Halaman web tidak pernah menerima API key; storageGet("settings") menyamarkannya.
 *  - Hanya halaman pengaturan lokal (trusted = true, origin appassets) yang boleh membaca/menulis kunci API.
 */
class TranslateBridge(
    private val ctx: Context,
    private val store: Store,
    private val trusted: Boolean,
    private val token: String,
    private val scope: CoroutineScope,
    ua: () -> String,
    private val onOpenSettings: () -> Unit
) : WebViewCompat.WebMessageListener {

    private val gemini = GeminiClient(store)
    private val fetcher = ImageFetcher(ua)
    @Volatile private var proxy: JavaScriptReplyProxy? = null

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy
    ) {
        if (!isMainFrame) return
        val text = message.data ?: return
        val req = try { JSONObject(text) } catch (e: Exception) { return }
        if (!trusted && req.optString("token") != token) return
        if (!trusted) proxy = replyProxy
        val id = req.optLong("id")
        scope.launch {
            val res = JSONObject().put("id", id)
            try {
                val data = withContext(Dispatchers.IO) { handle(req) }
                res.put("ok", true).put("data", data ?: JSONObject.NULL)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                res.put("ok", false).put("error", e.message ?: e.toString())
            }
            try { replyProxy.postMessage(res.toString()) } catch (e: Exception) { }
        }
    }

    /** Kirim perintah (mis. translatePage) ke halaman yang sedang aktif. Mengembalikan false bila halaman belum siap. */
    fun push(evt: JSONObject): Boolean {
        val p = proxy ?: return false
        return try { p.postMessage(JSONObject().put("evt", evt).toString()); true } catch (e: Exception) { false }
    }

    private fun history(req: JSONObject): List<String> {
        val a = req.optJSONArray("history") ?: return emptyList()
        return (0 until a.length()).map { a.optString(it) }
    }

    private suspend fun handle(req: JSONObject): Any? {
        return when (val type = req.optString("type")) {
            "hello" -> true
            "storageGet" -> storageGet(req.optString("key"))
            "storageSet" -> {
                if (!trusted) throw SecurityException("Ditolak")
                storageSet(req.getJSONObject("obj")); true
            }
            "ocr" -> gemini.ocr(req.getString("b64"), req.optString("mime", "image/jpeg"), req.optBoolean("noCache"))
            "ocrTranslate" -> gemini.ocrTranslate(
                req.getString("b64"), req.optString("mime", "image/jpeg"), req.optBoolean("noCache"), history(req)
            )
            "translate" -> gemini.translate(req.getJSONArray("items"), history(req), req.optBoolean("noCache"))
            "test" -> { if (!trusted) throw SecurityException("Ditolak"); gemini.test() }
            "fetchImage" -> fetcher.fetch(req.getString("url"), req.optString("referer"))
            "workerSource" -> ctx.assets.open("ml/worker-src.js").bufferedReader().readText()
            "cacheClear" -> { if (!trusted) throw SecurityException("Ditolak"); store.clearCache(); true }
            "openOptions" -> { withContext(Dispatchers.Main) { onOpenSettings() }; true }
            "saveFile" -> saveFile(req.optString("name", "gambar"), req.optString("mime", "application/octet-stream"), req.getString("b64"))
            else -> throw IllegalArgumentException("Perintah tidak dikenal: $type")
        }
    }

    private fun storageGet(key: String): JSONObject = when (key) {
        "settings" -> {
            val s = store.settings()
            if (!trusted && s.optString("apiKey").isNotEmpty()) s.put("apiKey", "•") // samarkan: halaman hanya perlu tahu "sudah diisi"
            JSONObject().put("settings", s)
        }
        "fonts" -> store.fontsJson()?.let { JSONObject().put("fonts", JSONArray(it)) } ?: JSONObject()
        else -> JSONObject()
    }

    private fun storageSet(o: JSONObject) {
        o.optJSONObject("settings")?.let { store.saveSettings(it) }
        o.optJSONArray("fonts")?.let { store.saveFonts(it) }
    }

    private fun saveFile(name: String, mime: String, b64: String): Boolean {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(100)
        val v = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safe)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MangaLens")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val r = ctx.contentResolver
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw IllegalStateException("Gagal membuat file")
        r.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("Gagal menulis file")
        v.clear()
        v.put(MediaStore.Downloads.IS_PENDING, 0)
        r.update(uri, v, null, null)
        return true
    }
}
