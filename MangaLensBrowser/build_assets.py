import re, pathlib
SRC = pathlib.Path('./mangalens_src')
OUT = pathlib.Path('./app/src/main/assets')
rd = lambda n: (SRC / n).read_text(encoding='utf-8')

# ---------- shim chrome.* -> jembatan native ----------
SHIM = r'''const chrome = (() => {
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
'''

# ---------- patch content.js untuk layar sentuh & simpan file ----------
c = rd('content.js')
def rep(s, old, new):
    assert old in s, old[:60]
    return s.replace(old, new, 1)

c = rep(c, "  const debounce = (f, ms)",
"""  async function saveBlob(blob, name) {
    const b64 = await blobB64(blob);
    await msg('saveFile', { name, mime: blob.type || 'application/octet-stream', b64 });
    toast('Tersimpan di Download/MangaLens: ' + name);
  }
  const debounce = (f, ms)""")
c = rep(c, """    const a = document.createElement('a'); a.href = URL.createObjectURL(st.blob);
    a.download = `${name}_${S.set.tgtLang}.${S.set.outFormat === 'jpeg' ? 'jpg' : S.set.outFormat}`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);""",
"""    saveBlob(st.blob, `${name}_${S.set.tgtLang}.${S.set.outFormat === 'jpeg' ? 'jpg' : S.set.outFormat}`).catch((e) => toast(e.message));""")
c = rep(c, """    const a = document.createElement('a'); a.href = URL.createObjectURL(MT.zip(files));
    a.download = `mangalens_${location.hostname}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);""",
"""    try { await saveBlob(MT.zip(files), `mangalens_${location.hostname}.zip`); } catch (e) { toast(e.message); }""")
c = rep(c, "bmp.width * bmp.height > 70e6", "bmp.width * bmp.height > 40e6")
c = rep(c, "  $('bar').addEventListener('mouseenter'",
"""  document.addEventListener('touchstart', (e) => {
    if (!S.set || !e.touches[0]) return;
    const t = e.touches[0], img = imgAt(t.clientX, t.clientY);
    if (img === 'bar') return;
    S.overBar = false;
    if (img) { clearTimeout(S.hideT); showBar(img); } else if (S.hover) hideBar();
  }, { passive: true });
  $('bar').addEventListener('mouseenter'""")
c = rep(c, "    .ctl{display:flex;gap:16px;align-items:center;color:#aab1c8;font-size:12px}\n  </style>",
"""    .ctl{display:flex;gap:16px;align-items:center;color:#aab1c8;font-size:12px}
    @media (pointer:coarse){.ic{width:42px;height:42px}.ic svg{width:20px;height:20px}#more{top:48px;min-width:200px}#more button,#menu button{padding:12px 14px}#fMain{padding:12px 18px}.card{width:96vw}}
  </style>""")

# ---------- bundel utama (disuntik di dokumen awal, hanya frame utama) ----------
parts = [rd('shared.js'), rd('inpaint.js'), rd('render.js'), rd('zip.js')]
bundle = ("(function () {\n  if (window.top !== window || !globalThis.MLNative) return;\n" + SHIM + "\n"
          + ";\n".join(parts) + "\n;\n  const __mlContent = function () {\n" + c + "\n  };\n"
          "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __mlContent, { once: true }); else __mlContent();\n})();\n")
(OUT / 'ml/bundle.js').write_text(bundle, encoding='utf-8')

# ---------- sumber worker (sama dengan background.js: workerSource) ----------
(OUT / 'ml/worker-src.js').write_text('globalThis.MT = {};\n;\n' + rd('inpaint.js') + '\n;\n' + rd('render.js') + '\n;\n' + rd('worker.js'), encoding='utf-8')

# ---------- halaman pengaturan (dipasang di WebView lewat asset loader) ----------
(OUT / 'mangalens/shim-options.js').write_text(SHIM, encoding='utf-8')
for n in ['shared.js', 'options.js', 'ui.css']:
    (OUT / 'mangalens' / n).write_text(rd(n), encoding='utf-8')
h = rd('options.html')
h = rep(h, '<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
h = rep(h, '<script src="shared.js"></script>', '<script src="shim-options.js"></script><script src="shared.js"></script>')
(OUT / 'mangalens/options.html').write_text(h, encoding='utf-8')
print('ok')
