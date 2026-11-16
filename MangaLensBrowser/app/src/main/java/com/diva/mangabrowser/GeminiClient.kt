package com.diva.mangabrowser

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/** Port dari background.js: OCR + terjemah lewat Gemini, dengan cache dan retry. Kunci API TIDAK pernah dikirim ke halaman web. */
class GeminiClient(private val store: Store) {
    @Volatile private var think = "level" // level -> budget -> off (fallback otomatis)
    private val sem = Semaphore(4)

    private fun jo(vararg p: Pair<String, Any?>) = JSONObject().also { o -> p.forEach { o.put(it.first, it.second) } }
    private fun ja(vararg v: Any?) = JSONArray().also { a -> v.forEach { a.put(it) } }

    private val safety: JSONArray = JSONArray().also { a ->
        for (c in listOf("HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"))
            a.put(jo("category" to "HARM_CATEGORY_$c", "threshold" to "BLOCK_ONLY_HIGH"))
    }

    private fun ocrSchema(withTranslation: Boolean): JSONObject {
        val props = jo(
            "box" to jo("type" to "ARRAY", "items" to jo("type" to "INTEGER")),
            "bubble" to jo("type" to "ARRAY", "items" to jo("type" to "INTEGER")),
            "text" to jo("type" to "STRING"),
            "type" to jo("type" to "STRING", "enum" to ja("speech", "thought", "narration", "sfx", "sign", "watermark", "other")),
            "vertical" to jo("type" to "BOOLEAN")
        )
        val req = ja("box", "text", "type")
        if (withTranslation) {
            props.put("translation", jo("type" to "STRING"))
            req.put("translation")
        }
        val item = jo("type" to "OBJECT", "properties" to props, "required" to req)
        return jo(
            "type" to "OBJECT",
            "properties" to jo("regions" to jo("type" to "ARRAY", "items" to item)),
            "required" to ja("regions")
        )
    }

    private val trSchema: JSONObject = jo(
        "type" to "OBJECT",
        "properties" to jo(
            "items" to jo(
                "type" to "ARRAY",
                "items" to jo(
                    "type" to "OBJECT",
                    "properties" to jo("id" to jo("type" to "INTEGER"), "translation" to jo("type" to "STRING")),
                    "required" to ja("id", "translation")
                )
            )
        ),
        "required" to ja("items")
    )

    private fun sha(s: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
        return d.joinToString("") { "%02x".format(it) }.take(32)
    }

