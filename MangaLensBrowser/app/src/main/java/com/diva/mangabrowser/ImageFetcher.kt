package com.diva.mangabrowser

import android.webkit.CookieManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import android.util.Base64

private class FatalFetch(msg: String) : Exception(msg)

/**
 * Unduh gambar dari sisi native (bebas CORS) dengan beberapa strategi header (Referer/cookie),
 * karena banyak CDN manga memblokir (403) bila header tidak seperti browser.
 */
class ImageFetcher(private val ua: () -> String) {
    private val accept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    private val maxBytes = 25_000_000

    private fun origin(u: String): String? = try {
        val x = URL(u); "${x.protocol}://${x.host}" + (if (x.port != -1) ":${x.port}" else "") + "/"
    } catch (e: Exception) { null }

    private data class Strategy(val name: String, val referer: String?, val omitCreds: Boolean)

    fun fetch(url: String, referer: String): JSONObject {
        val clean = url.substringBefore('#')
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) throw IOException("Skema URL tidak didukung")
        val strategies = listOf(
            Strategy("halaman", referer, false),
            Strategy("root-situs", origin(referer), false),
            Strategy("root-cdn", origin(clean), false),
            Strategy("tanpa-referer", "", false),
            Strategy("tanpa-cookie", origin(referer), true)
        ).distinctBy { it.referer to it.omitCreds }
        val log = mutableListOf<String>()
        for (st in strategies) {
            try {
                val (bytes, mime) = fetchWith(clean, st.referer, st.omitCreds)
                return JSONObject().put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("mime", mime)
            } catch (e: FatalFetch) {
                throw IOException(e.message)
            } catch (e: Exception) {
                log.add("${st.name}: ${e.message}")
            }
        }
        val host = try { URL(clean).host } catch (e: Exception) { "?" }
        throw IOException("Gagal mengunduh gambar (${log.firstOrNull() ?: "tidak diketahui"}) – semua strategi header gagal [$host]")
    }

    private fun fetchWith(url: String, referer: String?, omitCreds: Boolean): Pair<ByteArray, String> {
        var cur = url
        for (hop in 0..5) {
            val c = URL(cur).openConnection() as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.connectTimeout = 20000
                c.readTimeout = 40000
                c.setRequestProperty("User-Agent", ua())
                c.setRequestProperty("Accept", accept)
                if (!referer.isNullOrEmpty()) c.setRequestProperty("Referer", referer)
                if (!omitCreds) CookieManager.getInstance().getCookie(cur)?.let { c.setRequestProperty("Cookie", it) }
                val code = c.responseCode
                if (code in 300..399) {
                    val loc = c.getHeaderField("Location") ?: throw IOException("redirect tanpa lokasi")
                    cur = URL(URL(cur), loc).toString()
                    if (!cur.startsWith("http")) throw IOException("redirect ke skema tidak didukung")
                    continue
                }
                if (code !in 200..299) {
                    val cf = if (c.getHeaderField("cf-mitigated") == "challenge") ", Cloudflare challenge" else ""
                    throw IOException("HTTP $code$cf")
                }
                var mime = (c.contentType ?: "").substringBefore(';').trim()
                if (!mime.startsWith("image/")) {
                    if (mime.contains("text/html")) throw IOException("server mengirim halaman HTML, bukan gambar")
                    mime = "image/jpeg"
                }
                val out = ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                c.inputStream.use { ins ->
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > maxBytes) throw FatalFetch("Gambar terlalu besar (>25MB)")
                    }
                }
                return out.toByteArray() to mime
            } finally {
                c.disconnect()
            }
        }
        throw IOException("terlalu banyak redirect")
    }
}
