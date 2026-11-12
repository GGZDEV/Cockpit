// World Monitor's public-data fetches omit cookies. Keep the outer Cockpit
// session on same-origin requests only, never send it to third-party sources.
(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
      if (url.origin === window.location.origin) return original(input, { ...init, credentials: 'same-origin' });
    } catch { /* native fetch reports malformed requests */ }
    return original(input, init);
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('link[rel="manifest"]').forEach(link => link.setAttribute('crossorigin', 'use-credentials'));
  }, { once: true });
})();
