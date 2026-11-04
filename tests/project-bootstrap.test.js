const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { setup, settle, until, git } = require('./helpers/deploy-setup.js');
const { createGithub } = require('../github-repos.cjs');

const NEW = { name: 'Atelier Neuf', description: 'Un site tout neuf', newRepository: { name: 'atelier-neuf' }, deployment: { url: 'https://atelier.ggz.ovh', type: 'ha-static', config: { src_dir: 'dist', ha_subdir: 'maison/atelier' } } };
const create = (s, extra = {}) => s.ui('projects', 'POST', { ...NEW, ...extra });
const done = (s, id, status = 'done') => until(async () => { const p = await s.get(id); return p.bootstrap?.status === status && p; });

test('new project: GitHub repository created, cloned, skeleton committed and pushed, registered with the deployment service', async t => {
  const s = await setup(t);
  const r = await create(s); assert.equal(r.status, 200); assert.equal(r.body.bootstrap.status, 'running');
  const p = await done(s, r.body.id);
  assert.deepEqual(s.github.created, [{ owner: 'ggzdev', name: 'atelier-neuf', isPrivate: true }], 'private by default, owner = the connected account');
  assert.equal(p.context.repository, 'https://github.com/ggzdev/atelier-neuf'); assert.equal(p.workspace.status, 'ready');
  const bare = s.github.remotes.get('atelier-neuf');
  assert.match(await git(['-C', bare, 'log', '--format=%s', 'main']), /Squelette initial/);
  assert.match(await git(['-C', bare, 'show', 'main:README.md']), /# Atelier Neuf\n\nUn site tout neuf/); assert.match(await git(['-C', bare, 'show', 'main:.gitignore']), /node_modules/);
  assert.equal((await git(['-C', p.workspace.path, 'status', '--porcelain'])).trim(), '', 'the local copy is clean and tracks origin/main');
  assert.equal(p.deployState.registered.status, 'ok'); assert.equal(s.service.state.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(s.service.state.calls.find(c => c.method === 'PUT').body.repo, 'ggzdev/atelier-neuf');
});

test('new project: public repository only when asked, explicit owner, custom production branch', async t => {
  const s = await setup(t);
  const r = await create(s, { newRepository: { name: 'vitrine', owner: 'Equipe-X', private: false }, deployment: { ...NEW.deployment, branch: 'prod' } });
  const p = await done(s, r.body.id);
  assert.deepEqual(s.github.created[0], { owner: 'Equipe-X', name: 'vitrine', isPrivate: false });
  assert.match(await git(['-C', s.github.remotes.get('vitrine'), 'branch', '--list']), /prod/);
  assert.equal(p.workspace.status, 'ready');
});

test('new project: GitHub unavailable → the project is still created with the exact reason; retry works once fixed, and creates the repository once', async t => {
  const s = await setup(t, { github: { available: false } });
  const r = await create(s); assert.equal(r.status, 200);
  const failed = await done(s, r.body.id, 'failed');
  assert.match(failed.bootstrap.error, /GitHub CLI n’est pas connecté/); assert.equal(failed.bootstrap.step, 'repo'); assert.equal(s.github.created.length, 0);
  assert.equal(failed.context.repository, undefined, 'no repository is invented');
  assert.equal(s.service.state.calls.filter(c => c.method === 'PUT').length, 0);
  s.github.available = true;
  const retry = await s.ui('projects/' + r.body.id + '/bootstrap', 'POST'); assert.equal(retry.status, 202);
  const ok = await done(s, r.body.id); assert.equal(s.github.created.length, 1); assert.equal(ok.deployState.registered.status, 'ok');
  assert.equal((await s.ui('projects/' + r.body.id + '/bootstrap', 'POST')).status, 409, 'nothing to retry once done');
});

test('new project: repository name already taken on GitHub → readable error, nothing else happens', async t => {
  const s = await setup(t, { github: { failCreate: 'Le dépôt ggzdev/atelier-neuf existe déjà sur GitHub : rien n’a été créé.' } });
  const p = await done(s, (await create(s)).body.id, 'failed');
  assert.match(p.bootstrap.error, /existe déjà sur GitHub/); assert.equal(p.workspace, undefined);
});

test('new project: push refused → files stay in the local folder, retry only pushes (no second repository, no second commit)', async t => {
  const s = await setup(t); s.github.rejectPush = true; // le dépôt distant refuse tout push tant que son crochet existe
  const r = await create(s);
  let p = await done(s, r.body.id, 'failed');
  assert.match(p.bootstrap.error, /push vers GitHub a été refusé/); assert.equal(p.bootstrap.step, 'push');
  assert.ok(fs.existsSync(path.join(p.workspace.path, 'README.md')), 'the skeleton is kept locally');
  fs.rmSync(path.join(s.github.remotes.get('atelier-neuf'), 'hooks', 'pre-receive'));
  await s.ui('projects/' + r.body.id + '/bootstrap', 'POST'); p = await done(s, r.body.id);
  assert.equal(s.github.created.length, 1); assert.equal((await git(['-C', p.workspace.path, 'rev-list', '--count', 'HEAD'])).trim(), '1');
  assert.match(await git(['-C', s.github.remotes.get('atelier-neuf'), 'log', '--format=%s', 'main']), /Squelette initial/);
});

test('new project: inputs are validated before anything is created', async t => {
  const s = await setup(t);
  const bad = async (extra, status, re) => { const r = await create(s, extra); assert.equal(r.status, status, JSON.stringify(extra)); assert.match(r.body.error, re); };
  await bad({ newRepository: { name: '../x' } }, 400, /Nom de dépôt/); await bad({ newRepository: { name: 'a b' } }, 400, /Nom de dépôt/); await bad({ newRepository: { name: 'x.git' } }, 400, /Nom de dépôt/);
  await bad({ newRepository: { name: 'ok', owner: 'a/b' } }, 400, /Compte GitHub/); await bad({ newRepository: 'oui' }, 400, /invalides/);
  await bad({ context: { repository: 'https://github.com/ggzdev/deja' } }, 400, /existant OU un nouveau/);
  fs.mkdirSync(path.join(s.dir, 'dev', 'occupe'), { recursive: true });
  await bad({ newRepository: { name: 'occupe' } }, 409, /existe déjà/);
  assert.equal(s.github.created.length, 0); assert.equal((await s.state()).projects.length, 0, 'a refused creation leaves no project behind');
});

test('new project: an existing README is never overwritten; a restart in the middle is recoverable', async t => {
  const s = await setup(t);
  const r = await create(s);
  const p = await done(s, r.body.id);
  fs.writeFileSync(path.join(p.workspace.path, 'README.md'), 'MON TEXTE');
  const { seed } = require('../project-bootstrap.cjs');
  const out = await seed({ project: p, dir: p.workspace.path, branch: 'main', git: s.workspaces.git });
  assert.deepEqual(out.written, []); assert.equal(fs.readFileSync(path.join(p.workspace.path, 'README.md'), 'utf8'), 'MON TEXTE');
  // Redémarrage pendant la création : l'état « en cours » devient « échoué » et reprenable.
  const raw = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'projects.json'), 'utf8')); raw.projects[0].bootstrap.status = 'running'; raw.projects[0].bootstrap.step = 'push';
  fs.writeFileSync(path.join(s.dir, 'data', 'projects.json'), JSON.stringify(raw));
  s.restart(); const after = await s.get(raw.projects[0].id);
  assert.equal(after.bootstrap.status, 'failed'); assert.match(after.bootstrap.error, /redémarré/);
  await s.ui('projects/' + after.id + '/bootstrap', 'POST'); assert.equal((await done(s, after.id)).bootstrap.status, 'done');
  assert.equal(s.github.created.length, 1, 'the repository already exists: it is not created again');
});

