package com.diva.mangabrowser

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

/**
 * Pemblokir iklan berbasis daftar host + pola URL.
 * Dipakai oleh shouldInterceptRequest (sub-resource), shouldOverrideUrlLoading (redirect) dan onCreateWindow (pop-up).
 */
class AdBlocker(private val ctx: Context) {
    @Volatile private var hosts: Set<String> = emptySet()
    @Volatile private var patterns: List<String> = emptyList()
    val pageBlocked = AtomicInteger(0)
    val sessionBlocked = AtomicInteger(0)

    private val extraFile get() = File(ctx.filesDir, "hosts_extra.txt")

    fun load() {
        val set = HashSet<String>(8192)
        ctx.assets.open("adblock/hosts.txt").bufferedReader().useLines { parseHosts(it, set) }
        if (extraFile.exists()) extraFile.useLines { parseHosts(it, set) }
        hosts = set
        patterns = ctx.assets.open("adblock/patterns.txt").bufferedReader().readLines()
            .map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
    }

    val size: Int get() = hosts.size

    private fun parseHosts(lines: Sequence<String>, out: MutableSet<String>) {
        for (raw in lines) {
            val line = raw.substringBefore('#').trim()
            if (line.isEmpty()) continue
            val parts = line.split(Regex("\\s+"))
            val h = (if (parts[0] == "127.0.0.1" || parts[0] == "0.0.0.0") parts.getOrNull(1) else parts[0])
                ?.lowercase() ?: continue
            if (h.contains('.') && !h.contains('/') && h != "localhost") out.add(h)
        }
    }

    fun isBlockedHost(host: String?): Boolean {
        if (host == null) return false
        var h = host.lowercase()
        val set = hosts
        while (true) {
            if (set.contains(h)) return true
            val i = h.indexOf('.')
            if (i < 0) return false
            h = h.substring(i + 1)
            if (!h.contains('.')) return false // jangan cocokkan TLD saja
        }
    }

    fun isBlockedUrl(url: String, host: String?): Boolean {
        if (isBlockedHost(host)) return true
        val p = patterns
        for (x in p) if (url.contains(x, ignoreCase = true)) return true
        return false
    }

    /** Unduh daftar server iklan (format hosts) dari Peter Lowe dan gabungkan dengan daftar bawaan. */
    suspend fun update(): Int = withContext(Dispatchers.IO) {
        val c = URL("https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext")
            .openConnection() as HttpURLConnection
        c.connectTimeout = 20000
        c.readTimeout = 40000
        try {
            if (c.responseCode !in 200..299) throw IllegalStateException("HTTP ${c.responseCode}")
            val text = c.inputStream.bufferedReader().readText()
            extraFile.writeText(text)
        } finally {
            c.disconnect()
        }
        load()
        size
    }
}
