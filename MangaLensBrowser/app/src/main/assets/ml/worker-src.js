globalThis.MT = {};
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
// MangaLens – Web Worker: inpainting + tempel teks di luar main thread
(() => {
  const MT = globalThis.MT, jobs = new Map();
  const slim = (rs) => rs.map((r) => ({ id: r.id, bgLum: r.bgLum, flat: r.flat, cleaned: r.cleaned }));
  const ok = (m, extra = {}) => self.postMessage({ id: m.id, ok: true, ...extra });
  self.onmessage = async (e) => {
    const m = e.data;
    try {
      if (m.op === 'fonts') { await MT.loadFontList(m.fonts); ok(m); }
      else if (m.op === 'begin') {
        const canvas = MT.cleanPage(m.bmp, m.regions, m.set, MT.PRED[m.mode]);
        m.bmp.close(); jobs.set(m.job, canvas); ok(m, { regions: slim(m.regions) });
      } else if (m.op === 'finish') {
        const canvas = jobs.get(m.job); if (!canvas) throw new Error('Job tidak ditemukan');
        MT.cleanRegions(canvas, m.regions, m.set, MT.PRED.all);
        const blob = await MT.pastePage(canvas, m.regions, m.set);
        jobs.delete(m.job); ok(m, { blob, regions: slim(m.regions) });
      } else if (m.op === 'drop') jobs.delete(m.job);
    } catch (err) { jobs.delete(m.job); self.postMessage({ id: m.id, ok: false, error: err.message || String(err) }); }
  };
  self.postMessage({ ready: 1 });
})();
