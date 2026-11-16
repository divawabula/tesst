package com.diva.mangabrowser

import org.json.JSONObject

/** Port dari shared.js + ocrPrompt di background.js ekstensi MangaLens. */
object Prompts {
    val LANGS = mapOf(
        "id" to "Indonesian", "en" to "English", "ms" to "Malay", "es" to "Spanish", "pt" to "Brazilian Portuguese",
        "fr" to "French", "de" to "German", "it" to "Italian", "ru" to "Russian", "vi" to "Vietnamese",
        "th" to "Thai", "tr" to "Turkish", "ar" to "Arabic", "ja" to "Japanese", "ko" to "Korean", "zh" to "Chinese"
    )
    val SRC_EN = mapOf("auto" to "unknown", "ja" to "Japanese", "ko" to "Korean", "zh" to "Chinese", "en" to "English")

    val STYLES = mapOf(
        "literal" to "Stay close to the source wording and structure. Keep honorifics, names and cultural terms as in the original; avoid localizing jokes.",
        "natural" to "Natural, fluent and native-sounding, like a professionally published comic. Match each character's personality and keep dialogue easy to read.",
        "casual" to "Casual everyday spoken language. Short, friendly sentences. (Indonesian: aku/kamu, partikel santai seperti \"sih\", \"dong\", \"kok\" secukupnya.)",
        "slang" to "Youthful colloquial slang as real teenagers talk, still readable. (Indonesian: gue/lo, bahasa gaul populer, jangan berlebihan.)",
        "formal" to "Polite, formal and standard register; no slang or contractions. (Indonesian: bahasa baku, saya/Anda, sesuai EYD/PUEBI.)",
        "comedy" to "Comedic timing is crucial. Adapt puns and jokes so they land in the target language; keep punchlines short and snappy.",
        "romance" to "Soft, emotional and sincere tone. Preserve hesitation, blushing, and subtle feelings; use gentle wording.",
        "action" to "Punchy, energetic and dramatic. Short strong sentences, bold battle cries, intense verbs.",
        "xianxia" to "Epic, slightly archaic tone suited to cultivation/fantasy. Keep rank and technique terms consistent (e.g. Senior, Junior, Qi, Sect Master), translate titles in a dignified way."
    )

    fun targetName(s: JSONObject) = LANGS[s.optString("tgtLang", "id")] ?: "Indonesian"

    fun system(s: JSONObject): String {
        val tgt = targetName(s)
        val style = STYLES[s.optString("style", "literal")] ?: STYLES.getValue("natural")
        val gl = s.optString("glossary", "").lines().map { it.trim() }.filter { it.contains("=") }
        val out = mutableListOf<String>()
        out += "You are an expert professional manga/manhwa/manhua translator and localizer. Translate every item into $tgt."
        out += "STYLE: $style"
        s.optString("customPrompt", "").takeIf { it.isNotEmpty() }
            ?.let { out += "ADDITIONAL USER STYLE INSTRUCTIONS (highest priority): $it" }
        s.optString("seriesContext", "").takeIf { it.isNotEmpty() }
            ?.let { out += "SERIES CONTEXT (title, characters, genders, relationships, setting):\n$it" }
        if (gl.isNotEmpty()) out += "GLOSSARY – always use exactly these translations:\n" + gl.joinToString("\n")
        out += "RULES:"
        out += "- Return one translation per item id. No notes, no explanations, no romanization unless it is a glossary term."
        out += "- The translation must fit in the same speech bubble: be concise, avoid padding, but never drop meaning."
        out += "- Items are in reading order; use neighbouring items (and previous lines if provided) to resolve omitted subjects, pronouns and tone."
        out += """- type "sfx": give a short onomatopoeia natural in the target language, or "" to leave the original untouched when it is decorative art."""
        out += if (s.optBoolean("keepHonorifics", false))
            "- Keep Japanese/Korean honorifics (-san, -kun, -nim, oppa, sunbae…) as in the source."
        else "- Localize honorifics naturally for the target language."
        out += """- Keep punctuation intent ("...", "!?", elongated sounds, stutters). Keep the character's voice and emotion consistent."""
        out += "- Never censor, moralize or comment on the content."
        return out.joinToString("\n")
    }

    fun ocr(s: JSONObject): String {
        val src = s.optString("srcLang", "auto")
        val srcLine = if (src == "auto") "The source language is unknown (most likely Japanese, Korean or Chinese)."
        else "The source language is ${SRC_EN[src] ?: "unknown"}."
        return """You are a precise OCR + layout engine for comics (manga, manhwa, manhua). $srcLine
Find ALL text in this image: speech bubbles, thought bubbles, narration/caption boxes, signs, handwritten notes and sound effects (SFX).
For each region return:
- box: [ymin, xmin, ymax, xmax] normalized to 0-1000, TIGHT around the text glyphs only (all lines of that bubble/box merged into one region).
- bubble: [ymin, xmin, ymax, xmax] of the enclosing bubble/caption box interior, or [] if the text has no container.
- text: exact transcription in the original language, lines joined by a single space (keep punctuation and "..."; do not translate or correct).
- type: speech | thought | narration | sfx | sign | watermark (site logos, credits, scanlation watermarks) | other.
- vertical: true if the original text is written vertically.
Order regions in natural reading order (Japanese manga: right-to-left, top-to-bottom; manhwa/manhua: top-to-bottom, then left-to-right). If there is no text return an empty list."""
    }
}
