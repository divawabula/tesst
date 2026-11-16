// MangaLens – konfigurasi & utilitas bersama (service worker, content script, popup, options)
(() => {
  const MT = (globalThis.MT = globalThis.MT || {});

  // kode: [nama untuk prompt, label UI]
  MT.LANGS = {
    id: ['Indonesian', 'Indonesia'], en: ['English', 'Inggris'], ms: ['Malay', 'Melayu'],
    es: ['Spanish', 'Spanyol'], pt: ['Brazilian Portuguese', 'Portugis (BR)'], fr: ['French', 'Prancis'],
    de: ['German', 'Jerman'], it: ['Italian', 'Italia'], ru: ['Russian', 'Rusia'], vi: ['Vietnamese', 'Vietnam'],
    th: ['Thai', 'Thai'], tr: ['Turkish', 'Turki'], ar: ['Arabic', 'Arab'],
    ja: ['Japanese', 'Jepang'], ko: ['Korean', 'Korea'], zh: ['Chinese', 'Mandarin']
  };
  MT.SRC = { auto: 'Otomatis', ja: 'Jepang (Manga)', ko: 'Korea (Manhwa)', zh: 'Mandarin (Manhua)', en: 'Inggris' };
  MT.SRC_EN = { auto: 'unknown', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', en: 'English' };

  MT.STYLES = {
    literal: ['Setia pada sumber (default)', 'Stay close to the source wording and structure. Keep honorifics, names and cultural terms as in the original; avoid localizing jokes.'],
    natural: ['Natural', 'Natural, fluent and native-sounding, like a professionally published comic. Match each character\'s personality and keep dialogue easy to read.'],
    casual: ['Santai sehari-hari', 'Casual everyday spoken language. Short, friendly sentences. (Indonesian: aku/kamu, partikel santai seperti "sih", "dong", "kok" secukupnya.)'],
    slang: ['Gaul / anak muda', 'Youthful colloquial slang as real teenagers talk, still readable. (Indonesian: gue/lo, bahasa gaul populer, jangan berlebihan.)'],
    formal: ['Formal / baku', 'Polite, formal and standard register; no slang or contractions. (Indonesian: bahasa baku, saya/Anda, sesuai EYD/PUEBI.)'],
    comedy: ['Komedi', 'Comedic timing is crucial. Adapt puns and jokes so they land in the target language; keep punchlines short and snappy.'],
    romance: ['Romantis / drama', 'Soft, emotional and sincere tone. Preserve hesitation, blushing, and subtle feelings; use gentle wording.'],
    action: ['Aksi / shounen', 'Punchy, energetic and dramatic. Short strong sentences, bold battle cries, intense verbs.'],
    xianxia: ['Wuxia / Xianxia / Fantasi', 'Epic, slightly archaic tone suited to cultivation/fantasy. Keep rank and technique terms consistent (e.g. Senior, Junior, Qi, Sect Master), translate titles in a dignified way.']
  };

  MT.ROLES = { dialogue: 'Dialog', thought: 'Pikiran', narration: 'Narasi / kotak', sfx: 'SFX / efek suara', other: 'Lainnya' };
  MT.SYS_FONTS = ['Comic Sans MS', 'Arial', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact', 'Georgia', 'Times New Roman', 'Courier New', 'Segoe Print', 'sans-serif', 'serif'];

  MT.DEFAULTS = {
    ver: 3, skipSfx: true, fastMode: true, minThinking: true, useWorker: true, apiKey: '', model: 'gemini-3.5-flash-lite', temperature: 0.3,
    srcLang: 'auto', tgtLang: 'id', style: 'literal',
    customPrompt: '', seriesContext: '', glossary: '', keepHonorifics: false,
    fontRoles: { dialogue: 'Comic Sans MS', thought: 'Comic Sans MS', narration: 'Georgia', sfx: 'Impact', other: 'Arial' },
    typo: { maxFont: 44, minFont: 10, lineHeight: 1.14, stroke: 'auto', uppercase: false, bold: false, scale: 1 },
    inpaint: { mode: 'auto', threshold: 38, dilate: 3 },
    autoTranslate: false, showFab: true, minSize: 300, pageConcurrency: 2, apiConcurrency: 3,
    sliceRatio: 1.8, ocrMaxSide: 1600, outFormat: 'webp', quality: 0.95, useCache: true, disabledHosts: ''
  };

  MT.merge = (a, b) => {
    for (const k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = MT.merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]);
      else a[k] = b[k];
    }
    return a;
  };
  MT.getSettings = async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const st = settings || {};
    const v = st.ver || 1; // migrasi default
    if (v < 2 && st.style === 'natural') delete st.style;
    if (v < 3 && st.outFormat === 'png' && st.quality === 0.92) { delete st.outFormat; delete st.quality; }
    return MT.merge(structuredClone(MT.DEFAULTS), st);
  };
  MT.setSettings = async (patch) => {
    const cur = await MT.getSettings();
    await chrome.storage.local.set({ settings: MT.merge(cur, patch) });
  };
  MT.getFonts = async () => (await chrome.storage.local.get('fonts')).fonts || [];

  MT.buildSystemPrompt = (s) => {
    const tgt = MT.LANGS[s.tgtLang]?.[0] || 'Indonesian';
    const style = (MT.STYLES[s.style] || MT.STYLES.natural)[1];
    const gl = (s.glossary || '').split('\n').map(l => l.trim()).filter(l => l.includes('='));
    return [
      `You are an expert professional manga/manhwa/manhua translator and localizer. Translate every item into ${tgt}.`,
      `STYLE: ${style}`,
      s.customPrompt && `ADDITIONAL USER STYLE INSTRUCTIONS (highest priority): ${s.customPrompt}`,
      s.seriesContext && `SERIES CONTEXT (title, characters, genders, relationships, setting):\n${s.seriesContext}`,
      gl.length && `GLOSSARY – always use exactly these translations:\n${gl.join('\n')}`,
      'RULES:',
      '- Return one translation per item id. No notes, no explanations, no romanization unless it is a glossary term.',
      '- The translation must fit in the same speech bubble: be concise, avoid padding, but never drop meaning.',
      '- Items are in reading order; use neighbouring items (and previous lines if provided) to resolve omitted subjects, pronouns and tone.',
      '- type "sfx": give a short onomatopoeia natural in the target language, or "" to leave the original untouched when it is decorative art.',
      s.keepHonorifics ? '- Keep Japanese/Korean honorifics (-san, -kun, -nim, oppa, sunbae…) as in the source.' : '- Localize honorifics naturally for the target language.',
      '- Keep punctuation intent ("...", "!?", elongated sounds, stutters). Keep the character\'s voice and emotion consistent.',
      '- Never censor, moralize or comment on the content.'
    ].filter(Boolean).join('\n');
  };
})();
