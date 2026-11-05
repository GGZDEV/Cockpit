const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { setup, settle, until, TOKEN } = require('./helpers/deploy-setup.js');
const { createDeployerClient } = require('../deployer-client.cjs');
const { createAgentAccess, loadClients } = require('../agent-access.cjs');

const puts = s => s.service.state.calls.filter(c => c.method === 'PUT');
const dep = body => body.project || body;

test('settings are validated: https only, no credentials, branch, type, paths, public name', async t => {
  const s = await setup(t);
  const p = (await s.create('Alpha', {}, null)).body;
  const bad = async deployment => { const r = await s.ui('projects/' + p.id, 'PATCH', { deployment }); assert.equal(r.status, 400, JSON.stringify(deployment)); return r.body.error; };
  assert.match(await bad({ url: 'http://site.ggz.ovh' }), /https:\/\//);
  assert.match(await bad({ url: 'https://user:pw@site.ggz.ovh' }), /ni identifiant/);
  assert.match(await bad({ url: 'ftp://x' }), /https:\/\//); await bad({ url: 'https://exa mple.com' }); await bad({ url: 'javascript:alert(1)' });
  await bad({ branch: '../etc' }); await bad({ branch: 'a b' }); await bad({ branch: '-x' });
  assert.match(await bad({ type: 'docker' }), /Type de déploiement inconnu/);
  await bad({ type: 'ha-static', config: { src_dir: '../secret', ha_subdir: 'a' } }); await bad({ type: 'ha-static', config: { src_dir: '/etc', ha_subdir: 'a' } }); await bad({ type: 'ha-static', config: { src_dir: 'dist; rm -rf /', ha_subdir: 'a' } });
  await bad({ type: 'static-ssh', config: { host: 'a b', user: 'x', src_dir: 'd', dest_dir: '/var/www' } }); await bad({ type: 'systemd-ct', config: { host: 'h', user: 'x', dest_dir: 'relatif', service: 's', src_dir: '.' } });
  await bad({ buildCmd: 'a\nb' }); await bad({ testCmd: 'x'.repeat(301) });
  assert.match(await bad({ publicDomain: 'evil.example.com' }), /\.ggz\.ovh/); await bad({ publicDomain: '.ggz.ovh' }); await bad({ publicUpstream: 'http://192.168.1.5:80/admin' }); await bad({ publicUpstream: 'ftp://h' });
  const ok = await s.ui('projects/' + p.id, 'PATCH', { deployment: { url: 'https://Site.ggz.ovh/', auto: 'oui', branch: 'prod', type: 'systemd-ct', config: { host: '192.168.1.194', user: 'deploy', dest_dir: '/opt/app', service: 'mon-service', src_dir: '.', evil: 'x' }, publicDomain: 'Mon-Site.ggz.ovh', publicUpstream: 'http://192.168.1.194:7000' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.deployment, { url: 'https://site.ggz.ovh', auto: false, branch: 'prod', type: 'systemd-ct', config: { host: '192.168.1.194', user: 'deploy', dest_dir: '/opt/app', service: 'mon-service', src_dir: '.' }, buildCmd: '', testCmd: '', publicDomain: 'mon-site.ggz.ovh', publicUpstream: 'http://192.168.1.194:7000' });
});

test('backward compatible: a project saved before this feature loads unchanged and gets defaults without any migration', async t => {
  const s = await setup(t);
  fs.mkdirSync(path.join(s.dir, 'data'), { recursive: true });
  const legacy = { id: 'p-old', key: 'OL', name: 'Ancien', status: 'active', priority: 1, due: '', description: '', color: '#3dd68c', archived: false, seq: 2, context: { repository: 'https://github.com/ggzdev/ancien' }, createdAt: '2026-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(s.dir, 'data', 'projects.json'), JSON.stringify({ version: 1, projects: [legacy], tasks: [] }));
  s.restart();
  const loaded = await s.get('p-old');
  assert.equal(loaded.deployment, undefined, 'nothing is written for an old project'); assert.equal(loaded.deployState, undefined);
  assert.equal((await s.ui('projects/p-old', 'PATCH', { description: 'Mis à jour' })).status, 200);
  const after = await s.get('p-old'); assert.equal(after.deployment, undefined); assert.equal(after.deployState, undefined);
  assert.equal(s.service.state.calls.length, 0, 'an old project never reaches the service');
  const viewed = await s.ui('projects/p-old/deploy'); assert.equal(viewed.status, 200);
  const blocked = await s.ui('projects/p-old/deploy', 'POST'); assert.equal(blocked.status, 409); assert.match(blocked.body.error, /l’URL de déploiement/);
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'projects.json'), 'utf8')); assert.equal(saved.projects[0].name, 'Ancien'); assert.equal(saved.projects[0].seq, 2);
});

test('creating a configured project registers it with the service (PUT with the contract body), the token stays out of every response', async t => {
  const s = await setup(t);
  s.service.state.delayMs = 80; // Chaque appel dépasse l'ancienne attente fixe de 40 ms.
  const created = (await s.create('Site Vitrine', {}, { ...s.SETTINGS, auto: true, buildCmd: 'npm ci && npm run build', testCmd: 'npm test' })).body;
  s.service.state.delayMs = 0;
  assert.equal(puts(s).length, 1);
  const put = puts(s)[0];
  assert.equal(put.route, '/projects/site-vitrine'); assert.equal(put.auth, 'Bearer ' + TOKEN);
  assert.deepEqual(put.body, { repo: 'ggzdev/site-vitrine', branch: 'main', type: 'ha-static', public_url: 'https://site.ggz.ovh', auto: true, deploy: { src_dir: 'dist', ha_subdir: 'maison/site' }, build_cmd: 'npm ci && npm run build', test_cmd: 'npm test' });
  const project = await s.get(created.id);
  assert.equal(project.deployState.registered.status, 'ok'); assert.equal(project.deployState.slug, 'site-vitrine');
  for (const route of ['state', 'deploy-config', 'projects/' + created.id + '/deploy']) assert.ok(!(await s.ui(route)).raw.includes(TOKEN), route);
  assert.ok(!fs.readFileSync(path.join(s.dir, 'data', 'projects.json'), 'utf8').includes(TOKEN));
  // Idempotent : une modification sans effet sur le déploiement n'envoie rien ; un changement de mode renvoie un PUT.
  await s.ui('projects/' + created.id, 'PATCH', { description: 'autre' }); await settle(); assert.equal(puts(s).length, 1);
  await s.ui('projects/' + created.id, 'PATCH', { deployment: { auto: false } }); await settle(); assert.equal(puts(s).length, 2); assert.equal(puts(s)[1].body.auto, false);
});

test('an incomplete configuration waits instead of failing: nothing is sent until URL, type and repository are all there', async t => {
  const s = await setup(t);
  const a = (await s.create('Beta', {}, { url: 'https://beta.ggz.ovh' })).body;
  assert.equal(puts(s).length, 0);
  const r = (await s.get(a.id)).deployState.registered; assert.equal(r.status, 'pending'); assert.match(r.error, /le type de déploiement/);
  await s.ui('projects/' + a.id, 'PATCH', { deployment: { type: 'ha-static', config: { ha_subdir: 'x/y' } } }); await settle();
  assert.match((await s.get(a.id)).deployState.registered.error, /dossier à publier/); assert.equal(puts(s).length, 0);
  await s.ui('projects/' + a.id, 'PATCH', { deployment: { config: { src_dir: 'dist' } } }); await settle();
  const ready = await s.get(a.id); assert.equal(ready.deployState.registered.status, 'ok'); assert.equal(puts(s)[0].body.deploy.ha_subdir, 'x/y');
});

test('Déployer is refused with a clear message when the URL or the repository is missing, and the service is not called', async t => {
  const s = await setup(t);
  const noUrl = (await s.create('Gamma', {}, { type: 'ha-static', config: { src_dir: 'dist', ha_subdir: 'g' } })).body;
  let r = await s.ui('projects/' + noUrl.id + '/deploy', 'POST'); assert.equal(r.status, 409); assert.equal(r.body.error, 'Pour déployer, renseignez : l’URL de déploiement.');
  const noRepo = (await s.ui('projects', 'POST', { name: 'Delta', deployment: s.SETTINGS })).body;
  r = await s.ui('projects/' + noRepo.id + '/deploy', 'POST'); assert.equal(r.status, 409); assert.match(r.body.error, /le dépôt GitHub du projet/);
  assert.equal(s.service.state.calls.filter(c => /deploy$/.test(c.route)).length, 0);
  assert.equal((await s.ui('projects/inconnu/deploy', 'POST')).status, 404);
});

test('manual deployment: launch, follow status and short journal until success; a second launch is refused while one is running; usable with auto on', async t => {
  const s = await setup(t);
  const p = (await s.create('Epsilon', {}, { ...s.SETTINGS, auto: true })).body;
  const started = await s.ui('projects/' + p.id + '/deploy', 'POST');
  assert.equal(started.status, 202); assert.deepEqual(started.body.warnings, []);
  assert.equal(started.body.project.deployState.last.status, 'pending'); assert.equal(started.body.project.deployState.last.trigger, 'manual'); assert.equal(started.body.project.deployState.last.id, 'd-1');
  assert.equal(s.service.state.calls.filter(c => c.method === 'POST' && c.route === '/projects/epsilon/deploy').length, 1);
  assert.equal((await s.ui('projects/' + p.id + '/deploy', 'POST')).status, 409, 'one deployment at a time');
  s.service.set('epsilon', { status: 'running', status_label: 'en cours', step: 'build', message: 'Construction', log_tail: 'npm ci\nnpm run build' });
  let view = (await s.ui('projects/' + p.id + '/deploy')).body.deployState;
  assert.equal(view.last.status, 'running'); assert.deepEqual(view.last.log, ['npm ci', 'npm run build']); assert.equal(view.last.step, 'build');
  s.service.set('epsilon', { status: 'succeeded', status_label: 'réussi', step: 'health', message: 'Santé OK (HTTP 200)', finished_at: '2026-11-04T12:01:00Z', log_tail: 'ok' });
  view = (await s.ui('projects/' + p.id + '/deploy')).body.deployState;
  assert.equal(view.last.status, 'succeeded'); assert.equal(view.last.message, 'Santé OK (HTTP 200)'); assert.ok(view.checkedAt);
  assert.equal((await s.ui('projects/' + p.id + '/deploy', 'POST')).status, 202, 'redeploying after success is allowed');
});

test('a rolled-back or failed deployment is shown as such', async t => {
  const s = await setup(t);
  const p = (await s.create('Zeta')).body;
  await s.ui('projects/' + p.id + '/deploy', 'POST');
  s.service.set('zeta', { status: 'rolled_back', status_label: 'revenu en arrière', message: 'Santé KO (HTTP 502), ancienne version remise', step: 'rollback' });
  assert.equal((await s.ui('projects/' + p.id + '/deploy')).body.deployState.last.status, 'rolled_back');
  s.service.set('zeta', { status: 'failed', step: 'test', message: 'Tests en échec' });
  const last = (await s.ui('projects/' + p.id + '/deploy')).body.deployState.last; assert.equal(last.status, 'failed'); assert.equal(last.message, 'Tests en échec');
});

test('service-side race: the service says a deployment is already running → 409 and the state is refreshed', async t => {
  const s = await setup(t);
  const p = (await s.create('Eta')).body;
  s.service.autoDeploy('eta', { status: 'running', status_label: 'en cours', trigger: 'auto' });
  const r = await s.ui('projects/' + p.id + '/deploy', 'POST');
  assert.equal(r.status, 409); assert.match(r.body.error, /déjà en cours/);
  assert.equal((await s.get(p.id)).deployState.last.trigger, 'auto', 'the automatic deployment now shows');
});

test('service errors reach the interface as readable French messages with the right status and no secret', async t => {
  const s = await setup(t, { client: { timeoutMs: 200 } });
  const p = (await s.create('Theta')).body;
  const post = async () => s.ui('projects/' + p.id + '/deploy', 'POST');
  s.service.state.down = true; let r = await post();
  assert.equal(r.status, 502); assert.match(r.body.error, /injoignable/);
  s.service.state.down = false; s.service.state.delayMs = 700; r = await post(); assert.equal(r.status, 504); assert.match(r.body.error, /ne répond pas/);
  s.service.state.delayMs = 0; s.service.state.mode = { fail500: true }; r = await post(); assert.ok(r.status >= 400); assert.ok(!r.raw.includes(TOKEN), 'the token echoed by the service is scrubbed');
  s.service.state.mode = {};
  assert.ok(!s.logs.join('\n').includes(TOKEN), 'no log line carries the token');
  // Jeton refusé par le service.
  const wrong = await setup(t, { client: { token: 'mauvais-jeton-123' } });
  const q = (await wrong.create('Iota')).body;
  const reg = (await wrong.get(q.id)).deployState.registered; assert.equal(reg.status, 'failed'); assert.match(reg.error, /refusé le jeton/); assert.ok(!JSON.stringify(reg).includes('mauvais-jeton-123'));
  r = await wrong.ui('projects/' + q.id + '/deploy', 'POST'); assert.equal(r.status, 502); assert.match(r.body.error, /refusé le jeton/);
});

test('without a token configured on the server: clear message, no call, creation and editing still work', async t => {
  const s = await setup(t, { client: { token: '' } });
  const p = await s.create('Kappa'); assert.equal(p.status, 200);
  const reg = (await s.get(p.body.id)).deployState.registered; assert.equal(reg.status, 'failed'); assert.match(reg.error, /COCKPIT_DEPLOYER_TOKEN/);
  const r = await s.ui('projects/' + p.body.id + '/deploy', 'POST'); assert.equal(r.status, 503); assert.match(r.body.error, /COCKPIT_DEPLOYER_TOKEN/);
  assert.equal(s.service.state.calls.length, 0);
  const caps = (await s.state()).capabilities.deploy; assert.equal(caps.configured, false); assert.ok(!('token' in caps));
});

test('a service that is down at registration is retried later (not before one minute); a refused configuration is not retried', async t => {
  const s = await setup(t);
  s.service.state.down = true;
  const p = (await s.create('Lambda')).body;
  let reg = (await s.get(p.id)).deployState.registered; assert.equal(reg.status, 'failed'); assert.equal(reg.retry, true); assert.match(reg.error, /injoignable/);
  s.service.state.down = false;
  await s.projects().deployTick(); await settle(); assert.equal((await s.get(p.id)).deployState.registered.status, 'failed', 'too early');
  (await s.get(p.id)); s.projects().snapshot().projects.find(x => x.id === p.id).deployState.registered.at = new Date(Date.now() - 120000).toISOString();
  await s.projects().deployTick(); assert.equal((await s.get(p.id)).deployState.registered.status, 'ok');
  // Refus 422 : l'erreur du service est montrée et rien n'est réessayé automatiquement.
  s.service.state.mode.reject422 = true;
  const q = (await s.create('Mu')).body; reg = (await s.get(q.id)).deployState.registered;
  assert.equal(reg.status, 'failed'); assert.equal(reg.retry, false); assert.match(reg.error, /dossier à publier/);
  s.service.state.mode = {}; const again = await s.ui('projects/' + q.id + '/deploy-register', 'POST'); assert.equal(again.status, 200); assert.equal(again.body.deployState.registered.status, 'ok');
});

test('slug is derived from the name, never steals another repository’s service project, adopts the same repository', async t => {
  const s = await setup(t);
  s.service.state.projects.set('site', { id: 'site', repo: 'autre/depot', branch: 'main', type: 'ha-static', deploy: {}, auto: false });
  s.service.state.projects.set('blog', { id: 'blog', repo: 'ggzdev/blog', branch: 'main', type: 'ha-static', deploy: {}, auto: false });
  const a = (await s.create('Site')).body, b = (await s.create('Blog')).body;
  assert.equal((await s.get(a.id)).deployState.slug, 'site-2'); assert.deepEqual(s.service.state.projects.get('site').repo, 'autre/depot', 'the foreign project is untouched');
  assert.equal((await s.get(b.id)).deployState.slug, 'blog');
  const twin = (await s.create('Site', { context: { repository: 'https://github.com/ggzdev/site-bis' } })).body;
  assert.equal((await s.get(twin.id)).deployState.slug, 'site-3');
});

test('warning when local commits are not on GitHub yet (the service deploys GitHub’s version)', async t => {
  const s = await setup(t);
  const p = (await s.create('Nu')).body;
  const project = s.projects().snapshot().projects.find(x => x.id === p.id);
  project.workspace = { status: 'ready', path: path.join(s.dir, 'dev', 'nu'), repo: p.context.repository };
  const { git } = require('./helpers/deploy-setup.js'); const dir = project.workspace.path;
  await git(['-C', dir, 'checkout', '-q', '-b', 'main']); fs.writeFileSync(path.join(dir, 'a.txt'), '1'); await git(['-C', dir, 'add', 'a.txt']); await git(['-C', dir, 'commit', '-q', '-m', 'un']); await git(['-C', dir, 'push', '-q', '-u', 'origin', 'main']);
  fs.writeFileSync(path.join(dir, 'b.txt'), '2'); await git(['-C', dir, 'add', 'b.txt']); await git(['-C', dir, 'commit', '-q', '-m', 'deux']);
  const r = await s.ui('projects/' + p.id + '/deploy', 'POST');
  assert.equal(r.status, 202); assert.match(r.body.warnings[0], /1 commit de la copie locale n’est pas encore sur GitHub \(branche main\)/);
});

test('automatic mode: Cockpit only registers and shows the state of deployments the service starts itself', async t => {
  const s = await setup(t);
  const p = (await s.create('Xi', {}, { ...s.SETTINGS, auto: true })).body;
  assert.equal(puts(s)[0].body.auto, true);
  assert.equal(s.service.state.calls.filter(c => /\/deploy$/.test(c.route)).length, 0, 'no manual deployment is triggered');
  s.service.autoDeploy('xi', { commit: '0a1b2c3' });
  for (let i = 0; i < 4; i++) await s.projects().deployTick();
  const last = (await s.get(p.id)).deployState.last; assert.equal(last.trigger, 'auto'); assert.equal(last.status, 'succeeded'); assert.equal(last.commit, '0a1b2c3');
  // Un projet en mode manuel n'est pas sondé en tâche de fond.
  const q = (await s.create('Omicron')).body; const before = s.service.state.calls.length;
  for (let i = 0; i < 4; i++) await s.projects().deployTick();
  assert.equal(s.service.state.calls.slice(before).filter(c => c.route === '/projects/omicron').length, 0);
});

test('public name: the service waits for validation; only an explicit call on that exact name approves', async t => {
  const s = await setup(t);
  const p = (await s.create('Pi', {}, { ...s.SETTINGS, publicDomain: 'pi.ggz.ovh', publicUpstream: 'http://192.168.1.194:7000' })).body;
  assert.deepEqual(puts(s)[0].body.subdomain, { name: 'pi.ggz.ovh', upstream: 'http://192.168.1.194:7000' });
  assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 0, 'registering never approves');
  await s.ui('projects/' + p.id + '/deploy'); assert.equal((await s.get(p.id)).deployState.subdomain.status, 'awaiting_validation');
  const wrong = await s.ui('projects/' + p.id + '/deploy-public', 'POST', { name: 'autre.ggz.ovh' }); assert.equal(wrong.status, 400);
  assert.equal((await s.ui('projects/' + p.id + '/deploy-public', 'POST', {})).status, 400);
  assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 0, 'a wrong name approves nothing');
  const ok = await s.ui('projects/' + p.id + '/deploy-public', 'POST', { name: 'Pi.ggz.ovh' });
  assert.equal(ok.status, 200); assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 1);
  assert.equal(ok.body.deployState.subdomain.status, 'published');
  const twice = await s.ui('projects/' + p.id + '/deploy-public', 'POST', { name: 'pi.ggz.ovh' }); assert.equal(twice.status, 409); assert.match(twice.body.error, /Rien à valider/);
  assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 1);
  const none = (await s.create('Rho')).body; assert.equal((await s.ui('projects/' + none.id + '/deploy-public', 'POST', { name: 'rho.ggz.ovh' })).status, 409);
});