test('GitHub CLI wrapper: argument arrays only, token handed to gh alone, missing tool and missing scope explained, no secret in messages', async () => {
  const calls = [];
  const make = (behaviour, env = {}) => createGithub({ env: { PATH: '/x', COCKPIT_GITHUB_TOKEN: env.token || '', ...env.extra }, cacheMs: 0, run: async (args, { env: e }) => { calls.push({ args, env: e }); return behaviour(args, e); } });
  const ok = make(args => args[0] === 'auth' ? "Logged in\n  - Token scopes: 'gist', 'repo', 'workflow'" : args[0] === 'api' ? 'ggzdev\n' : '', { token: 'ghp_abcdefghijklmnopqrstuvwxyz' });
  assert.deepEqual(await ok.status(), { available: true, account: 'ggzdev' });
  await ok.createRepo({ owner: 'ggzdev', name: 'nouveau', isPrivate: true });
  const create = calls.find(c => c.args[0] === 'repo'); assert.deepEqual(create.args, ['repo', 'create', 'ggzdev/nouveau', '--private']);
  assert.equal(create.env.GH_TOKEN, 'ghp_abcdefghijklmnopqrstuvwxyz', 'the configured token reaches gh through its environment only'); assert.ok(!create.args.join(' ').includes('ghp_'));
  await assert.rejects(ok.createRepo({ owner: 'ggzdev', name: 'a;rm -rf /' }), /Nom de dépôt non valide/); await assert.rejects(ok.createRepo({ owner: '--evil', name: 'x' }), /Compte GitHub non valide/);
  const absent = make(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
  assert.match((await absent.status()).reason, /pas installé.*COCKPIT_GITHUB_TOKEN/);
  const loggedOut = make(() => { throw Object.assign(new Error('x'), { stderr: 'You are not logged into any GitHub hosts.' }); });
  assert.match((await loggedOut.status()).reason, /gh auth login/);
  const narrow = make(args => args[0] === 'auth' ? "  - Token scopes: 'gist', 'read:org'" : '');
  assert.match((await narrow.status()).reason, /droit « repo »/);
  const refused = make(args => { if (args[0] === 'auth') return "Token scopes: 'repo'"; if (args[0] === 'api') return 'u'; throw Object.assign(new Error('x'), { stderr: 'GraphQL: Name already exists on this account (createRepository)' }); });
  await assert.rejects(refused.createRepo({ owner: 'u', name: 'n' }), /existe déjà sur GitHub/);
  const leaky = make(args => { if (args[0] === 'auth') return "Token scopes: 'repo'"; if (args[0] === 'api') return 'u'; throw Object.assign(new Error('x'), { stderr: 'boom token=ghp_abcdefghijklmnopqrstuvwxyz' }); });
  await assert.rejects(leaky.createRepo({ owner: 'u', name: 'n' }), e => !e.message.includes('ghp_abcdefghijklmnopqrstuvwxyz'));
});
