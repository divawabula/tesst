(function () {
  if (window.top !== window || !globalThis.MLNative) return;
const chrome = (() => {
  const port = globalThis.MLNative;
  const TOKEN = '__ML_TOKEN__';
  const pend = new Map(); const msgL = []; let seq = 0, fontsCache = null;
  const send = (type, data) => new Promise((res) => {
    const id = ++seq; pend.set(id, res);
    try { port.postMessage(JSON.stringify({ id, token: TOKEN, type, ...data })); }
    catch (e) { pend.delete(id); res({ ok: false, error: 'Jembatan native tidak tersedia' }); }
  });
  port.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id) { const r = pend.get(m.id); if (r) { pend.delete(m.id); r(m); } }
    else if (m.evt) msgL.forEach((f) => { try { f(m.evt); } catch {} });
  };
  const wrap = (p, cb) => (cb ? void p.then(cb) : p);
  const api = {
    runtime: {
      id: 'mangalens-android', lastError: undefined,
      sendMessage(m, cb) { const { type, ...rest } = m; return wrap(send(type, rest), cb); },
      openOptionsPage() { return send('openOptions'); },
      onMessage: { addListener: (f) => msgL.push(f) }
    },
    storage: {
      local: {
        get(k, cb) {
          if (k === 'fonts' && fontsCache) return wrap(Promise.resolve({ fonts: fontsCache }), cb);
          return wrap(send('storageGet', { key: k }).then((r) => {
            const d = r.ok ? r.data || {} : {};
            if (k === 'fonts' && d.fonts) fontsCache = d.fonts;
            return d;
          }), cb);
        },
        set(o, cb) { fontsCache = null; return wrap(send('storageSet', { obj: o }).then(() => undefined), cb); }
      },
      onChanged: { addListener() {} }
    }
  };
  send('hello');
  return api;
})();

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
;
// MangaLens – inpainting lokal (tanpa model): hapus teks asli dari gambar
// Datar (bubble polos)  : isi piksel teks dengan warna latar (median ring)
// Kompleks (di atas art): mask berbasis gradien + interpolasi baris + difusi Gauss-Seidel
(() => {
  const MT = globalThis.MT;

  function dilate(m, w, h, r) {
    if (r <= 0) return m;
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h), p = new Int32Array(Math.max(w, h) + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w; p[0] = 0;
      for (let x = 0; x < w; x++) p[x + 1] = p[x] + m[row + x];
      for (let x = 0; x < w; x++) t[row + x] = p[Math.min(w, x + r + 1)] - p[Math.max(0, x - r)] > 0 ? 1 : 0;
    }
    for (let x = 0; x < w; x++) {
      p[0] = 0;
      for (let y = 0; y < h; y++) p[y + 1] = p[y] + t[y * w + x];
      for (let y = 0; y < h; y++) o[y * w + x] = p[Math.min(h, y + r + 1)] - p[Math.max(0, y - r)] > 0 ? 1 : 0;
    }
    return o;
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };

  /** @returns {{lum:number, flat:boolean}} */
  MT.inpaintRegion = (ctx, b, o) => {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const pad = Math.round(3 + Math.min(b.w, b.h) * 0.08);
    const x0 = Math.max(0, Math.floor(b.x - pad)), y0 = Math.max(0, Math.floor(b.y - pad));
    const x1 = Math.min(W, Math.ceil(b.x + b.w + pad)), y1 = Math.min(H, Math.ceil(b.y + b.h + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3) return { lum: 255, flat: true };
    const img = ctx.getImageData(x0, y0, w, h), d = img.data;
    const thr = o.threshold;

    // 1) estimasi warna latar dari cincin tepi
    const ring = Math.max(1, Math.min(3, Math.min(w, h) >> 2));
    const R = [], G = [], B = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) { const i = (y * w + x) * 4; R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
    }
    const bg = [med(R.slice()), med(G.slice()), med(B.slice())];
    let near = 0;
    for (let k = 0; k < R.length; k++) if ((Math.abs(R[k] - bg[0]) + Math.abs(G[k] - bg[1]) + Math.abs(B[k] - bg[2])) / 3 <= thr * 0.6) near++;
    const flat = o.mode === 'solid' ? true : o.mode === 'diffusion' ? false : near / R.length >= 0.8;
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];

    // 2) mask teks (hanya di area dalam agar garis balon di tepi tidak ikut terhapus)
    const m = new Uint8Array(w * h);
    const lx0 = Math.max(1, Math.floor(b.x - pad * 0.5) - x0), ly0 = Math.max(1, Math.floor(b.y - pad * 0.5) - y0);
    const lx1 = Math.min(w - 1, Math.ceil(b.x + b.w + pad * 0.5) - x0), ly1 = Math.min(h - 1, Math.ceil(b.y + b.h + pad * 0.5) - y0);
    if (flat) {
      for (let y = ly0; y < ly1; y++) for (let x = lx0; x < lx1; x++) {
        const i = (y * w + x) * 4;
        if ((Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2])) / 3 > thr) m[y * w + x] = 1;
      }
    } else {
      const L = new Float32Array(w * h);
      for (let p = 0; p < w * h; p++) L[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
      const tg = thr * 1.2;
      for (let y = ly0; y < ly1; y++) for (let x = lx0; x < lx1; x++) {
        const p = y * w + x;
        if (Math.abs(L[p + 1] - L[p - 1]) + Math.abs(L[p + w] - L[p - w]) > tg) m[p] = 1;
      }
    }
    const mask = dilate(m, w, h, o.dilate + (flat ? 0 : 2));

    // 3) isi
    if (flat) {
      for (let p = 0; p < w * h; p++) if (mask[p]) { d[p * 4] = bg[0]; d[p * 4 + 1] = bg[1]; d[p * 4 + 2] = bg[2]; }
    } else {
      const F = new Float32Array(w * h * 3);
      for (let p = 0; p < w * h; p++) { F[p * 3] = d[p * 4]; F[p * 3 + 1] = d[p * 4 + 1]; F[p * 3 + 2] = d[p * 4 + 2]; }
      const idx = [];
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          if (!mask[y * w + x]) { x++; continue; }
          const s = x; while (x < w && mask[y * w + x]) x++;
          const e = x, lp = s > 0 ? (y * w + s - 1) * 3 : -1, rp = e < w ? (y * w + e) * 3 : -1;
          for (let k = s; k < e; k++) {
            const t = (k - s + 1) / (e - s + 1);
            for (let c = 0; c < 3; c++) {
              const a = lp >= 0 ? F[lp + c] : rp >= 0 ? F[rp + c] : bg[c];
              const z = rp >= 0 ? F[rp + c] : a;
              F[(y * w + k) * 3 + c] = a + (z - a) * t;
            }
            idx.push(y * w + k);
          }
        }
      }
      const it = Math.min(120, 30 + ((w + h) >> 3));
      for (let n = 0; n < it; n++) for (let q = 0; q < idx.length; q++) {
        const p = idx[q], x = p % w, y = (p / w) | 0;
        const l = (x > 0 ? p - 1 : p) * 3, r = (x < w - 1 ? p + 1 : p) * 3, u = (y > 0 ? p - w : p) * 3, v = (y < h - 1 ? p + w : p) * 3;
        F[p * 3] = (F[l] + F[r] + F[u] + F[v]) * 0.25;
        F[p * 3 + 1] = (F[l + 1] + F[r + 1] + F[u + 1] + F[v + 1]) * 0.25;
        F[p * 3 + 2] = (F[l + 2] + F[r + 2] + F[u + 2] + F[v + 2]) * 0.25;
      }
      for (const p of idx) { d[p * 4] = F[p * 3]; d[p * 4 + 1] = F[p * 3 + 1]; d[p * 4 + 2] = F[p * 3 + 2]; }
    }
    ctx.putImageData(img, x0, y0);
    return { lum, flat };
  };
})();
;
// MangaLens – tahap "tempel": typesetting otomatis. Berjalan di main thread ATAU Web Worker.
// Auto-fit ukuran font, word-wrap seimbang, tata letak mengikuti balon oval, outline adaptif.
(() => {
  const MT = globalThis.MT;
  const ROLE = { speech: 'dialogue', thought: 'thought', narration: 'narration', sfx: 'sfx', sign: 'other', other: 'other' };
  const NOSPACE = ['ja', 'zh', 'th'];
  const hasDoc = typeof document !== 'undefined';

  MT.canvas = (w, h) => {
    if (hasDoc) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return new OffscreenCanvas(w, h);
  };
  MT.PRED = {
    phase1: (r) => r.type !== 'sfx' && r.type !== 'watermark' && !r.skip,
    all: (r) => !!r.tr && !r.skip && r.type !== 'watermark'
  };

  const fontStr = (s, role, size) => {
    const f = s.fontRoles[role] || 'sans-serif';
    const fam = /^(sans-serif|serif|monospace)$/.test(f) ? f : `"${f}"`;
    return `${s.typo.bold || role === 'sfx' ? '700 ' : ''}${size}px ${fam}, "Comic Sans MS", Arial, sans-serif`;
  };

  /* ---------- tata letak persegi (kotak narasi, teks tanpa balon) ---------- */
  function wrap(ctx, text, maxW, cjk) {
    const out = [];
    for (const p of text.split('\n')) {
      const toks = cjk ? [...p] : p.split(/\s+/).filter(Boolean);
      let cur = '';
      for (const t of toks) {
        const test = cur + (cjk || !cur ? '' : ' ') + t;
        if (!cur || ctx.measureText(test).width <= maxW) cur = test; else { out.push(cur); cur = t; }
      }
      out.push(cur);
    }
    return out;
  }
  const widest = (ctx, lines) => Math.max(...lines.map((l) => ctx.measureText(l).width));

  function area(r, W, H) {
    const b = r.box, bb = r.bubble;
    let cx = b.x + b.w / 2, cy = b.y + b.h / 2, w = b.w * 1.1, h = b.h * 1.1;
    if (bb) {
      w = Math.max(w, bb.w * 0.74); h = Math.max(h, bb.h * 0.74);
      cx = bb.x + bb.w / 2; cy = bb.y + bb.h / 2;
    } else if (r.vertical || b.h > b.w * 2.2) {
      w = Math.max(w, Math.min(h * 0.6, b.w * 2.4));
    }
    w = Math.min(w, 2 * Math.min(cx, W - cx)); h = Math.min(h, 2 * Math.min(cy, H - cy));
    return { cx, cy, w: Math.max(w, 8), h: Math.max(h, 8) };
  }

  function layoutRect(ctx, text, role, a, s, cjk) {
    const lh = s.typo.lineHeight;
    const fits = (size) => {
      ctx.font = fontStr(s, role, size);
      const lines = wrap(ctx, text, a.w, cjk);
      return lines.length * size * lh <= a.h && widest(ctx, lines) <= a.w ? lines : null;
    };
    let lo = s.typo.minFont, hi = Math.max(lo, Math.min(s.typo.maxFont, Math.floor(a.h))), best = null, size = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, l = fits(mid);
      if (l) { best = l; size = mid; lo = mid + 1; } else hi = mid - 1;
    }
    ctx.font = fontStr(s, role, size);
    if (!best) best = wrap(ctx, text, a.w, cjk);
    if (best.length > 1) { // seimbangkan lebar baris
      let wl = widest(ctx, best), wh = a.w, bl = best;
      for (let i = 0; i < 8; i++) {
        const mid = (wl + wh) / 2, t = wrap(ctx, text, mid, cjk);
        if (t.length === best.length) { bl = t; wh = mid; } else wl = mid;
      }
      best = bl;
    }
    return { lines: best, size };
  }

  /* ---------- tata letak elips (balon bicara/pikiran): lebar tiap baris mengikuti kurva balon ---------- */
  function wrapVar(ctx, text, widthAt, cjk) {
    const toks = cjk ? [...text.replace(/\s+/g, '')] : text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const out = []; let cur = '';
    for (const t of toks) {
      const test = cur + (cjk || !cur ? '' : ' ') + t;
      if (ctx.measureText(test).width <= widthAt(out.length)) { cur = test; continue; }
      if (!cur) return null;
      out.push(cur); cur = t;
      if (ctx.measureText(cur).width > widthAt(out.length)) return null;
    }
    if (cur) out.push(cur);
    return out;
  }
  function layoutEllipse(ctx, text, role, A, B, s, cjk) {
    const fitsAt = (size) => {
      ctx.font = fontStr(s, role, size);
      const L = size * s.typo.lineHeight, maxN = Math.floor((2 * B) / L);
      for (let n = 1; n <= maxN; n++) {
        const widthAt = (i) => {
          if (i >= n) return 0;
          const dy = Math.abs(i + 0.5 - n / 2) * L + L / 2; // tepi terjauh baris dari pusat
          return dy >= B ? 0 : 2 * A * Math.sqrt(1 - (dy / B) ** 2);
        };
        const lines = wrapVar(ctx, text, widthAt, cjk);
        if (lines && lines.length <= n) return lines;
      }
      return null;
    };
    let lo = s.typo.minFont, hi = Math.min(s.typo.maxFont, Math.floor(2 * B)), best = null, size = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, l = fitsAt(mid);
      if (l) { best = l; size = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best ? { lines: best, size } : null;
  }

  function drawRegion(ctx, r, s) {
    const role = ROLE[r.type] || 'other';
    let text = (r.tr || '').trim();
    if (!text) return;
    if (s.typo.uppercase && role !== 'narration') text = text.toLocaleUpperCase();
    const cjk = NOSPACE.includes(s.tgtLang);
    const a = area(r, ctx.canvas.width, ctx.canvas.height);
    const rect = layoutRect(ctx, text, role, a, s, cjk);
    let best = { lines: rect.lines, size: rect.size, cx: a.cx, cy: a.cy };
    if (r.bubble && (r.type === 'speech' || r.type === 'thought')) {
      const bb = r.bubble, el = layoutEllipse(ctx, text, role, bb.w * 0.47, bb.h * 0.47, s, cjk);
      if (el && el.size >= rect.size) best = { lines: el.lines, size: el.size, cx: bb.x + bb.w / 2, cy: bb.y + bb.h / 2 };
    }
    const size = best.size * (r.scale || 1) * s.typo.scale, lh = s.typo.lineHeight;
    ctx.font = fontStr(s, role, size);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const light = (r.bgLum ?? 255) > 140;
    const stroke = s.typo.stroke === 'always' || (s.typo.stroke === 'auto' && (!r.flat || role === 'sfx' || role === 'narration'));
    ctx.fillStyle = light ? '#111' : '#fff';
    ctx.strokeStyle = light ? '#fff' : '#000';
    ctx.lineWidth = Math.max(2, size * 0.16);
    let y = best.cy - (best.lines.length * size * lh) / 2 + (size * lh) / 2;
    for (const line of best.lines) {
      if (stroke) ctx.strokeText(line, best.cx, y);
      ctx.fillText(line, best.cx, y);
      y += size * lh;
    }
  }

  /* ---------- API tahap inpainting & tempel ---------- */
  MT.cleanPage = (bmp, regions, s, pred) => {
    const c = MT.canvas(bmp.width, bmp.height);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
    MT.cleanRegions(c, regions, s, pred || MT.PRED.all);
    return c;
  };
  MT.cleanRegions = (c, regions, s, pred) => {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const r of regions) {
      if (r.cleaned || !pred(r)) continue;
      const info = MT.inpaintRegion(ctx, r.box, s.inpaint);
      r.bgLum = info.lum; r.flat = info.flat; r.cleaned = true;
    }
  };
  MT.pastePage = (canvas, regions, s) => {
    const ctx = canvas.getContext('2d');
    for (const r of regions) if (MT.PRED.all(r)) drawRegion(ctx, r, s);
    const type = s.outFormat === 'png' ? 'image/png' : s.outFormat === 'webp' ? 'image/webp' : 'image/jpeg';
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality: s.quality });
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Gagal membuat gambar'))), type, s.quality));
  };

  /* ---------- font unggahan (main thread & worker) ---------- */
  const loaded = new Set();
  MT.loadFontList = async (list) => {
    const set = hasDoc ? document.fonts : globalThis.fonts;
    for (const f of list) {
      if (loaded.has(f.id)) continue;
      try { const face = new FontFace(f.family, f.buf); await face.load(); set.add(face); loaded.add(f.id); }
      catch (e) { console.warn('MangaLens: gagal memuat font', f.family, e); }
    }
  };
  MT.ensureFonts = async () => {
    const fonts = (await MT.getFonts()).filter((f) => !loaded.has(f.id));
    if (!fonts.length) return;
    await MT.loadFontList(await Promise.all(fonts.map(async (f) => ({ id: f.id, family: f.family, buf: await (await fetch(f.dataUrl)).arrayBuffer() }))));
  };
})();
;
// MangaLens – penulis ZIP (tanpa kompresi, cepat) untuk "Unduh semua"
(() => {
  const MT = (globalThis.MT = globalThis.MT || {});
  const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u) => { let c = ~0; for (let i = 0; i < u.length; i++) c = T[(c ^ u[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
  /** @param {{name:string,data:Uint8Array}[]} files @returns {Blob} */
  MT.zip = (files) => {
    const enc = new TextEncoder(), parts = [], cen = []; let off = 0, cdSize = 0;
    const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    for (const f of files) {
      const n = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(10, tm, true); h.setUint16(12, dt, true);
      h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, n.length, true);
      parts.push(h.buffer, n, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true);
      c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
      cen.push(c.buffer, n); off += 30 + n.length + sz; cdSize += 46 + n.length;
    }
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...cen, e.buffer], { type: 'application/zip' });
  };
})();