test('agents see the deployment state read-only and cannot deploy, enable auto, set a deployment or validate a public name', async t => {
  const s = await setup(t);
  const clients = loadClients(path.join(s.dir, 'agent-access.json'));
  const access = createAgentAccess({ projects: s.projects(), clients });
  await new Promise(r => access.listen(0, '127.0.0.1', r)); t.after(() => access.close());
  const base = 'http://127.0.0.1:' + access.address().port + '/agent/v1/';
  const call = async (route, method = 'GET', body) => { const r = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + clients.claude.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const p = (await s.create('Sigma', {}, { ...s.SETTINGS, auto: true })).body;
  const state = await call('state'); const seen = state.body.projects.find(x => x.name === 'Sigma');
  assert.equal(seen.deploy.url, 'https://site.ggz.ovh'); assert.equal(seen.deploy.auto, true); assert.equal(seen.deploy.registered, 'ok'); assert.ok(!JSON.stringify(state.body).includes(TOKEN));
  for (const route of ['projects/SI/deploy', 'projects/SI/deploy-public', 'projects/SI/bootstrap']) assert.equal((await call(route, 'POST', { name: 'x.ggz.ovh' })).status, 403, route);
  const patched = await call('projects/SI', 'PATCH', { deployment: { auto: false, url: 'https://evil.example.com' }, newRepository: { name: 'x' } });
  assert.equal(patched.status, 200); const after = await s.get(p.id); assert.equal(after.deployment.auto, true); assert.equal(after.deployment.url, 'https://site.ggz.ovh');
  const created = await call('projects', 'POST', { name: 'Tau', repository: 'https://github.com/ggzdev/tau', deployment: { url: 'https://x.ggz.ovh', auto: true }, newRepository: { name: 'tau2' } });
  assert.equal(created.status, 201); await settle(); assert.equal((await s.get(created.body.id)).deployment, undefined); assert.equal(s.github.created.length, 0);
});

test('routes allowed on the web interface and the tablet relay', async t => {
  const s = await setup(t);
  const ok = (m, p) => s.projects().allowedRoute(m, '/api/projects/' + p);
  assert.ok(ok('GET', 'deploy-config')); assert.ok(!ok('POST', 'deploy-config'));
  assert.ok(ok('GET', 'projects/abc/deploy')); assert.ok(ok('POST', 'projects/abc/deploy')); assert.ok(!ok('DELETE', 'projects/abc/deploy')); assert.ok(!ok('PATCH', 'projects/abc/deploy'));
  for (const r of ['deploy-register', 'deploy-public', 'bootstrap']) { assert.ok(ok('POST', 'projects/abc/' + r), r); assert.ok(!ok('GET', 'projects/abc/' + r), r); }
  assert.ok(!ok('POST', 'projects/abc/deploy-nimporte'));
});

test('deploy-config reports the service and GitHub capabilities without any secret', async t => {
  const s = await setup(t, { github: { available: false } });
  const r = (await s.ui('deploy-config')).body;
  assert.equal(r.service.configured, true); assert.equal(r.service.reachable, true); assert.equal(r.github.available, false); assert.match(r.github.reason, /GitHub CLI/); assert.equal(r.publicSuffix, '.ggz.ovh');
  s.service.state.down = true; assert.equal((await s.ui('deploy-config')).body.service.reachable, false);
  assert.ok(!(await s.ui('deploy-config')).raw.includes(TOKEN));
});
