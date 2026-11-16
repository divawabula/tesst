(async () => {
  const MT = globalThis.MT, $ = (id) => document.getElementById(id);
  let ft; const flash = () => { $('saved').classList.add('on'); clearTimeout(ft); ft = setTimeout(() => $('saved').classList.remove('on'), 1200); };
  /* ---------- tab ---------- */
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const pick = (id) => {
    if (!tabs.some((t) => t.dataset.t === id)) id = tabs[0].dataset.t;
    tabs.forEach((t) => { const on = t.dataset.t === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
    document.querySelectorAll('[role=tabpanel]').forEach((p) => (p.hidden = p.id !== 'p-' + id));
    history.replaceState(null, '', '#' + id);
  };
  tabs.forEach((t, i) => {
    t.onclick = () => pick(t.dataset.t);
    t.onkeydown = (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); pick(n.dataset.t);
    };
  });
  pick(location.hash.slice(1));
  const msg = (type) => new Promise((res, rej) => chrome.runtime.sendMessage({ type }, (r) => (r?.ok ? res(r.data) : rej(new Error(r?.error || 'gagal')))));
  const fill = (el, obj, f) => { for (const k in obj) el.add(new Option(f(obj[k]), k)); };
  fill($('src'), MT.SRC, (v) => v); fill($('tgt'), MT.LANGS, (v) => v[1]); fill($('style'), MT.STYLES, (v) => v[0]);

  const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
  const patchOf = (p, v) => p.split('.').reverse().reduce((a, k) => ({ [k]: a }), v);
  let settings = await MT.getSettings();

  /* ---------- font ---------- */
  const FONT_SAMPLE = 'Halo! Ini contoh teks 123?!';
  async function loadFonts() {
    const fonts = await MT.getFonts();
    for (const f of fonts) {
      try { const face = new FontFace(f.family, await (await fetch(f.dataUrl)).arrayBuffer()); await face.load(); document.fonts.add(face); } catch {}
    }
    return fonts;
  }
  async function renderFonts() {
    const fonts = await loadFonts(), box = $('fonts'); box.innerHTML = '';
    fonts.forEach((f) => {
      const d = document.createElement('div'); d.className = 'font';
      d.innerHTML = '<div style="min-width:130px"><b></b><div class="mu"></div></div><div class="pv"></div><button>Hapus</button>';
      d.querySelector('b').textContent = f.name; d.querySelector('.mu').textContent = Math.round(f.size / 1024) + ' KB';
      const pv = d.querySelector('.pv'); pv.textContent = FONT_SAMPLE; pv.style.fontFamily = `"${f.family}"`;
      d.querySelector('button').onclick = async () => {
        await chrome.storage.local.set({ fonts: fonts.filter((x) => x.id !== f.id) });
        const roles = structuredClone(settings.fontRoles);
        for (const r in roles) if (roles[r] === f.family) roles[r] = MT.DEFAULTS.fontRoles[r];
        await MT.setSettings({ fontRoles: roles }); settings = await MT.getSettings(); renderFonts();
      };
      box.append(d);
    });
    const r = $('roles'); r.innerHTML = '';
    for (const role in MT.ROLES) {
      const w = document.createElement('div'), sel = document.createElement('select');
      w.innerHTML = `<label>${MT.ROLES[role]}</label>`;
      MT.SYS_FONTS.forEach((n) => sel.add(new Option(n, n)));
      fonts.forEach((f) => sel.add(new Option('★ ' + f.name, f.family)));
      sel.value = settings.fontRoles[role]; sel.style.fontFamily = `"${sel.value}"`;
      sel.onchange = () => { sel.style.fontFamily = `"${sel.value}"`; MT.setSettings({ fontRoles: { [role]: sel.value } }).then(flash); };
      w.append(sel); r.append(w);
    }
  }
  async function addFonts(files) {
    const list = await MT.getFonts();
    for (const file of files) {
      try {
        const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5), family = 'MLF_' + id;
        await new FontFace(family, await file.arrayBuffer()).load(); // validasi
        list.push({ id, family, name: file.name.replace(/\.[^.]+$/, ''), dataUrl, size: file.size });
      } catch { alert(`File "${file.name}" bukan font yang valid.`); }
    }
    await chrome.storage.local.set({ fonts: list }); renderFonts();
  }
  $('drop').onclick = () => $('file').click();
  $('file').onchange = (e) => addFonts([...e.target.files]);
  $('drop').ondragover = (e) => { e.preventDefault(); $('drop').classList.add('on'); };
  $('drop').ondragleave = () => $('drop').classList.remove('on');
  $('drop').ondrop = (e) => { e.preventDefault(); $('drop').classList.remove('on'); addFonts([...e.dataTransfer.files]); };

  /* ---------- binding otomatis ---------- */
  function bind() {
    document.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k, v = get(settings, k);
      el.type === 'checkbox' ? (el.checked = !!v) : (el.value = v ?? '');
      const save = () => {
        const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : k === 'apiKey' ? el.value.trim() : el.value;
        MT.setSettings(patchOf(k, val)).then(async () => { settings = await MT.getSettings(); showPreset(); flash(); });
      };
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', save);
    });
  }
  const showPreset = () => ($('preset').textContent = (MT.STYLES[settings.style] || MT.STYLES.natural)[1]);

  /* ---------- aksi ---------- */
  $('test').onclick = async () => {
    $('status').textContent = 'Menguji…'; $('status').style.color = '';
    try { await msg('test'); $('status').textContent = '✓ Koneksi berhasil. Model merespons.'; $('status').style.color = '#7fe0a0'; }
    catch (e) { $('status').textContent = '✗ ' + e.message; $('status').style.color = '#ff8a8a'; }
  };
  $('clear').onclick = async () => { await msg('cacheClear'); alert('Cache dihapus.'); };
  $('exp').onclick = () => {
    const { apiKey, ...rest } = settings;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' }));
    a.download = 'mangalens-settings.json'; a.click();
  };
  $('imp').onclick = () => $('impf').click();
  $('impf').onchange = async (e) => {
    try { const j = JSON.parse(await e.target.files[0].text()); delete j.apiKey; await MT.setSettings(j); settings = await MT.getSettings(); bind(); renderFonts(); showPreset(); }
    catch { alert('File pengaturan tidak valid.'); }
  };

  bind(); showPreset(); renderFonts();
})();