;
  const __mlContent = function () {
// MangaLens – content script: UI di halaman + orkestrasi pipeline OCR → inpainting → terjemah → tempel
(() => {
  if (window.__mangalens) return;
  window.__mangalens = true;
  const MT = globalThis.MT;
  const S = { set: null, st: new WeakMap(), gen: 0, hist: [], queue: [], running: 0, jobSeq: 0, noWorker: false, stats: { done: 0, total: 0 }, hover: null, overBar: false, hideT: 0, io: null, mo: null };

  /* ================= util ================= */
  const msg = (type, data = {}) => new Promise((res, rej) => {
    try {
      chrome.runtime.sendMessage({ type, ...data }, (r) => {
        if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
        if (!r) return rej(new Error('Tidak ada respons dari ekstensi'));
        r.ok ? res(r.data) : rej(new Error(r.error));
      });
    } catch { rej(new Error('Ekstensi diperbarui – segarkan halaman ini.')); }
  });
  async function saveBlob(blob, name) {
    const b64 = await blobB64(blob);
    await msg('saveFile', { name, mime: blob.type || 'application/octet-stream', b64 });
    toast('Tersimpan di Download/MangaLens: ' + name);
  }
  const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
  const hostOff = () => S.set.disabledHosts.split('\n').some((h) => h.trim() && location.hostname.endsWith(h.trim()));
  const getSt = (img) => { let s = S.st.get(img); if (!s) S.st.set(img, (s = { busy: false, queued: false, done: false, msg: '', err: null, orig: null, url: null, blob: null, regions: null, showing: 'orig' })); return s; };
  const cand = (img) => img.naturalWidth >= S.set.minSize && img.naturalHeight >= S.set.minSize && img.getBoundingClientRect().width >= 120;
  const b64Blob = (b64, mime) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); };
  const blobB64 = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result.split(',')[1]); f.onerror = rej; f.readAsDataURL(b); });
  async function loadBlob(src) {
    src = new URL(src, location.href).href;
    if (/^(blob|data):/.test(src)) return (await fetch(src)).blob();
    try {
      const r = await msg('fetchImage', { url: src, referer: location.href });
      return b64Blob(r.b64, r.mime);
    } catch (e1) {
      // fallback: unduh dari konteks halaman (origin & cookie situs sendiri) – berhasil bila CDN mengizinkan CORS / same-site
      try {
        const r = await fetch(src, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const b = await r.blob();
        if (!/^image\//.test(b.type)) throw new Error('bukan gambar');
        return b;
      } catch (e2) {
        throw new Error(`${e1.message} · fallback halaman: ${e2.message}`);
      }
    }
  }

  /* ================= UI (shadow DOM) ================= */
  const host = document.createElement('div');
  host.id = 'mangalens-root';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font:13px/1.4 system-ui,"Segoe UI",Roboto,sans-serif}
    [hidden]{display:none!important}
    button{background:transparent;color:inherit;border:0;border-radius:7px;padding:6px 10px;cursor:pointer;white-space:nowrap}
    button:hover:not(:disabled){background:#2a3043} button:disabled{opacity:.5;cursor:default}
    button:focus-visible,textarea:focus-visible{outline:2px solid #8ea2ff;outline-offset:1px}
    .pri{background:#8ea2ff;color:#10131c;font-weight:600}.pri:hover:not(:disabled){background:#a9b7ff}
    .panel{background:#12141b;color:#e8eaf2;border:1px solid #2c3142;border-radius:11px;box-shadow:0 8px 30px #000a}
    #bar{position:fixed;display:flex;gap:6px;opacity:.88;transition:opacity .15s}#bar:hover{opacity:1}
    .ic{width:32px;height:32px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#12141be6;color:#e8eaf2;border:1px solid #2c3142;box-shadow:0 2px 10px #0008}
    .ic svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .ic.on{background:#8ea2ff;color:#10131c;border-color:#8ea2ff}.ic.on:hover{background:#a9b7ff!important}
    .ic.err{border-color:#ff8a8a;color:#ff8a8a}.ic.busy{cursor:progress}
    .sp{display:none;width:15px;height:15px;border:2px solid #ffffff40;border-top-color:#8ea2ff;border-radius:50%;animation:r .8s linear infinite}
    .busy .sp{display:block}.busy svg{display:none}@keyframes r{to{transform:rotate(360deg)}}
    #more{position:absolute;top:38px;right:0;min-width:176px;padding:4px;display:flex;flex-direction:column}#more button{text-align:left}
    #more button.dim{opacity:.4;pointer-events:none}
    #fab{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
    #menu{display:flex;flex-direction:column;padding:4px;min-width:210px}#menu button{text-align:left}
    #fMain{background:#12141b;color:#e8eaf2;border:1px solid #2c3142;border-radius:22px;padding:9px 14px;font-weight:600;box-shadow:0 6px 20px #0009}
    #toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:10px 14px;display:flex;gap:10px;align-items:center;max-width:min(560px,92vw)}
    #modal{position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh}
    .card{width:min(640px,94vw);max-height:86vh;display:flex;flex-direction:column}
    .hd,.ft{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2c3142}.ft{border:0;border-top:1px solid #2c3142;gap:8px;justify-content:flex-end}
    .list{overflow:auto;padding:6px 14px}.row{padding:10px 0;border-bottom:1px solid #20243180;display:grid;gap:6px}
    .o{color:#8f97b3;font-size:12px}.row textarea{width:100%;min-height:54px;background:#0c0e13;color:#e8eaf2;border:1px solid #2c3142;border-radius:7px;padding:7px;resize:vertical}
    .ctl{display:flex;gap:16px;align-items:center;color:#aab1c8;font-size:12px}
    @media (pointer:coarse){.ic{width:42px;height:42px}.ic svg{width:20px;height:20px}#more{top:48px;min-width:200px}#more button,#menu button{padding:12px 14px}#fMain{padding:12px 18px}.card{width:96vw}}
  </style>
  <div id="bar" hidden>
    <button id="bT" class="ic" aria-label="Terjemahkan"><svg viewBox="0 0 24 24"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span class="sp"></span></button>
    <button id="bM" class="ic" aria-label="Menu lainnya"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
    <div id="more" class="panel" hidden>
      <button id="mV">Asli ⇄ Terjemahan</button><button id="mE">Edit teks</button><button id="mS">Unduh gambar</button><button id="mR">Ulangi (tanpa cache)</button><button id="mO">Pengaturan</button>
    </div>
  </div>
  <div id="fab"><div id="menu" class="panel" hidden>
    <button id="fAll">Terjemahkan semua gambar</button><button id="fTog">Tampilkan asli ⇄ terjemahan</button>
    <button id="fZip">Unduh semua (ZIP)</button><button id="fStop">Hentikan proses</button><button id="fOpt">Pengaturan</button></div>
    <button id="fMain">MangaLens <span id="fStat"></span></button></div>
  <div id="toast" class="panel" hidden><span id="tMsg"></span><button id="tOpt" hidden>Pengaturan</button></div>
  <div id="modal" hidden></div>`;
  const $ = (id) => root.getElementById(id);

  function toast(text, withOpt) {
    $('tMsg').textContent = text; $('tOpt').hidden = !withOpt; $('toast').hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), withOpt ? 9000 : 5000);
  }
  function updateFab() {
    const { done, total } = S.stats;
    $('fStat').textContent = total && done < total ? `${done}/${total}` : '';
    if (S.running === 0 && !S.queue.length) S.stats = { done: 0, total: 0 };
  }
  function placeBar() {
    const img = S.hover; if (!img || !img.isConnected) return $('bar').setAttribute('hidden', '');
    const r = img.getBoundingClientRect();
    if (r.bottom < 40 || r.top > innerHeight - 40) return $('bar').setAttribute('hidden', '');
    const bar = $('bar'); bar.hidden = false;
    const w = bar.offsetWidth || 70;
    bar.style.top = Math.max(8, r.top + 8) + 'px';
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w - 8)) + 'px';
  }
  function refreshBar() {
    const img = S.hover; if (!img) return;
    const st = getSt(img), has = !!st.blob, work = st.busy || st.queued, t = $('bT');
    t.classList.toggle('busy', work); t.classList.toggle('on', has && !work); t.classList.toggle('err', !!st.err && !work && !has);
    t.title = work ? st.msg || 'Menerjemahkan…' : has ? (st.showing === 'tr' ? 'Tampilkan gambar asli' : 'Tampilkan terjemahan') : st.err ? `Gagal: ${st.err} (klik untuk coba lagi)` : 'Terjemahkan gambar ini';
    $('bM').title = 'Menu lainnya';
    for (const id of ['mV', 'mE', 'mS', 'mR']) $(id).classList.toggle('dim', !has || (work && id !== 'mS'));
    placeBar();
  }
  const closeMore = () => ($('more').hidden = true);
  const showBar = (img) => { clearTimeout(S.hideT); if (S.hover !== img) { S.hover = img; closeMore(); } refreshBar(); };
  const hideBar = () => { S.hideT = setTimeout(() => { if (!S.overBar) { S.hover = null; closeMore(); $('bar').hidden = true; } }, 700); };

  let lastMove = 0;
  const imgAt = (x, y) => {
    const els = document.elementsFromPoint(x, y);
    if (els.includes(host)) return 'bar';
    const hit = els.find((el) => el instanceof HTMLImageElement && cand(el));
    if (hit) return hit;
    for (const i of document.images) { // fallback: gambar dengan pointer-events:none
      const r = i.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && cand(i)) return i;
    }
    return null;
  };
  document.addEventListener('mousemove', (e) => {
    if (!S.set) return;
    const now = performance.now(); if (now - lastMove < 100) return; lastMove = now;
    const img = imgAt(e.clientX, e.clientY);
    if (img === 'bar') return;
    img ? showBar(img) : S.hover && hideBar();
  }, { passive: true });
  addEventListener('scroll', () => requestAnimationFrame(placeBar), { passive: true, capture: true });
  addEventListener('resize', placeBar);
  document.addEventListener('touchstart', (e) => {
    if (!S.set || !e.touches[0]) return;
    const t = e.touches[0], img = imgAt(t.clientX, t.clientY);
    if (img === 'bar') return;
    S.overBar = false;
    if (img) { clearTimeout(S.hideT); showBar(img); } else if (S.hover) hideBar();
  }, { passive: true });
  $('bar').addEventListener('mouseenter', () => { S.overBar = true; clearTimeout(S.hideT); });
  $('bar').addEventListener('mouseleave', () => { S.overBar = false; hideBar(); });

  $('bT').onclick = () => {
    const img = S.hover; if (!img) return;
    const st = getSt(img); if (st.busy || st.queued) return;
    st.blob ? toggle(img) : enqueue(img, true); refreshBar();
  };
  $('bM').onclick = () => ($('more').hidden = !$('more').hidden);
  const act = (id, fn) => ($(id).onclick = () => { closeMore(); S.hover && fn(S.hover); refreshBar(); });
  act('mV', (i) => toggle(i)); act('mE', (i) => openEditor(i)); act('mS', (i) => download(i)); act('mR', (i) => process(i, { noCache: true }));
  $('mO').onclick = () => { closeMore(); msg('openOptions'); };
  $('tOpt').onclick = () => msg('openOptions');
  $('fMain').onclick = () => ($('menu').hidden = !$('menu').hidden);
  $('fAll').onclick = () => { $('menu').hidden = true; translateAll(); };
  $('fTog').onclick = () => { $('menu').hidden = true; toggleAll(); };
  $('fZip').onclick = () => { $('menu').hidden = true; downloadAll(); };
  $('fStop').onclick = () => { $('menu').hidden = true; stopAll(); };
  $('fOpt').onclick = () => { $('menu').hidden = true; msg('openOptions'); };

  /* ================= penerapan hasil ================= */
  function remember(img, st) {
    if (st.orig) return;
    const pic = img.closest('picture');
    st.orig = { src: img.src, srcset: img.getAttribute('srcset') || '', cur: img.currentSrc || img.src, sources: pic ? [...pic.querySelectorAll('source')].map((s) => [s, s.srcset]) : [] };
  }
  function show(img, st, which) {
    if (which === 'tr' && st.blob) {
      if (st.url) URL.revokeObjectURL(st.url);
      st.url = URL.createObjectURL(st.blob);
      st.orig.sources.forEach(([s]) => (s.srcset = ''));
      img.removeAttribute('srcset'); img.src = st.url; st.showing = 'tr';
    } else {
      st.orig.sources.forEach(([s, v]) => (s.srcset = v));
      if (st.orig.srcset) img.setAttribute('srcset', st.orig.srcset);
      img.src = st.orig.src; st.showing = 'orig';
    }
  }
  const toggle = (img) => { const st = S.st.get(img); if (st?.blob) show(img, st, st.showing === 'tr' ? 'orig' : 'tr'); };
  function toggleAll() {
    const imgs = [...document.images].filter((i) => S.st.get(i)?.blob);
    const to = imgs.some((i) => S.st.get(i).showing === 'tr') ? 'orig' : 'tr';
    imgs.forEach((i) => show(i, S.st.get(i), to));
  }
  function download(img) {
    const st = S.st.get(img); if (!st?.blob) return;
    const name = (new URL(st.orig.cur, location.href).pathname.split('/').pop() || 'page').replace(/\.[^.]+$/, '');
    saveBlob(st.blob, `${name}_${S.set.tgtLang}.${S.set.outFormat === 'jpeg' ? 'jpg' : S.set.outFormat}`).catch((e) => toast(e.message));
  }

  async function downloadAll() {
    const items = [...document.images].map((i) => S.st.get(i)).filter((s) => s?.blob);
    if (!items.length) return toast('Belum ada gambar terjemahan untuk diunduh.');
    toast(`Menyusun ZIP (${items.length} gambar)…`);
    const ext = S.set.outFormat === 'jpeg' ? 'jpg' : S.set.outFormat, files = [];
    for (const [i, s] of items.entries()) {
      const base = (new URL(s.orig.cur, location.href).pathname.split('/').pop() || 'page').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
      files.push({ name: `${String(i + 1).padStart(3, '0')}_${base}.${ext}`, data: new Uint8Array(await s.blob.arrayBuffer()) });
    }
    try { await saveBlob(MT.zip(files), `mangalens_${location.hostname}.zip`); } catch (e) { toast(e.message); }
  }

  /* ================= OCR (slicing untuk strip webtoon panjang) ================= */
  const norm = (a, y0, h, W) => {
    if (!Array.isArray(a) || a.length !== 4) return null;
    const [t, l, b, r] = a.map((v) => Math.max(0, Math.min(1000, +v || 0)));
    if (b - t < 2 || r - l < 2) return null;
    return { x: (l / 1000) * W, y: y0 + (t / 1000) * h, w: ((r - l) / 1000) * W, h: ((b - t) / 1000) * h };
  };
  async function ocrAll(bmp, tick, noCache, fast) {
    const W = bmp.width, H = bmp.height, ch = Math.max(600, Math.round(W * S.set.sliceRatio)), ovl = Math.round(ch * 0.07);
    const chunks = [];
    if (H <= ch * 1.2) chunks.push([0, H]);
    else for (let y = 0; ;) { const e = Math.min(H, y + ch); chunks.push([y, e]); if (e >= H) break; y = e - ovl; }
    let done = 0;
    const parts = await Promise.all(chunks.map(async ([y0, y1], i) => {
      const h = y1 - y0, k = Math.min(1, S.set.ocrMaxSide / Math.max(W, h));
      const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(bmp, 0, y0, W, h, 0, 0, c.width, c.height);
      const b64 = await blobB64(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88)));
      const raw = await msg(fast ? 'ocrTranslate' : 'ocr', { b64, mime: 'image/jpeg', noCache, history: S.hist.slice(-10) });
      tick(fast ? `Membaca & menerjemahkan ${++done}/${chunks.length}` : `1/4 OCR ${++done}/${chunks.length}`);
      const m = ovl / 2, out = [];
      for (const r of raw) {
        const box = norm(r.box, y0, h, W), text = (r.text || '').trim();
        if (!box || !text) continue;
        const cy = box.y + box.h / 2;
        if ((i > 0 && cy < y0 + m) || (i < chunks.length - 1 && cy >= y1 - m)) continue; // dedup area overlap
        let bubble = norm(r.bubble, y0, h, W);
        if (bubble) {
          const cx = box.x + box.w / 2, a = bubble.w * bubble.h, ba = box.w * box.h;
          if (cx < bubble.x || cx > bubble.x + bubble.w || cy < bubble.y || cy > bubble.y + bubble.h || a < ba * 0.8 || a > ba * 14) bubble = null;
        }
        out.push({ box, bubble, text, type: r.type || 'other', vertical: !!r.vertical, tr0: String(r.translation ?? '').trim() });
      }
      return out;
    }));
    return parts.flat().map((r, i) => ({ ...r, id: i + 1 }));
  }

  /* ================= mesin render: Web Worker (utama) / main thread (cadangan) ================= */
  const E = { w: null, readyP: null, seq: 0, pending: new Map(), fonts: new Set(), jobs: new Map() };
  const slimSet = () => ({ typo: S.set.typo, inpaint: S.set.inpaint, fontRoles: S.set.fontRoles, tgtLang: S.set.tgtLang, outFormat: S.set.outFormat, quality: S.set.quality });
  const slimR = (rs) => rs.map((r) => ({ id: r.id, box: r.box, bubble: r.bubble, type: r.type, vertical: r.vertical, tr: r.tr, skip: r.skip, scale: r.scale, cleaned: r.cleaned, bgLum: r.bgLum, flat: r.flat }));
  const syncR = (rs, res) => { const m = new Map(res.map((x) => [x.id, x])); for (const r of rs) { const u = m.get(r.id); if (u) { r.bgLum = u.bgLum; r.flat = u.flat; r.cleaned = u.cleaned; } } };
  function failWorker() {
    S.noWorker = true; E.readyP = null;
    for (const [, p] of E.pending) p.rej(Object.assign(new Error('Worker berhenti'), { wk: true }));
    E.pending.clear(); try { E.w?.terminate(); } catch {} E.w = null;
  }
  function getWorker() {
    if (!S.set.useWorker || S.noWorker) return Promise.resolve(null);
    return (E.readyP ||= (async () => {
      try {
        const url = URL.createObjectURL(new Blob([await msg('workerSource')], { type: 'text/javascript' }));
        const w = new Worker(url);
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), 3000);
          w.onmessage = (e) => { if (e.data.ready) { clearTimeout(t); res(); } };
          w.onerror = () => { clearTimeout(t); rej(new Error('worker error')); };
        });
        URL.revokeObjectURL(url);
        w.onmessage = (e) => { const p = E.pending.get(e.data.id); if (!p) return; E.pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(Object.assign(new Error(e.data.error), { wk: true })); };
        w.onerror = failWorker; E.w = w; return w;
      } catch { S.noWorker = true; return null; } // CSP situs memblokir worker → pakai main thread
    })());
  }
  const call = (w, m, tr = []) => new Promise((res, rej) => { const id = ++E.seq; E.pending.set(id, { res, rej }); w.postMessage({ ...m, id }, tr); });
  async function workerFonts(w) {
    const fresh = (await MT.getFonts()).filter((f) => !E.fonts.has(f.id));
    if (!fresh.length) return;
    const list = await Promise.all(fresh.map(async (f) => ({ id: f.id, family: f.family, buf: await (await fetch(f.dataUrl)).arrayBuffer() })));
    await call(w, { op: 'fonts', fonts: list }, list.map((f) => f.buf));
    fresh.forEach((f) => E.fonts.add(f.id));
  }
  async function engBegin(job, mk, regions, mode) {
    const w = await getWorker();
    if (w) {
      try {
        await workerFonts(w);
        const bmp = await mk();
        const res = await call(w, { op: 'begin', job, mode, bmp, regions: slimR(regions), set: slimSet() }, [bmp]);
        syncR(regions, res.regions); E.jobs.set(job, 'w'); return;
      } catch (e) { if (!e.wk) throw e; failWorker(); regions.forEach((r) => (r.cleaned = false)); }
    }
    const bmp = await mk();
    E.jobs.set(job, MT.cleanPage(bmp, regions, S.set, MT.PRED[mode])); bmp.close();
  }
  async function engFinish(job, regions) {
    const j = E.jobs.get(job); E.jobs.delete(job);
    if (j === 'w') {
      if (!E.w) throw new Error('Worker berhenti. Coba lagi.');
      const res = await call(E.w, { op: 'finish', job, regions: slimR(regions), set: slimSet() });
      syncR(regions, res.regions); return res.blob;
    }
    MT.cleanRegions(j, regions, S.set, MT.PRED.all);
    return MT.pastePage(j, regions, S.set);
  }
  function engDrop(job) { const j = E.jobs.get(job); E.jobs.delete(job); if (j === 'w') E.w?.postMessage({ op: 'drop', job, id: 0 }); }

  /* ================= pipeline utama ================= */
  async function process(img, { noCache = false } = {}) {
    const st = getSt(img); if (st.busy) return;
    const gen = S.gen, job = ++S.jobSeq, ck = () => { if (gen !== S.gen) throw new Error('__abort'); };
    const tick = (t) => { st.msg = t; if (S.hover === img) refreshBar(); };
    st.busy = true; st.err = null; refreshBar();
    try {
      if (!S.set.apiKey) throw Object.assign(new Error('API key Gemini belum diisi.'), { key: true });
      remember(img, st);
      tick('Memuat gambar…');
      const [raw] = await Promise.all([loadBlob(st.orig.cur), MT.ensureFonts()]); ck();
      const mk = () => createImageBitmap(raw), fast = !!S.set.fastMode;
      const bmp = await mk();
      if (bmp.width * bmp.height > 40e6) { bmp.close(); throw new Error('Resolusi gambar terlalu besar.'); }
      tick(fast ? 'Membaca & menerjemahkan…' : '1/4 OCR…');
      const regions = await ocrAll(bmp, tick, noCache, fast); bmp.close(); ck();
      const texts = regions.filter((r) => r.type !== 'watermark' && !(S.set.skipSfx && r.type === 'sfx'));
      if (!texts.length) { st.done = true; tick('Tidak ada teks terdeteksi'); return; }

      if (fast) {
        for (const r of texts) r.tr = r.tr0;
      } else {
        tick('2/4 Inpainting · 3/4 Terjemah…');
        const trP = msg('translate', { items: texts.map((r) => ({ id: r.id, type: r.type, text: r.text })), history: S.hist.slice(-10), noCache });
        trP.catch(() => {});
        await engBegin(job, mk, regions, 'phase1'); // inpainting berjalan paralel dengan request terjemahan
        const map = new Map((await trP).map((t) => [t.id, String(t.translation ?? '').trim()])); ck();
        for (const r of texts) r.tr = map.get(r.id) ?? '';
      }
      for (const r of texts) if (!r.tr && r.type !== 'sfx') r.tr = r.text; // jangan biarkan balon kosong
      if (fast) { tick('2/4 Inpainting…'); await engBegin(job, mk, regions, 'all'); ck(); }
      tick('4/4 Menempel teks…');
      st.blob = await engFinish(job, regions); ck();
      st.regions = regions; st.done = true; show(img, st, 'tr');
      S.hist = [...S.hist, ...regions.filter((r) => r.tr && r.type !== 'sfx').map((r) => r.tr)].slice(-30);
      tick(`${texts.length} teks diterjemahkan`);
    } catch (e) {
      engDrop(job);
      if (e.message === '__abort') tick('Dibatalkan');
      else { st.err = e.message; toast(e.message, !!e.key || /API key/i.test(e.message)); }
    } finally { st.busy = false; refreshBar(); }
  }

  /* ================= antrean halaman ================= */
  function enqueue(img, force) {
    const st = getSt(img);
    if (st.busy || st.queued || (st.done && !force)) return;
    st.queued = true; st.msg = 'Dalam antrean…'; S.queue.push(img); S.stats.total++; pump(); updateFab(); refreshBar();
  }
  function pump() {
    while (S.running < S.set.pageConcurrency && S.queue.length) {
      let bi = 0, bs = Infinity;
      S.queue.forEach((im, i) => { const r = im.getBoundingClientRect(), p = r.bottom < 0 ? 1e7 - r.bottom : Math.max(0, r.top); if (p < bs) { bs = p; bi = i; } });
      const [img] = S.queue.splice(bi, 1); getSt(img).queued = false; S.running++;
      process(img).finally(() => { S.running--; S.stats.done++; updateFab(); pump(); });
    }
  }
  function translateAll() {
    if (!S.set.apiKey) return toast('API key Gemini belum diisi.', true);
    const imgs = [...document.images].filter((i) => cand(i) && !getSt(i).done)
      .sort((a, b) => a.getBoundingClientRect().top + scrollY - (b.getBoundingClientRect().top + scrollY));
    if (!imgs.length) return toast('Tidak ada gambar baru yang cocok di halaman ini.');
    imgs.forEach((i) => enqueue(i));
    toast(`${imgs.length} gambar masuk antrean.`);
  }
  function stopAll() { S.gen++; S.queue.forEach((i) => { getSt(i).queued = false; getSt(i).msg = ''; }); S.queue.length = 0; S.stats = { done: 0, total: S.running }; updateFab(); toast('Proses dihentikan.'); }

  function setupAuto() {
    S.io?.disconnect(); S.mo?.disconnect(); S.io = S.mo = null;
    $('fab').hidden = !S.set.showFab || hostOff();
    if (!S.set.autoTranslate || hostOff() || !S.set.apiKey) return;
    S.io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && cand(e.target) && enqueue(e.target)), { rootMargin: '800px 0px' });
    const watch = (i) => {
      if (i.__mlObs) return; i.__mlObs = true; S.io.observe(i);
      i.addEventListener('load', () => { const r = i.getBoundingClientRect(); if (S.io && r.bottom > -800 && r.top < innerHeight + 800 && cand(i)) enqueue(i); });
    };
    const scan = () => document.querySelectorAll('img').forEach(watch);
    scan(); S.mo = new MutationObserver(debounce(scan, 500)); S.mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ================= editor teks manual ================= */
  function openEditor(img) {
    const st = S.st.get(img); if (!st?.regions) return;
    const m = $('modal'); m.innerHTML = '';
    const card = document.createElement('div'); card.className = 'card panel';
    card.innerHTML = '<div class="hd"><b>Edit teks terjemahan</b><button id="mx">Tutup</button></div><div class="list"></div><div class="ft"><button id="mc">Batal</button><button id="ma" class="pri">Terapkan</button></div>';
    const list = card.querySelector('.list'), rows = [];
    for (const r of st.regions.filter((r) => r.type !== 'watermark')) {
      const row = document.createElement('div'); row.className = 'row';
      const o = document.createElement('div'); o.className = 'o'; o.textContent = `#${r.id} · ${r.type} · ${r.text}`;
      const ta = document.createElement('textarea'); ta.value = r.tr || '';
      const ctl = document.createElement('div'); ctl.className = 'ctl';
      ctl.innerHTML = '<label>Ukuran <input type="range" min="50" max="170" value="100"></label><label><input type="checkbox" checked> Tempel teks</label>';
      ctl.querySelector('[type=range]').value = Math.round((r.scale || 1) * 100); ctl.querySelector('[type=checkbox]').checked = !r.skip;
      row.append(o, ta, ctl); list.append(row); rows.push([r, ta, ctl.querySelector('[type=range]'), ctl.querySelector('[type=checkbox]')]);
    }
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    card.querySelector('#mx').onclick = card.querySelector('#mc').onclick = close;
    card.querySelector('#ma').onclick = async () => {
      for (const [r, ta, rg, cb] of rows) { r.tr = ta.value.trim(); r.scale = rg.value / 100; r.skip = !cb.checked; r.cleaned = false; }
      close(); st.busy = true; st.msg = 'Menerapkan…'; refreshBar();
      try {
        const raw = await loadBlob(st.orig.cur), job = ++S.jobSeq;
        await engBegin(job, () => createImageBitmap(raw), st.regions, 'all');
        st.blob = await engFinish(job, st.regions); show(img, st, 'tr'); st.msg = 'Perubahan diterapkan';
      } catch (e) { st.err = e.message; toast(e.message); } finally { st.busy = false; refreshBar(); }
    };
    m.append(card); m.hidden = false;
  }
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) { $('modal').hidden = true; $('modal').innerHTML = ''; } });

  /* ================= pesan dari popup / background ================= */
  chrome.runtime.onMessage.addListener((m) => {
    if (!S.set) return;
    if (m.type === 'translatePage') translateAll();
    else if (m.type === 'toggleAll') toggleAll();
    else if (m.type === 'stop') stopAll();
    else if (m.type === 'translateSrc') {
      const img = [...document.images].find((i) => i.currentSrc === m.src || i.src === m.src);
      img ? process(img) : toast('Gambar tidak ditemukan di halaman ini.');
    }
  });

  /* ================= init ================= */
  (async () => {
    S.set = await MT.getSettings();
    document.documentElement.appendChild(host);
    setupAuto();
    chrome.storage.onChanged.addListener(async (c) => { if (c.settings) { S.set = await MT.getSettings(); setupAuto(); } });
  })();
})();

  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __mlContent, { once: true }); else __mlContent();
})();
