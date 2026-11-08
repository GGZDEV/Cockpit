const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createServer } = require('../server');
const { createDeployerClient } = require('../deployer-client.cjs');

test('server mode protects the single-origin web app and advertises only server mode', async t => {
  assert.throws(() => createServer({ serverMode: true, webPassword: '' }), /obligatoire/);
  const projects = { allowedRoute: () => true, handle: (req, res, url, json) => json(res, 200, { ok: true }) };
  const server = createServer({ serverMode: true, allowedHosts: ['127.0.0.1'], webPassword: 'secret', projects, stateDir: path.join(os.tmpdir(), 'cockpit-test-state-' + process.pid) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin)).status, 401);
  for (const file of ['/manifest.json', '/brand/apple-touch-icon.png', '/brand/icon-192.png']) assert.equal((await fetch(origin + file)).status, 200, file);
  assert.equal((await fetch(origin + '/brand/icon.png')).status, 401);
  const headers = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64') };
  const page = await fetch(origin, { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /server-config\.js/);
  const config = await fetch(origin + '/server-config.js', { headers }); assert.equal(await config.text(), 'globalThis.COCKPIT_SERVER_MODE=true;');
  const status = await (await fetch(origin + '/api/status', { headers })).json();
  assert.deepEqual({ serverMode: status.serverMode, feedme: status.feedme, haSuggestedUrl: status.haSuggestedUrl }, { serverMode: true, feedme: false, haSuggestedUrl: '' });
  const api = await fetch(origin + '/api/projects/state', { headers: { ...headers, Origin: 'https://other.example' } }); assert.equal(api.status, 403);
});

test('deployer token can be loaded from an external file without entering responses', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-token-')), file = path.join(dir, 'token');
  fs.writeFileSync(file, 'outside-git-token\n', { mode: 0o600 });
  const previousFile = process.env.COCKPIT_DEPLOYER_TOKEN_FILE, previousToken = process.env.COCKPIT_DEPLOYER_TOKEN;
  delete process.env.COCKPIT_DEPLOYER_TOKEN; process.env.COCKPIT_DEPLOYER_TOKEN_FILE = file;
  t.after(() => { if (previousFile === undefined) delete process.env.COCKPIT_DEPLOYER_TOKEN_FILE; else process.env.COCKPIT_DEPLOYER_TOKEN_FILE = previousFile; if (previousToken === undefined) delete process.env.COCKPIT_DEPLOYER_TOKEN; else process.env.COCKPIT_DEPLOYER_TOKEN = previousToken; fs.rmSync(dir, { recursive: true, force: true }); });
  let authorization = '';
  const client = createDeployerClient({ baseUrl: 'http://deployer.test:8080', fetchImpl: async (url, options) => { authorization = options.headers.Authorization; return new Response(JSON.stringify({ id: 'demo', repo: 'x', branch: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  assert.equal(client.configured, true); await client.getProject('demo'); assert.equal(authorization, 'Bearer outside-git-token');
  assert.doesNotMatch(JSON.stringify(client.describe()), /outside-git-token/);
});

test('HTTPS proxy accepts same-origin writes but refuses foreign origins and hosts', async t => {
  const projects = { allowedRoute: () => true, handle: (req, res, url, json) => json(res, 200, { ok: true }) };
  const server = createServer({ serverMode: true, allowedHosts: ['cockpit.ggz.ovh'], webPassword: 'secret', projects, stateDir: path.join(os.tmpdir(), 'cockpit-test-state-' + process.pid) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/projects/projects';
  const headers = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64'), Host: 'cockpit.ggz.ovh', Origin: 'https://cockpit.ggz.ovh', 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin' };
  const request = overrides => new Promise((resolve, reject) => {
    const req = require('node:http').request(url, { method: 'POST', headers: { ...headers, ...overrides } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal((await request({})).status, 200);
  assert.equal((await request({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ Host: 'evil.example', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request({ 'X-Forwarded-Proto': 'http' })).status, 403);
});

test('Home Assistant session is remembered by the server behind the site password', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ha-')), file = path.join(dir, 'data', 'ha-session.json');
  const server = createServer({ serverMode: true, allowedHosts: ['127.0.0.1'], webPassword: 'secret', projects: { allowedRoute: () => false }, haSessionFile: file });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); fs.rmSync(dir, { recursive: true, force: true }); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/ha-session', headers = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64'), 'Content-Type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await fetch(url, { headers })).json(), { url: '', token: '' });
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ url: 'javascript:alert(1)', token: 'x'.repeat(30) }) })).status, 400);
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ4In0.abc_DEF-123';
  assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ url: 'https://ha.example:8123/lovelace', token }) })).status, 200);
  assert.deepEqual(await (await fetch(url, { headers })).json(), { url: 'https://ha.example:8123', token });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await fetch(url, { method: 'DELETE', headers });
  assert.deepEqual(await (await fetch(url, { headers })).json(), { url: '', token: '' });
});
