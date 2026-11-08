const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const load = () => import('../public/ha-session.js');
const LOCAL = { url: 'http://ha.local:8123', token: 'local-token-aaaaaaaaaaaa' }, SERVER = { url: 'http://ha.local:8123', token: 'server-token-bbbbbbbbbbb' };
const deny = () => Object.assign(new Error('Jeton refusé : invalid'), { auth: true });
// Faux environnement : `valid` = jetons acceptés par HA, `offline` = HA injoignable.
function world({ local = null, server = null, valid = [], offline = false } = {}) {
  const log = { connected: [], probed: [], saved: [], put: [], dropped: 0, local, server };
  const check = token => { if (offline) throw new Error('Impossible de joindre Home Assistant (ws://ha.local:8123/api/websocket).'); if (!valid.includes(token)) throw deny(); };
  return { log, deps: {
    local, loadServer: async () => server,
    connect: async (url, token) => { log.connected.push(token); check(token); },
    probe: async (url, token) => { log.probed.push(token); check(token); },
    saveLocal: saved => { log.saved.push(saved.token); log.local = saved; },
    dropLocal: () => { log.dropped++; log.local = null; },
    saveServer: async saved => { log.put.push(saved.token); log.server = saved; }
  } };
}

test('a working local token is shared with an empty server', async () => {
  const { restoreHA } = await load(), { log, deps } = world({ local: LOCAL, valid: [LOCAL.token] });
  assert.deepEqual(await restoreHA(deps), { ok: true, source: 'local' });
  assert.deepEqual(log.put, [LOCAL.token]); assert.deepEqual(log.connected, [LOCAL.token]);
});

test('a refused local token falls back to the server token and adopts it', async () => {
  const { restoreHA } = await load(), { log, deps } = world({ local: LOCAL, server: SERVER, valid: [SERVER.token] });
  assert.deepEqual(await restoreHA(deps), { ok: true, source: 'server' });
  assert.deepEqual(log.connected, [LOCAL.token, SERVER.token]); assert.deepEqual(log.saved, [SERVER.token]);
  assert.deepEqual(log.put, [], 'le serveur garde son jeton, jamais remplacé par un jeton refusé');
});

test('a new device uses the server token', async () => {
  const { restoreHA } = await load(), { log, deps } = world({ server: SERVER, valid: [SERVER.token] });
  assert.deepEqual(await restoreHA(deps), { ok: true, source: 'server' });
  assert.deepEqual(log.saved, [SERVER.token]); assert.deepEqual(log.put, []);
});

test('a newer server token is taken over when it works, a revoked one is replaced', async () => {
  const { restoreHA } = await load();
  const newer = world({ local: LOCAL, server: SERVER, valid: [LOCAL.token, SERVER.token] });
  assert.equal((await restoreHA(newer.deps)).ok, true);
  assert.deepEqual(newer.log.saved, [SERVER.token]); assert.deepEqual(newer.log.put, []);
  const revoked = world({ local: LOCAL, server: SERVER, valid: [LOCAL.token] });
  assert.equal((await restoreHA(revoked.deps)).ok, true);
  assert.deepEqual(revoked.log.saved, []); assert.deepEqual(revoked.log.put, [LOCAL.token]);
});

test('Home Assistant unreachable keeps every token', async () => {
  const { restoreHA } = await load(), { log, deps } = world({ local: LOCAL, server: SERVER, offline: true });
  const result = await restoreHA(deps);
  assert.equal(result.ok, false); assert.equal(result.reason, 'network');
  assert.equal(log.dropped, 0); assert.deepEqual(log.put, []); assert.deepEqual(log.saved, []); assert.deepEqual(log.connected, [LOCAL.token]);
  const fresh = world({ server: SERVER, offline: true });
  assert.equal((await restoreHA(fresh.deps)).reason, 'network'); assert.deepEqual(fresh.log.saved, []);
  // Pendant la vérification d'un jeton serveur différent, une coupure ne remplace rien.
  const probe = world({ local: LOCAL, server: SERVER, valid: [LOCAL.token] }); probe.deps.probe = async () => { throw new Error('Connexion fermée par Home Assistant.'); };
  assert.equal((await restoreHA(probe.deps)).ok, true); assert.deepEqual(probe.log.put, []); assert.deepEqual(probe.log.saved, []);
});

test('refused everywhere: the local token is dropped, the server is left alone', async () => {
  const { restoreHA } = await load();
  const both = world({ local: LOCAL, server: SERVER });
  assert.equal((await restoreHA(both.deps)).reason, 'refused');
  assert.equal(both.log.dropped, 1); assert.deepEqual(both.log.put, []); assert.deepEqual(both.log.saved, []);
  const same = world({ local: LOCAL, server: LOCAL });
  assert.equal((await restoreHA(same.deps)).reason, 'refused'); assert.deepEqual(same.log.connected, [LOCAL.token]);
  const nothing = world({ server: null });
  assert.deepEqual(await restoreHA(nothing.deps), { ok: false, reason: 'none' });
  const broken = world({ local: LOCAL, valid: [LOCAL.token] }); broken.deps.loadServer = async () => { throw new Error('401'); };
  assert.equal((await restoreHA(broken.deps)).ok, true);
});

test('refusals are recognised by flag or message, network errors are not', async () => {
  const { refused } = await load();
  assert.equal(refused(deny()), true); assert.equal(refused(new Error('Session refusée : expired')), true);
  assert.equal(refused(Object.assign(new Error('x'), { auth: true })), true);
  assert.equal(refused(new Error('Impossible de joindre Home Assistant')), false); assert.equal(refused(null), false);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'ha.js'), 'utf8'), /auth_invalid'\)\), \{ auth: true \}/);
});

test('an API call refused for lack of session reloads the page once', async () => {
  let reloads = 0; const store = {};
  const responses = [new Response('{}', { status: 401, headers: { 'X-Cockpit-Login': '1' } }), new Response('{}', { status: 401 }), new Response('{}', { status: 401, headers: { 'X-Cockpit-Login': '1' } })];
  const window = { fetch: async () => responses.shift() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'login-guard.js'), 'utf8'), { window, location: { reload: () => reloads++ }, sessionStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, Date, Number, String });
  assert.equal((await window.fetch('/api/projects/state')).status, 401); assert.equal(reloads, 1);
  await window.fetch('/x'); assert.equal(reloads, 1, 'un 401 sans X-Cockpit-Login (HA, autre service) ne recharge pas');
  await window.fetch('/api/projects/state'); assert.equal(reloads, 1, 'pas de boucle de rechargement');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('login-guard.js') < html.indexOf('app.js') || !html.includes('app.js'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), /serverMode \? `<section class="settings-card"><h3>Accès au site<\/h3>.*action="\/logout"/);
});
