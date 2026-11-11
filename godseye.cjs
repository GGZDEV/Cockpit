'use strict';
const http = require('node:http');

// Upstream uses root-relative API/public URLs. Keep Cockpit's routes first;
// only these additional asset namespaces and the remaining /api routes belong
// to the globe. No arbitrary destination or filesystem path is accepted.
function handles(pathname) {
  return pathname === '/godseye-app.html' || pathname.startsWith('/api/') ||
    /^\/(assets|cesium|models|events|icons)\//.test(pathname) ||
    ['/logo.svg', '/location.svg', '/mic.svg', '/pin.svg', '/visual-presets.svg', '/manifest.webmanifest', '/quebec-cameras.json'].includes(pathname);
}
function proxy(req, res, url, { port = Number(process.env.COCKPIT_GODSEYE_PORT || 4173) } = {}) {
  const setup = ['/api/setup/status', '/api/setup/keys'].includes(url.pathname);
  const headers = { host: req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http', 'x-forwarded-for': req.socket.remoteAddress };
  for (const key of ['origin', 'content-type', 'accept', 'range', 'if-none-match', 'if-modified-since']) if (req.headers[key]) headers[key] = req.headers[key];
  // Cockpit authenticated and checked the original Host/Origin before this hop.
  if (setup) {
    headers.host = '127.0.0.1:' + port;
    delete headers['x-forwarded-proto']; delete headers['x-forwarded-for'];
    if (req.headers.origin) headers.origin = 'http://' + headers.host;
  }
  const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method,
    path: (url.pathname === '/godseye-app.html' ? '/' : url.pathname) + url.search, headers }, response => {
    const output = { ...response.headers };
    // Credentials and upstream cookies must never cross the service boundary.
    delete output['set-cookie']; delete output.connection; delete output['transfer-encoding'];
    // Only the app document may be framed, and only by this same origin.
    // Upstream's ?embed=1 hides its controls; keep the full original UI here.
    if (url.pathname === '/godseye-app.html') {
      output['x-frame-options'] = 'SAMEORIGIN';
      if (typeof output['content-security-policy'] === 'string') output['content-security-policy'] = output['content-security-policy'].replace(/frame-ancestors\s+[^;]+/i, "frame-ancestors 'self'");
    }
    res.writeHead(response.statusCode, output);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'God’s Eye View est momentanément indisponible.' }));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
module.exports = { handles, proxy };
