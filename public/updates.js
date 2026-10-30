(function () {
  const current = window.MB_ASSET_VERSION;
  if (!current) return;
  async function check() {
    if (document.hidden || document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || new URLSearchParams(location.search).has('code')) return;
    try {
      const response = await fetch(new URL('version.json?t=' + Date.now(), location.href), { cache: 'no-store' });
      const next = await response.json();
      if (!response.ok || !next.version || next.version === current) return;
      const url = new URL(location.href); if (url.searchParams.get('v') === next.version) return;
      url.searchParams.set('v', next.version); location.replace(url.href);
    } catch { /* Keep the dashboard working while offline. */ }
  }
  setInterval(check, 120000); document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); }); check();
})();
