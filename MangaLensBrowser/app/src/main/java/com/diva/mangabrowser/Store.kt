package com.diva.mangabrowser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Penyimpanan lokal: pengaturan MangaLens, font kustom, cache terjemahan, dan preferensi anti iklan. */
class Store(ctx: Context) {
    private val sp = ctx.getSharedPreferences("ml", Context.MODE_PRIVATE)
    private val fontsFile = File(ctx.filesDir, "fonts.json")
    val cacheDir = File(ctx.cacheDir, "mlcache").apply { mkdirs() }

    fun settings(): JSONObject = try {
        JSONObject(sp.getString("settings", "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    fun saveSettings(o: JSONObject) = sp.edit().putString("settings", o.toString()).apply()

    fun fontsJson(): String? = if (fontsFile.exists()) fontsFile.readText() else null
    fun saveFonts(a: JSONArray) = fontsFile.writeText(a.toString())

    fun cacheGet(key: String): String? {
        val f = File(cacheDir, key)
        return if (f.exists()) f.readText().also { f.setLastModified(System.currentTimeMillis()) } else null
    }

    fun cachePut(key: String, value: String) {
        File(cacheDir, key).writeText(value)
        val files = cacheDir.listFiles() ?: return
        if (files.size > 800) files.sortedBy { it.lastModified() }.take(200).forEach { it.delete() }
    }

    fun clearCache() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    var adblockGlobal: Boolean
        get() = sp.getBoolean("ab_on", true)
        set(v) = sp.edit().putBoolean("ab_on", v).apply()

    fun adblockOffHosts(): Set<String> = HashSet(sp.getStringSet("ab_off", emptySet()) ?: emptySet())

    fun setAdblockOff(host: String, off: Boolean) {
        val s = HashSet(adblockOffHosts())
        if (off) s.add(host) else s.remove(host)
        sp.edit().putStringSet("ab_off", s).apply()
    }

    var blockedTotal: Long
        get() = sp.getLong("ab_total", 0L)
        set(v) = sp.edit().putLong("ab_total", v).apply()
}
