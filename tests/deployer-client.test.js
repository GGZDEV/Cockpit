const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeployerClient, DeployerError } = require('../deployer-client.cjs');
const { fakeDeployer, TOKEN } = require('./helpers/fake-deployer.js');

async function make(t, options = {}, serviceOptions) {
  const service = await fakeDeployer(serviceOptions); t.after(() => service.close());
  return { service, client: createDeployerClient({ baseUrl: service.url, token: TOKEN, ...options }) };
}
const fails = async (promise, code) => { try { await promise; } catch (error) { assert.ok(error instanceof DeployerError, String(error)); assert.equal(error.code, code, error.message); return error; } assert.fail('devait échouer (' + code + ')'); };
const body = { repo: 'ggzdev/site', branch: 'main', type: 'ha-static', deploy: { src_dir: 'dist', ha_subdir: 'a/b' }, auto: false };

test('without a token the client is not configured, says so in French and never calls the network', async t => {
  const { service, client } = await make(t, { token: '' });
  assert.equal(client.configured, false); assert.match(client.reason, /COCKPIT_DEPLOYER_TOKEN/);
  await fails(client.putProject('site', body), 'not_configured');
  assert.equal(service.state.calls.length, 0);
  assert.deepEqual(Object.keys(client.describe()).sort(), ['configured', 'host', 'reason']);
});

test('an invalid service address disables the client without leaking anything', async () => {
  for (const url of ['ftp://x', 'not a url', 'http://user:pw@host:1']) {
    const c = createDeployerClient({ baseUrl: url, token: 'abc' });
    assert.equal(c.configured, false); assert.match(c.reason, /COCKPIT_DEPLOYER_URL/); assert.ok(!c.reason.includes('pw'));
  }
});

test('the token travels only in the Authorization header; health is called without it', async t => {
  const { service, client } = await make(t);
  assert.equal((await client.health()).ok, true);
  assert.equal(service.state.calls[0].auth, '');
  const result = await client.putProject('site', body);
  assert.equal(result.created, true); assert.equal((await client.putProject('site', body)).created, false);
  const put = service.state.calls.find(c => c.method === 'PUT');
  assert.equal(put.auth, 'Bearer ' + TOKEN); assert.ok(!put.route.includes(TOKEN)); assert.ok(!JSON.stringify(put.body).includes(TOKEN));
});

test('project ids are checked before any request (no path injection)', async t => {
  const { service, client } = await make(t);
  for (const id of ['../x', 'A', 'a/b', '', 'x'.repeat(41), '-a', 'a b']) await fails(client.getProject(id), 'invalid');
  assert.equal(service.state.calls.length, 0);
});

test('service errors become typed French errors: 401, 404, 409 in progress, 422, 500, secrets scrubbed', async t => {
  const { service, client } = await make(t);
  assert.equal(await client.getProject('absent'), null);
  await client.putProject('site', body);
  await client.deploy('site');
  const busy = await fails(client.deploy('site'), 'conflict'); assert.equal(busy.service, 'deploy_in_progress'); assert.match(busy.message, /déjà en cours/); assert.match(busy.deploymentId, /^d-/);
  service.state.mode.reject422 = true;
  const bad = await fails(client.putProject('site', body), 'invalid'); assert.match(bad.message, /n’existe pas dans le dépôt/);
  service.state.mode = { fail500: true };
  const boom = await fails(client.getProject('site'), 'refused'); assert.ok(!boom.message.includes(TOKEN), 'the token is scrubbed from service messages'); assert.match(boom.message, /\*\*\*/);
  const wrong = createDeployerClient({ baseUrl: service.url, token: 'mauvais-jeton' });
  const denied = await fails(wrong.getProject('site'), 'unauthorized'); assert.match(denied.message, /refusé le jeton/); assert.ok(!denied.message.includes('mauvais-jeton'));
});

test('unreachable, timeout, oversized and non-JSON answers are reported without hanging', async t => {
  const { service, client } = await make(t, { timeoutMs: 150 });
  service.state.down = true; const down = await fails(client.getProject('site'), 'unreachable'); assert.match(down.message, /injoignable/); assert.ok(!down.message.includes(TOKEN));
  service.state.down = false; service.state.delayMs = 600; await fails(client.getProject('site'), 'timeout');
  service.state.delayMs = 0; service.state.mode = { huge: true }; await fails(client.getProject('site'), 'bad_response');
  service.state.mode = { html: true }; await fails(client.getProject('site'), 'bad_response');
  const nowhere = createDeployerClient({ baseUrl: 'http://127.0.0.1:9', token: TOKEN, timeoutMs: 500 }); await fails(nowhere.getProject('site'), 'unreachable');
});

test('deployments are reduced to displayed fields: statuses mapped, journal capped, unknown status flagged', async t => {
  const { service, client } = await make(t);
  await client.putProject('site', body); await client.deploy('site');
  service.set('site', { status: 'rolled_back', log_tail: Array.from({ length: 80 }, (_, i) => 'ligne ' + i + (i === 79 ? ' Bearer abcdefghijklmnop' : '')).join('\n'), message: 'Santé KO' });
  const [dep] = await client.deployments('site');
  assert.equal(dep.status, 'rolled_back'); assert.equal(dep.log.length, 40); assert.equal(dep.log[0], 'ligne 40'); assert.ok(!dep.log.at(-1).includes('abcdefghijklmnop'));
  service.set('site', { status: 'nouveau-statut' }); assert.equal((await client.deployments('site'))[0].status, 'unknown');
  const project = await client.getProject('site'); assert.equal(project.latest.status, 'unknown'); assert.equal(project.deploying, false);
});
