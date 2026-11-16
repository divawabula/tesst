// Anti-iklan sisi halaman (dijalankan di dokumen awal, semua frame).
(() => {
  const ENABLED = __ENABLED__;
  const OFF = __OFF__;
  if (!ENABLED || window.__mlAb) return;
  let topHost = location.hostname;
  try { const ao = location.ancestorOrigins; if (ao && ao.length) topHost = new URL(ao[ao.length - 1]).hostname; } catch (e) {}
  if (OFF.some((h) => topHost === h || topHost.endsWith('.' + h))) return;
  window.__mlAb = 1;

  /* 1) window.open: hanya boleh dari gestur pengguna nyata, maksimal 1x per 2 detik */
  const realOpen = window.open;
  let last = 0;
  try {
    Object.defineProperty(window, 'open', {
      configurable: true, writable: true,
      value: function () {
        const ua = navigator.userActivation;
        const now = Date.now();
        if (ua && !ua.isActive) return null;
        if (now - last < 2000) return null;
        last = now;
        return realOpen.apply(this, arguments);
      }
    });
  } catch (e) {}

  /* 2) CSS kosmetik: sembunyikan slot iklan umum */
  const css = [
    'ins.adsbygoogle', '.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]', '[id^="gpt-ad"]',
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]', 'iframe[id^="google_ads_iframe"]',
    'iframe[src*="adsterra"]', 'iframe[src*="exoclick"]', 'iframe[src*="propellerads"]',
    '.ad-banner', '.ad-container', '.ad-wrapper', '.ad-slot', '.ad-unit', '.ad-box', '.adbox', '.ads-banner',
    '.advertisement', '.advert', '.sponsored-ad', '.banner-ads', '.banner_ads', '.adsbox', '.ad_container',
    '[id*="ad-container"]', '[id*="ad_container"]', '[class*="adsbygoogle"]', '[data-ad-slot]', '[data-ad-client]',
    'a[href*="popads.net"]', 'a[href*="propellerads"]', 'a[href*="adsterra"]', 'a[href*="exoclick"]',
    '.taboola', '#taboola-below-article', '[id^="taboola-"]', '[id^="outbrain"]', '.OUTBRAIN', '.mgid', '[id^="mgid"]'
  ].join(',') + '{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important}';
  const addCss = () => {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) addCss();
  else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); addCss(); } }).observe(document, { childList: true });

  /* 3) hapus overlay transparan layar penuh (penangkap klik untuk pop-up/pop-under) */
  const suspicious = (el) => {
    if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement || el.tagName === 'IFRAME') return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.8 || r.height < innerHeight * 0.8) return false;
    if ((el.innerText || '').trim().length > 0) return false;
    if (el.querySelector('img,video,canvas,input,button,svg,picture,iframe')) return false;
    const bg = cs.backgroundColor;
    const clear = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || parseFloat(cs.opacity) < 0.05;
    return clear && (parseInt(cs.zIndex, 10) || 0) > 100;
  };
  const sweep = () => {
    if (!document.body) return;
    for (const el of document.body.children) if (suspicious(el)) el.remove();
  };
  let t = 0;
  const later = () => { clearTimeout(t); t = setTimeout(sweep, 300); };
  const arm = () => {
    if (!document.body) return false;
    new MutationObserver(later).observe(document.body, { childList: true });
    [1000, 3000, 6000, 12000].forEach((ms) => setTimeout(sweep, ms));
    return true;
  };
  if (!arm()) document.addEventListener('DOMContentLoaded', arm, { once: true });
})();
