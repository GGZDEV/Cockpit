const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createServer } = require('../server');
const { createWebSession, safeNext, loginPage } = require('../web-session.cjs');

const tempDir = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-session-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function start(t, options) {
  const server = createServer({ serverMode: true, allowedHosts: ['127.0.0.1', 'cockpit.example'], webPassword: 'secret', projects: { allowedRoute: () => true, handle: (req, res, url, json) => json(res, 200, { ok: true }) }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
// Requête brute : fetch() ajoute ses propres en-têtes Sec-Fetch-* et suit les redirections.
const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); });
  req.on('error', reject); req.end(body);
});
const NAV = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' };
const API = { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' };
const cookieOf = response => String(response.headers['set-cookie']?.[0] || '').split(';')[0];
const login = (origin, password, next = '/', headers = {}) => request(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...headers }, body: new URLSearchParams({ username: 'cockpit', password, next }).toString() });

test('unauthenticated requests: login page for navigation, JSON for the app, Basic challenge for scripts', async t => {
  const origin = await start(t, { stateDir: tempDir(t) });
  const page = await request(origin + '/?v=2', { headers: NAV });
  assert.equal(page.status, 401); assert.equal(page.headers['www-authenticate'], undefined);
  assert.match(page.body, /autocomplete="current-password"/); assert.match(page.body, /value="cockpit" autocomplete="username"/);
  assert.match(page.body, /name="next" value="\/\?v=2"/); assert.doesNotMatch(page.body, /https?:\/\//);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  const api = await request(origin + '/api/projects/state', { headers: API });
  assert.equal(api.status, 401); assert.equal(api.headers['www-authenticate'], undefined); assert.equal(api.headers['x-cockpit-login'], '1');
  assert.deepEqual(JSON.parse(api.body), { error: 'Connexion requise.' });
  const script = await request(origin + '/');
  assert.equal(script.status, 401); assert.match(script.headers['www-authenticate'], /^Basic /);
  assert.equal((await request(origin + '/manifest.json', { headers: NAV })).status, 200);
});

test('login issues a signed cookie that survives a restart and slides forward', async t => {
  const stateDir = tempDir(t);
  const origin = await start(t, { stateDir });
  const wrong = await login(origin, 'nope', '/projets');
  assert.equal(wrong.status, 401); assert.match(wrong.body, /Mot de passe incorrect/); assert.equal(wrong.headers['set-cookie'], undefined);
  const ok = await login(origin, 'secret', '/?page=projects', { 'X-Forwarded-Proto': 'http' });
  assert.equal(ok.status, 303); assert.equal(ok.headers.location, '/?page=projects');
  const raw = ok.headers['set-cookie'][0];
  assert.match(raw, /^cockpit_session=v1\./); assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Lax/); assert.match(raw, /Path=\//); assert.match(raw, /Max-Age=34560000/);
  assert.doesNotMatch(raw, /Secure/);
  const cookie = cookieOf(ok);
  const page = await request(origin + '/', { headers: { ...NAV, Cookie: cookie } });
  assert.equal(page.status, 200); assert.match(page.body, /server-config\.js/); assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await request(origin + '/api/projects/state', { headers: { ...API, Cookie: cookie } })).status, 200);
  // Secret créé une fois, privé, dans le dossier d'état.
  const secret = path.join(stateDir, 'session-secret'), bytes = fs.readFileSync(secret);
  assert.equal(bytes.length, 32);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(secret).mode & 0o777, 0o600); assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700); }
  // « Redémarrage » : nouveau serveur, même dossier d'état → le cookie reste valable et le secret n'est pas régénéré.
  const restarted = await start(t, { stateDir });
  assert.equal((await request(restarted + '/', { headers: { ...NAV, Cookie: cookie } })).status, 200);
  assert.deepEqual(fs.readFileSync(secret), bytes);
  // Changer le mot de passe invalide les sessions.
  const changed = await start(t, { stateDir, webPassword: 'other' });
  assert.equal((await request(changed + '/', { headers: { ...NAV, Cookie: cookie } })).status, 401);
  // HTTPS derrière le proxy : cookie Secure.
  const secure = await login(origin, 'secret', '/', { Host: 'cockpit.example', Origin: 'https://cockpit.example', 'X-Forwarded-Proto': 'https' });
  assert.equal(secure.status, 303); assert.match(secure.headers['set-cookie'][0], /; Secure/);
});

