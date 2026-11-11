'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createProjects } = require('./projects.cjs');
const { createRss } = require('./rss.cjs');
const webSession = require('./web-session.cjs');
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
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
let sharedProjects;
let sharedRss;
const rssService = () => sharedRss ||= createRss({ log: message => console.error(message) });
const projectsService = () => sharedProjects ||= createProjects({ discover: SERVER_MODE ? async () => null : discoverFeedMe, log: message => console.error(message) });
const secretFile = name => {
  const file = process.env[name];
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (error) { throw new Error(name + ' est illisible : ' + error.message); }
};
// Ancien emplacement (data/ du clone) : copié une fois dans le dossier d'état, sans être supprimé ni lu ailleurs.
async function migrateHaSession(file, legacy) {
  if (!legacy) return;
  try { await fs.promises.access(file); return; } catch {}
  let saved; try { saved = await fs.promises.readFile(legacy); } catch { return; }
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file, saved, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
}
// Connexion Home Assistant mémorisée par ce serveur : un seul jeton pour tous les appareils et toutes les republications
// (en mode serveur, le site entier est protégé par le mot de passe ; sinon il n'écoute que sur ce PC).
async function haSession(req, res, file, legacy) {
  if (req.method !== 'DELETE') await migrateHaSession(file, legacy);
  if (req.method === 'GET') {
    try { const saved = JSON.parse(await fs.promises.readFile(file, 'utf8')); return json(res, 200, { url: String(saved.url || ''), token: String(saved.token || '') }); }
    catch { return json(res, 200, { url: '', token: '' }); }
  }
  // Déconnecter efface aussi l'ancien emplacement, sinon la migration le ferait revenir.
  if (req.method === 'DELETE') { await Promise.all([file, legacy].filter(Boolean).map(f => fs.promises.rm(f, { force: true }))); return json(res, 200, { ok: true }); }
  if (req.method !== 'PUT') return json(res, 405, { error: 'Méthode indisponible.' });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) return json(res, 413, { error: 'Requête trop longue.' }); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'Requête invalide.' }); }
  let url; try { url = new URL(String(body?.url || '')); } catch { return json(res, 400, { error: 'Adresse Home Assistant invalide.' }); }
  const token = String(body?.token || '');
  if (!/^https?:$/.test(url.protocol) || !/^[\w.-]{20,4000}$/.test(token)) return json(res, 400, { error: 'Adresse ou jeton Home Assistant invalide.' });
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file + '.tmp', JSON.stringify({ url: url.origin, token }), { mode: 0o600 });
  await fs.promises.chmod(file + '.tmp', 0o600); await fs.promises.rename(file + '.tmp', file);
  return json(res, 200, { ok: true });
}
const PWA_PUBLIC = new Set(['/manifest.json', '/brand/apple-touch-icon.png', '/brand/icon-192.png', '/brand/icon-512.png']);
// Navigation de page (Sec-Fetch-Mode, ou Accept HTML des navigateurs qui n'envoient pas Sec-Fetch-*).
const isNavigation = req => (req.method === 'GET' || req.method === 'HEAD') && (req.headers['sec-fetch-mode'] ? req.headers['sec-fetch-mode'] === 'navigate' : /text\/html/.test(req.headers.accept || ''));
const fromBrowser = req => Object.keys(req.headers).some(name => name.startsWith('sec-fetch-'));
const redirect = (res, location, cookie) => { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(); };
// Mot de passe web : cookie de session pour les navigateurs, Basic toujours accepté (curl, scripts, appareils déjà configurés).
function authorize(req, res, session, secure) {
  const ip = webSession.clientAddress(req);
  if (req.headers.authorization) {
    if (session.checkBasic(req.headers.authorization) && !session.basicLimiter.blocked(ip)) {
      session.basicLimiter.succeed(ip);
      if (isNavigation(req)) res.setHeader('Set-Cookie', session.issue(secure)); // migration transparente vers le cookie
      return true;
    }
    session.basicLimiter.fail(ip);
  }
  if (/(?:^|;)\s*cockpit_session=/.test(req.headers.cookie || '')) {
    const state = session.verify(req.headers.cookie);
    if (state.ok) { if (state.renew) res.setHeader('Set-Cookie', session.issue(secure)); return true; }
  }
  // Pas de WWW-Authenticate pour un navigateur : la fenêtre native ne se mémorise pas sur téléphone.
  if (isNavigation(req)) { res.writeHead(401, webSession.PAGE_HEADERS); res.end(req.method === 'HEAD' ? undefined : webSession.loginPage({ next: req.url })); }
  else if (fromBrowser(req)) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cockpit-Login': '1' }); res.end(JSON.stringify({ error: 'Connexion requise.' })); }
  else { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cockpit", charset="UTF-8"', 'Cache-Control': 'no-store' }); res.end('Authentification requise.'); }
  return false;
}
async function account(req, res, url, session, secure, origin) {
  if (req.method !== 'POST') return redirect(res, '/');
  if (!trusted(req, false, origin)) return json(res, 403, { error: 'Hôte ou origine refusé.' });
  if (url.pathname === '/logout') return redirect(res, '/', session.clear(secure));
  const page = (status, error, next) => { res.writeHead(status, webSession.PAGE_HEADERS); res.end(webSession.loginPage({ next, error })); };
  if (!/^application\/x-www-form-urlencoded\b/.test(req.headers['content-type'] || '')) return page(415, 'Formulaire invalide.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) return page(413, 'Formulaire trop long.'); chunks.push(chunk); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8')), next = webSession.safeNext(form.get('next')), ip = webSession.clientAddress(req);
  if (session.limiter.blocked(ip)) return page(429, 'Trop de tentatives. Réessayez dans quelques minutes.', next);
  if (!session.checkPassword(form.get('password') || '')) { session.limiter.fail(ip); return page(401, 'Mot de passe incorrect.', next); }
  session.limiter.succeed(ip);
  return redirect(res, next, session.issue(secure));
}
function createServer({ projects, rss, serverMode = SERVER_MODE, allowedHosts = splitHosts(process.env.COCKPIT_ALLOWED_HOSTS), webPassword = process.env.COCKPIT_WEB_PASSWORD || secretFile('COCKPIT_WEB_PASSWORD_FILE'), stateDir = webSession.defaultStateDir(), haSessionFile, legacyHaSessionFile } = {}) {
  if (serverMode && !webPassword) throw new Error('COCKPIT_WEB_PASSWORD_FILE est obligatoire en mode serveur.');
  // Jeton HA et secret de session dans le dossier d'état (hors du clone, qui est remplacé à chaque déploiement).
  if (!haSessionFile) { haSessionFile = path.join(stateDir, 'ha-session.json'); legacyHaSessionFile ??= path.join(__dirname, 'data', 'ha-session.json'); }
  const session = serverMode && webPassword ? webSession.createWebSession({ stateDir, password: webPassword }) : null;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const secure = serverMode && req.headers['x-forwarded-proto'] === 'https';
      // iOS fetches the manifest and home screen icons without credentials.
      if (session && !PWA_PUBLIC.has(url.pathname)) {
        if (url.pathname === '/login' || url.pathname === '/logout') return await account(req, res, url, session, secure, { serverMode, allowedHosts });
        if (!authorize(req, res, session, secure)) return;
      }
      // The extension may frame public assets; API requests must originate inside our app.
      if (!trusted(req, !url.pathname.startsWith('/api/'), { serverMode, allowedHosts })) return json(res, 403, { error: 'Hôte ou origine refusé.' });
      if (serverMode && require('./worldmonitor.cjs').matches(req)) return require('./worldmonitor.cjs').proxy(req, res, url);
      if (url.pathname === '/server-config.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end('globalThis.COCKPIT_SERVER_MODE=' + JSON.stringify(serverMode) + ';'); }
      if (url.pathname === '/api/status') return json(res, 200, { app: 'metaboard', serverMode, rss: true, feedme: serverMode ? false : !!await discoverFeedMe(), haSuggestedUrl: serverMode ? '' : 'http://192.168.1.251:8123' });
      if (url.pathname === '/api/ha-session') return await haSession(req, res, haSessionFile, legacyHaSessionFile);
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
      if (serverMode && process.env.COCKPIT_GODSEYE_PORT && require('./godseye.cjs').handles(url.pathname)) {
        if (!trusted(req, !url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(req.method), { serverMode, allowedHosts })) return json(res, 403, { error: 'Hôte ou origine refusé.' });
        return require('./godseye.cjs').proxy(req, res, url);
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
