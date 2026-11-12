'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const claude = require('../claude-direct.cjs');
const { recipe } = require('../scripts/applicationctl.cjs');
const deploy = require('../project-deploy.cjs');
test('Applications opt-in gives real network rights and server policy to resumed sessions; default unchanged', () => {
  const before = process.env.COCKPIT_APPLICATIONS;
  try {
    delete process.env.COCKPIT_APPLICATIONS;
    let args = claude.buildArgs({ sessionId: 'session', fresh: false });
    assert.ok(args.includes('Bash(ssh:*)'));
    process.env.COCKPIT_APPLICATIONS = '1';
    args = claude.buildArgs({ sessionId: 'session', fresh: false });
    assert.ok(!args.includes('Bash(ssh:*)'));
    assert.ok(args.includes('Bash(git push:*)'));
    assert.ok(args.includes('--resume'));
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /CT113.*application/);
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /conserve les modes automatique\/manuel/);
  } finally { if (before === undefined) delete process.env.COCKPIT_APPLICATIONS; else process.env.COCKPIT_APPLICATIONS = before; }
});
test('Compose recipe preserves established branch and auto mode and has a rollback command', () => {
  const value = recipe('example', { compose: 'compose.yaml', healthUrl: 'http://192.168.1.236:3100/' }, { repo: 'ggz/example', branch: 'production', auto: true, public_url: 'https://example.ggz.ovh' });
  assert.equal(value.auto, true); assert.equal(value.branch, 'production');
  assert.equal(value.deploy.deploy_cmd, value.deploy.rollback_cmd);
  assert.throws(() => recipe('bad;id', {}));
  assert.throws(() => recipe('example', { recipe: '../bad.json' }));
});
test('health settings support internal authenticated-host checks without accepting credentials', () => {
  assert.equal(deploy.cleanSettings({ health: null }).health, null);
  const h = deploy.cleanSettings({ health: { url: 'http://192.168.1.236:3100/', expect_status: 200 } }).health;
  assert.equal(h.expect_status, 200);
  assert.throws(() => deploy.cleanSettings({ health: { url: 'http://user:password@host/', expect_status: 200 } }));
});
test('a new project adopts its accepted Compose recipe, never on Clore-only, preserving auto and branch', async t => {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
  const { setup, git } = require('./helpers/direct-setup.js');
  const before = process.env.COCKPIT_APPLICATIONS;
  process.env.COCKPIT_APPLICATIONS = '1';
  t.after(() => { if (before === undefined) delete process.env.COCKPIT_APPLICATIONS; else process.env.COCKPIT_APPLICATIONS = before; });
  const deployer = { configured: true, describe: () => ({ configured: true }), getProject: async () => null, putProject: async () => { throw new Error('test enregistrement indisponible'); } };
  const s = await setup(t, { deployer }), local = path.join(s.root, 'alpha'), origin = path.join(s.dir, 'origin.git');
  cp.execFileSync('git', ['clone', '-q', '--bare', local, origin]);
  git(local, 'remote', 'add', 'origin', origin); git(local, 'fetch', '-q', 'origin');
  const project = await s.project('alpha', { deployment: { url: 'https://alpha.ggz.ovh', auto: true, branch: 'main' } });
  const task = await s.create(project.id); await s.launch(task.id); const done = await s.lastDone(task.id);
  fs.mkdirSync(path.join(done.direct.cwd, 'deploy'));
  fs.writeFileSync(path.join(done.direct.cwd, 'deploy/application.json'), JSON.stringify({ compose: 'compose.yaml', healthUrl: 'http://192.168.1.236:3200/' }));
  git(done.direct.cwd, 'add', 'deploy/application.json');
  git(done.direct.cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'recipe');
  assert.equal((await s.ui('tasks/' + task.id + '/accept', 'POST', { publish: false })).status, 200);
  let state = (await s.ui('state')).body.projects.find(p => p.id === project.id);
  assert.equal(state.deployment.type, '');
  await s.ui('tasks/' + task.id, 'PATCH', { status: 'todo' });
  const accepted = await s.ui('tasks/' + task.id + '/accept', 'POST', {});
  assert.equal(accepted.status, 200);
  state = (await s.ui('state')).body.projects.find(p => p.id === project.id);
  assert.equal(state.deployment.type, 'custom'); assert.equal(state.deployment.auto, true); assert.equal(state.deployment.branch, 'main');
  assert.match(state.deployment.config.deploy_cmd, /application-deploy/);
  assert.match(accepted.body.deployError, /enregistrement|configur/i, 'missing infrastructure remains visible instead of claiming deployment');
});
