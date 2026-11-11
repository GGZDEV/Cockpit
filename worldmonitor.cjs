'use strict';
const http = require('node:http');

function matches(req) {
  const host = process.env.COCKPIT_WORLDMONITOR_HOST;
  return !!host && new URL('http://' + req.headers.host).hostname === host;
}

// Called only after Cockpit authentication and Host/Origin admission.
// A separate hostname keeps the full app's root-relative assets/API isolated
// from Cockpit and God's Eye. The destination is operator-owned, never a URL
// supplied in an incoming request.
function proxy(req, res, url, { upstream = process.env.COCKPIT_WORLDMONITOR_UPSTREAM } = {}) {
  const destination = new URL(upstream);
  if (destination.protocol !== 'http:') throw new Error('World Monitor upstream must be local HTTP.');
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
    res.end(JSON.stringify({ error: 'World Monitor est momentanément indisponible.' }));
  });
  res.on('close', () => request.destroy()); req.pipe(request);
}
module.exports = { matches, proxy };
