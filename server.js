'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createProjects } = require('./projects.cjs');
const { createRss } = require('./rss.cjs');
const SERVER_MODE = process.env.COCKPIT_SERVER_MODE === '1';
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png':'image/png', '.woff2':'font/woff2' };
const READS = new Set(['/api/articles', '/api/feeds', '/api/categories', '/api/boards', '/api/todos', '/api/calendar', '/api/system/metrics', '/api/spotify/now-playing', '/api/spotify/status', '/api/agents/', '/api/ai-usage']);
const ROUTES = {
 GET:[/^\/api\/(feed-suggestions|feedly\/status|spotify\/(status|now-playing|devices|saved|history|lyrics)|weather(?:\/search)?|ai\/(status|clusters)|ai-usage(?:\/config)?|agents\/(?:events|inbox|connections\/[^/]+\/(?:agents|contacts\/[^/]+)|conversations\/[^/]+(?:\/models)?))$/],
 POST:[/^\/api\/(?:feeds(?:\/opml)?|feedly\/(?:connect|sync)|articles\/refresh|categories|boards(?:\/[^/]+\/items)?|todos|calendar\/(?:events|subscriptions)|spotify\/(?:authorize|seek|volume|transfer|saved|command\/(?:play|pause|next|previous))|ai\/(?:config|compat\/probe|cache\/clear|summaries)|ai-usage\/(?:config|discover)|agents\/(?:connections|connections\/[^/]+\/(?:test|contacts\/[^/]+\/(?:profile|read))|conversations|conversations\/[^/]+\/(?:messages|read)|threads\/open|inbox\/(?:sync|read-all|[^/]+\/read)))$/],
 PATCH:[/^\/api\/(?:feeds|categories\/[^/]+|todos\/[^/]+|boards\/[^/]+\/items\/[^/]+)$/],
 DELETE:[/^\/api\/(?:feeds|feedly|spotify|ai|categories\/[^/]+|boards\/[^/]+(?:\/items\/[^/]+)?|todos(?:\/[^/]+)?|calendar\/(?:events|subscriptions)\/[^/]+|agents\/(?:connections|conversations)\/[^/]+)$/]
};
function allowed(method, pathname) {
  return method === 'GET' && READS.has(pathname) || !!ROUTES[method]?.some(pattern=>pattern.test(pathname));
}

