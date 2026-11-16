window.chrome = (() => {
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
