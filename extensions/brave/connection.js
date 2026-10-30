'use strict';
globalThis.MetaBoardConnection = {
  async probe(origin, fetcher = fetch) {
    try {
      const response = await fetcher(origin + '/browser-status.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(1800) });
      if (!response.ok) return false;
      const data = await response.json();
      return data.app === 'metaboard' && data.browserPanel === 1;
    } catch { return false; }
  },
  async discover(fetcher = fetch) {
    const origins = [ 'http://localhost:3888', 'http://127.0.0.1:3888' ];
    const matches = await Promise.all(origins.map(origin => this.probe(origin, fetcher)));
    return origins.find((_, i) => matches[i]) || null;
  },
};