const splitHosts = value => String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
function trusted(req, publicFile = false, { serverMode = SERVER_MODE, allowedHosts = splitHosts(process.env.COCKPIT_ALLOWED_HOSTS) } = {}) {
  try {
    const host = new URL('http://' + req.headers.host);
    const hostname = host.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const hostAllowed = ['localhost', '127.0.0.1', '::1'].includes(hostname) || (serverMode && (allowedHosts.includes('*') || allowedHosts.includes(hostname)));
    // TLS terminates at the reverse proxy; retain the exact Host/Origin match.
    const protocol = serverMode && req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    const expectedOrigin = new URL(protocol + '//' + req.headers.host).origin;
    return hostAllowed &&
      (publicFile || (!req.headers.origin || req.headers.origin === expectedOrigin) && req.headers['sec-fetch-site'] !== 'cross-site');
  } catch { return false; }
}
let cachedOrigin = null, discoveredAt = 0, discovery;
async function discoverFeedMe() {
  if (Date.now() - discoveredAt < (cachedOrigin ? 10000 : 1000)) return cachedOrigin;
  if (discovery) return discovery;
  discovery = (async () => {
    const origins = Array.from({ length: 6 }, (_, i) => `http://127.0.0.1:${3777 + i}`);
    const matches = await Promise.all(origins.map(async origin => {
      try {
        const r = await fetch(origin + '/api/browser/status', { signal: AbortSignal.timeout(1500), redirect: 'error' });
        const j = await r.json(); return r.ok && j.app === 'feedme' && j.browserPanel === 1;
      } catch { return false; }
    }));
    cachedOrigin = origins.find((_, i) => matches[i]) || null; discoveredAt = Date.now(); return cachedOrigin;
  })();
  try { return await discovery; } finally { discovery = null; }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
let sharedProjects;
let sharedRss;
const rssService = () => sharedRss ||= createRss({ log: message => console.error(message) });
const projectsService = () => sharedProjects ||= createProjects({ discover: SERVER_MODE ? async () => null : discoverFeedMe, log: message => console.error(message) });
const secretFile = name => {
  const file = process.env[name];
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (error) { throw new Error(name + ' est illisible : ' + error.message); }
};
function cryptoSafe(a, b) {
  const crypto = require('node:crypto'), left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function createServer({ projects, rss, serverMode = SERVER_MODE, allowedHosts = splitHosts(process.env.COCKPIT_ALLOWED_HOSTS), webPassword = process.env.COCKPIT_WEB_PASSWORD || secretFile('COCKPIT_WEB_PASSWORD_FILE') } = {}) {
  if (serverMode && !webPassword) throw new Error('COCKPIT_WEB_PASSWORD_FILE est obligatoire en mode serveur.');
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (serverMode && webPassword) {
        const expected = 'Basic ' + Buffer.from('cockpit:' + webPassword).toString('base64');
        const supplied = String(req.headers.authorization || '');
        if (!cryptoSafe(supplied, expected)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cockpit", charset="UTF-8"', 'Cache-Control': 'no-store' }); return res.end('Authentification requise.'); }
      }
      // The extension may frame public assets; API requests must originate inside our app.
      if (!trusted(req, !url.pathname.startsWith('/api/'), { serverMode, allowedHosts })) return json(res, 403, { error: 'Hôte ou origine refusé.' });
      if (url.pathname === '/server-config.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end('globalThis.COCKPIT_SERVER_MODE=' + JSON.stringify(serverMode) + ';'); }
      if (url.pathname === '/api/status') return json(res, 200, { app: 'metaboard', serverMode, rss: true, feedme: serverMode ? false : !!await discoverFeedMe(), haSuggestedUrl: serverMode ? '' : 'http://192.168.1.251:8123' });
      if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
        const service = projects || projectsService();
        if (!service.allowedRoute(req.method, url.pathname)) return json(res, 405, { error: 'Opération indisponible.' });
        return service.handle(req, res, url, json);
      }
      if (url.pathname.startsWith('/api/feedme/')) {
        const targetPath = '/api/' + url.pathname.slice('/api/feedme/'.length);
        if (!allowed(req.method, targetPath)) return json(res, 405, { error: 'Cette opération ne fait pas partie du prototype.' });
        // La veille est servie par Cockpit lui-même : elle ne dépend plus de l'application PC.
        const feeds = rss || rssService();
        if (feeds.handles(req.method, targetPath)) return feeds.handle(req, res, targetPath, json);
        const origin = await discoverFeedMe();
        if (!origin) return json(res, 503, { error: 'Ouvrez Cockpit sur ce PC pour accéder à ses données.' });
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), targetPath.endsWith('/messages') || targetPath === '/api/agents/events' ? 900000 : 60000);
        res.on('close', () => { clearTimeout(timer); abort.abort(); });
        let body;
        if (['POST','PATCH','DELETE'].includes(req.method)) {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > (targetPath.endsWith('/messages') ? 36 * 1024 * 1024 : targetPath === '/api/feeds/opml' ? 5 * 1024 * 1024 : 1024 * 1024)) return json(res, 413, { error: 'Message trop long.' }); chunks.push(chunk); }
          body = Buffer.concat(chunks);
        }
        try {
          const upstream = await fetch(origin + targetPath + url.search, { method: req.method, body, headers: body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {}, signal: abort.signal, redirect: 'error' });
          res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          if (!upstream.body) return res.end();
          res.flushHeaders();
          const stream = Readable.fromWeb(upstream.body);
          stream.on('error', () => res.destroy()); stream.pipe(res);
        } catch (e) { if (!res.headersSent) json(res, 502, { error: e.name === 'AbortError' ? 'Cockpit ne répond pas à temps.' : 'Connexion à Cockpit interrompue.' }); else res.end(); }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Méthode indisponible.' });
      let name;
      try { name = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'Adresse invalide.' }); }
      const file = path.resolve(ROOT, '.' + (name === '/' ? '/index.html' : name));
      const relative = path.relative(ROOT, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return json(res, 403, { error: 'Accès refusé.' });
      if (!TYPES[path.extname(file)]) return json(res, 404, { error: 'Fichier introuvable.' });
      try {
        const data = await fs.promises.readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch { json(res, 404, { error: 'Fichier introuvable.' }); }
    } catch { if (!res.headersSent) json(res, 500, { error: 'Une erreur est survenue.' }); else res.end(); }
  });
}
if (require.main === module) {
  const server = createServer();
  projectsService(); // relit l'état des exécutions dès le démarrage
  const port = Number(process.env.PORT || 3888), host = process.env.HOST || (SERVER_MODE ? '0.0.0.0' : '127.0.0.1');
  server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Le port ${port} est occupé. Utilisez PORT pour en choisir un autre.` : err.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Cockpit prêt : http://${host}:${port}`));
  if (SERVER_MODE) return;
  const config=require('./scripts/relay-runtime').writeRuntime();
  if (config.pcOrigin) { const relay=require('./relay.cjs').createRelay({haOrigin:config.haOrigin,localOrigin:'http://127.0.0.1:'+port,allowed,projectsAllowed:(method,pathname)=>projectsService().allowedRoute(method,pathname)}); relay.on('error',error=>console.error('Relais tablette : '+error.message));relay.listen(3889,new URL(config.pcOrigin).hostname,()=>console.log('Relais tablette authentifié : '+config.pcOrigin)); }
  // Accès des agents à Projets : ce PC et Tailscale uniquement, une clé par agent.
  const access = require('./agent-access.cjs');
  for (const host of ['127.0.0.1', access.tailscaleAddress()].filter(Boolean)) {
    const agentServer = access.createAgentAccess({ projects: projectsService() });
    agentServer.on('error', error => console.error('Accès agents (' + host + ') : ' + error.message));
    agentServer.listen(access.PORT, host, () => console.log('Accès agents à Projets : http://' + host + ':' + access.PORT + '/agent/v1/'));
  }
}
module.exports = { createServer, allowed, trusted, discoverFeedMe };