test('cookies are signed, expire and are renewed after a day', () => {
  let clock = Date.UTC(2026, 10, 8);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-session-'));
  try {
    const session = createWebSession({ stateDir, password: 'secret', now: () => clock });
    const cookie = session.issue(false).split(';')[0];
    assert.deepEqual(session.verify(cookie), { ok: true, renew: false });
    const [name, value] = cookie.split('='), parts = value.split('.');
    const tampered = [parts[0], parts[1], (parseInt(parts[2], 36) + 1000).toString(36), parts[3]].join('.');
    assert.equal(session.verify(name + '=' + tampered).ok, false);
    assert.equal(session.verify(cookie.slice(0, -2) + (cookie.endsWith('A') ? 'BB' : 'AA')).ok, false);
    assert.equal(session.verify('cockpit_session=v1.x.y.z').ok, false);
    assert.equal(session.verify('other=1').ok, false);
    assert.equal(createWebSession({ stateDir, password: 'changed', now: () => clock }).verify(cookie).ok, false);
    clock += 2 * 86400000; assert.deepEqual(session.verify('a=b; ' + cookie), { ok: true, renew: true });
    clock += 400 * 86400000; assert.equal(session.verify(cookie).ok, false);
    assert.match(session.clear(true), /^cockpit_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('an old cookie is renewed by the server and Basic navigation migrates to a cookie', async t => {
  const stateDir = tempDir(t), origin = await start(t, { stateDir });
  const old = createWebSession({ stateDir, password: 'secret', now: () => Date.now() - 3 * 86400000 }).issue(false).split(';')[0];
  const renewed = await request(origin + '/', { headers: { ...NAV, Cookie: old } });
  assert.equal(renewed.status, 200); assert.match(renewed.headers['set-cookie'][0], /^cockpit_session=v1\./); assert.notEqual(cookieOf(renewed), old);
  const basic = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64') };
  const migrated = await request(origin + '/', { headers: { ...NAV, ...basic } });
  assert.equal(migrated.status, 200); assert.match(migrated.headers['set-cookie'][0], /^cockpit_session=/);
  const scripted = await request(origin + '/api/status', { headers: basic });
  assert.equal(scripted.status, 200); assert.equal(scripted.headers['set-cookie'], undefined);
});

test('logout clears the cookie; login and logout refuse foreign origins', async t => {
  const origin = await start(t, { stateDir: tempDir(t) });
  assert.equal((await login(origin, 'secret', '/', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(origin, 'secret', '/', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request(origin + '/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  const out = await request(origin + '/logout', { method: 'POST', headers: { Origin: origin } });
  assert.equal(out.status, 303); assert.equal(out.headers.location, '/'); assert.match(out.headers['set-cookie'][0], /^cockpit_session=; .*Max-Age=0/);
  assert.equal((await request(origin + '/login')).status, 303);
  assert.equal((await request(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
});

test('redirect after login stays on this site', async t => {
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', '/login', '/logout?x', '']) assert.equal(safeNext(next), '/', next);
  for (const next of ['/', '/?page=projects', '/projets/a?b=c#d']) assert.equal(safeNext(next), next);
  assert.doesNotMatch(loginPage({ next: '"><script>alert(1)</script>', error: '<b>x</b>' }), /<script>|<b>/);
  const origin = await start(t, { stateDir: tempDir(t) });
  assert.equal((await login(origin, 'secret', '//evil.example/x')).headers.location, '/');
});

test('repeated failures are limited per address, without blocking valid cookies', async t => {
  const origin = await start(t, { stateDir: tempDir(t) });
  const ok = cookieOf(await login(origin, 'secret'));
  for (let i = 0; i < 8; i++) assert.equal((await login(origin, 'wrong' + i)).status, 401);
  const blocked = await login(origin, 'secret');
  assert.equal(blocked.status, 429); assert.match(blocked.body, /Trop de tentatives/); assert.equal(blocked.headers['set-cookie'], undefined);
  assert.equal((await login(origin, 'secret', '/', { 'X-Forwarded-For': '203.0.113.9' })).status, 303);
  assert.equal((await request(origin + '/', { headers: { ...NAV, Cookie: ok } })).status, 200);
});

test('the Home Assistant session moves to the state directory without losing the old file', async t => {
  const stateDir = tempDir(t), legacyDir = tempDir(t), legacy = path.join(legacyDir, 'ha-session.json');
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ4In0.migrated_token-123';
  fs.writeFileSync(legacy, JSON.stringify({ url: 'http://ha.local:8123', token }), { mode: 0o600 });
  const origin = await start(t, { stateDir: path.join(stateDir, 'state'), legacyHaSessionFile: legacy });
  const headers = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64'), 'Content-Type': 'application/json' };
  assert.deepEqual(await (await fetch(origin + '/api/ha-session', { headers })).json(), { url: 'http://ha.local:8123', token });
  const file = path.join(stateDir, 'state', 'ha-session.json');
  assert.ok(fs.existsSync(legacy)); assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700); }
  const next = token.replace('migrated', 'replaced');
  assert.equal((await fetch(origin + '/api/ha-session', { method: 'PUT', headers, body: JSON.stringify({ url: 'http://ha.local:8123', token: next }) })).status, 200);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Un nouveau serveur relit le dossier d'état, pas l'ancien fichier.
  const restarted = await start(t, { stateDir: path.join(stateDir, 'state'), legacyHaSessionFile: legacy });
  assert.equal((await (await fetch(restarted + '/api/ha-session', { headers })).json()).token, next);
  await fetch(restarted + '/api/ha-session', { method: 'DELETE', headers });
  assert.deepEqual(await (await fetch(restarted + '/api/ha-session', { headers })).json(), { url: '', token: '' });
  assert.equal(fs.existsSync(legacy), false);
});