    private fun post(url: String, key: String, body: String): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 20000
            c.readTimeout = 120000
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("x-goog-api-key", key)
            c.outputStream.use { it.write(body.toByteArray()) }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            return code to (stream?.bufferedReader()?.readText() ?: "")
        } finally {
            c.disconnect()
        }
    }

    private suspend fun generate(s: JSONObject, parts: JSONArray, system: String?, schema: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            val key = s.optString("apiKey", "")
            if (key.isBlank()) throw IllegalStateException("API key Gemini belum diisi. Buka Pengaturan.")
            val model = s.optString("model", "gemini-3.5-flash-lite")
            val url = "https://generativelanguage.googleapis.com/v1beta/models/${URLEncoder.encode(model, "UTF-8")}:generateContent"
            for (attempt in 0 until 5) {
                val gc = jo(
                    "temperature" to s.optDouble("temperature", 0.3),
                    "responseMimeType" to "application/json",
                    "responseSchema" to schema
                )
                val useThink = s.optBoolean("minThinking", true) && think != "off"
                if (useThink) gc.put("thinkingConfig", if (think == "level") jo("thinkingLevel" to "minimal") else jo("thinkingBudget" to 0))
                val body = jo(
                    "contents" to ja(jo("role" to "user", "parts" to parts)),
                    "generationConfig" to gc,
                    "safetySettings" to safety
                )
                if (system != null) body.put("systemInstruction", jo("parts" to ja(jo("text" to system))))
                val (code, text) = post(url, key, body.toString())
                if (code in 200..299) {
                    val j = JSONObject(text)
                    val arr = j.optJSONArray("candidates")?.optJSONObject(0)?.optJSONObject("content")?.optJSONArray("parts")
                    val sb = StringBuilder()
                    if (arr != null) for (i in 0 until arr.length()) {
                        val p = arr.getJSONObject(i)
                        if (!p.optBoolean("thought", false)) sb.append(p.optString("text", ""))
                    }
                    if (sb.isEmpty()) {
                        val br = j.optJSONObject("promptFeedback")?.optString("blockReason", "") ?: ""
                        throw IllegalStateException(if (br.isNotEmpty()) "Diblokir oleh filter Gemini: $br" else "Respons Gemini kosong")
                    }
                    val clean = sb.toString().replace(Regex("^```(?:json)?\\s*|\\s*```\$"), "").trim()
                    return@withContext JSONObject(clean)
                }
                var msg = ""
                try {
                    msg = JSONObject(text).optJSONObject("error")?.optString("message", "") ?: ""
                } catch (e: Exception) {
                }
                if (msg.isEmpty()) msg = "HTTP $code"
                if (code == 400 && useThink && Regex("think", RegexOption.IGNORE_CASE).containsMatchIn(msg)) {
                    think = if (think == "level") "budget" else "off"
                    continue
                }
                if (code in listOf(429, 500, 502, 503, 504) && attempt < 4) {
                    delay(1000L * (1 shl attempt) + (Math.random() * 500).toLong())
                    continue
                }
                throw IllegalStateException("Gemini $code: $msg")
            }
            throw IllegalStateException("Gemini tidak merespons setelah beberapa percobaan")
        }

    private fun imagePart(b64: String, mime: String) = jo("inline_data" to jo("mime_type" to mime, "data" to b64))

    suspend fun ocr(b64: String, mime: String, noCache: Boolean): JSONArray {
        val s = store.settings()
        val key = "ocr_" + sha(b64) + sha(s.optString("model") + s.optString("srcLang"))
        if (s.optBoolean("useCache", true) && !noCache) store.cacheGet(key)?.let { return JSONArray(it) }
        val j = sem.withPermit { generate(s, ja(imagePart(b64, mime), jo("text" to Prompts.ocr(s))), null, ocrSchema(false)) }
        val regions = j.optJSONArray("regions") ?: JSONArray()
        store.cachePut(key, regions.toString())
        return regions
    }

    /** Mode cepat: OCR + terjemah dalam satu panggilan. */
    suspend fun ocrTranslate(b64: String, mime: String, noCache: Boolean, history: List<String>): JSONArray {
        val s = store.settings()
        val system = Prompts.system(s)
        val key = "ot_" + sha(b64 + system) + sha(s.optString("model") + s.optString("srcLang"))
        if (s.optBoolean("useCache", true) && !noCache) store.cacheGet(key)?.let { return JSONArray(it) }
        val ctx = if (history.isNotEmpty()) "\nPrevious lines of this chapter (context only):\n${history.joinToString("\n")}\n" else ""
        val prompt = Prompts.ocr(s) + "\nAdditionally, for EVERY region add \"translation\": the text translated into ${Prompts.targetName(s)} " +
            "following the system rules. Use the whole image (scene, speakers, tone) as context; regions are in reading order.$ctx"
        val j = sem.withPermit { generate(s, ja(imagePart(b64, mime), jo("text" to prompt)), system, ocrSchema(true)) }
        val regions = j.optJSONArray("regions") ?: JSONArray()
        store.cachePut(key, regions.toString())
        return regions
    }

    suspend fun translate(items: JSONArray, history: List<String>, noCache: Boolean): JSONArray {
        val s = store.settings()
        val system = Prompts.system(s)
        val payload = items.toString()
        val key = "tr_" + sha(system + payload + s.optString("model") + s.optDouble("temperature", 0.3))
        if (s.optBoolean("useCache", true) && !noCache) store.cacheGet(key)?.let { return JSONArray(it) }
        val ctx = if (history.isNotEmpty()) "Previous lines of this chapter (context only, do NOT translate):\n${history.joinToString("\n")}\n\n" else ""
        val j = sem.withPermit { generate(s, ja(jo("text" to "${ctx}Translate these items (reading order):\n$payload")), system, trSchema) }
        val out = j.optJSONArray("items") ?: JSONArray()
        store.cachePut(key, out.toString())
        return out
    }

    suspend fun test(): String {
        val s = store.settings()
        val schema = jo("type" to "OBJECT", "properties" to jo("ok" to jo("type" to "STRING")), "required" to ja("ok"))
        return generate(s, ja(jo("text" to "Return {\"ok\":\"pong\"}")), null, schema).optString("ok")
    }
}
