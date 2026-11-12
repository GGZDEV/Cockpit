'use strict';
const http = require('node:http');

// Self-hosted full apps, each on its own hostname (see deploy/<app>/README.md).
const APPS = [
  { name: 'World Monitor', host: 'COCKPIT_WORLDMONITOR_HOST', upstream: 'COCKPIT_WORLDMONITOR_UPSTREAM' },
  { name: 'OpenRadio', host: 'COCKPIT_OPENRADIO_HOST', upstream: 'COCKPIT_OPENRADIO_UPSTREAM' },
];

function matches(req) {
  const hostname = new URL('http://' + req.headers.host).hostname;
  const app = APPS.find(a => process.env[a.host] && process.env[a.host] === hostname);
  return app ? { name: app.name, upstream: process.env[app.upstream] } : null;
}

// Called only after Cockpit authentication and Host/Origin admission.
// A separate hostname keeps the full app's root-relative assets/API isolated
// from Cockpit and God's Eye. The destination is operator-owned, never a URL
// supplied in an incoming request.
function proxy(req, res, url, { name, upstream }) {
  const destination = new URL(upstream);
  if (destination.protocol !== 'http:') throw new Error(name + ' upstream must be local HTTP.');
  const headers = { ...req.headers };
  delete headers.authorization; delete headers.connection; delete headers['proxy-authorization'];
  delete headers['x-forwarded-for']; delete headers['x-real-ip'];
  headers['x-forwarded-for'] = req.socket.remoteAddress;
  if (headers.cookie) {
    headers.cookie = headers.cookie.split(';').filter(v => !/^\s*cockpit_session=/.test(v)).join(';');
    if (!headers.cookie) delete headers.cookie;
  }
  const request = http.request({ hostname: destination.hostname, port: destination.port || 80, path: url.pathname + url.search, method: req.method, headers }, response => {
    const output = { ...response.headers };
    delete output.connection; delete output['transfer-encoding']; delete output['x-frame-options'];
    const ancestors = "frame-ancestors 'self' https://cockpit.ggz.ovh";
    const csp = output['content-security-policy'] || "default-src 'self'; connect-src 'self' https: wss: blob:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' https: blob:;";
    output['content-security-policy'] = /frame-ancestors\s+[^;]+/i.test(csp) ? csp.replace(/frame-ancestors\s+[^;]+/i, ancestors) : csp + '; ' + ancestors;
    if (output['set-cookie']) output['set-cookie'] = output['set-cookie'].filter(v => !/^cockpit_session=/i.test(v));
    res.writeHead(response.statusCode, output);
    response.on('error', () => res.destroy()); response.pipe(res);
  });
  request.setTimeout(120000, () => request.destroy());
  request.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: name + ' est momentanément indisponible.' }));
  });
  res.on('close', () => request.destroy()); req.pipe(request);
}
module.exports = { matches, proxy };
