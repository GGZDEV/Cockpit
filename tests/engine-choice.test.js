const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { setup } = require('./helpers/direct-setup.js');

test('engine choice: Claude Code by default, Codex or OpenClaw per project or per task; OpenClaw keeps its own flow', async t => {
  const { ui, project, create, launch, lastDone, calls, feed } = await setup(t);
  const agent = { connectionId: 'c1', agentId: 'homelab', name: 'homelab' };
  const p = await project('alpha');
  assert.equal(p.engine, 'claude');
  const direct = await create(p.id); assert.equal((await ui('state')).body.engineByTask[direct.id], 'claude');
  assert.equal((await ui('tasks/' + direct.id, 'PATCH', { engine: 'bogus' })).body.engine, undefined, 'unknown engines are dropped');
  // Projet OpenClaw explicite : le fil OpenClaw d'avant, sans toucher au moteur direct.
  const legacy = await project('beta', { engine: 'openclaw', agent }), t2 = await create(legacy.id, { agent });
  assert.equal((await ui('state')).body.engineByTask[t2.id], 'openclaw');
  assert.equal((await launch(t2.id)).status, 202); const done = await lastDone(t2.id);
  assert.equal(done.runs[0].conversationId, 'conv1'); assert.equal(done.runs[0].engine, undefined); assert.equal(feed.sends.length, 1); assert.equal(calls().length, 0);
  assert.equal((await launch(t2.id, { kind: 'execute' })).status, 400, 'only direct engines have plans');
  // Une tâche peut choisir OpenClaw dans un projet Claude Code ; une tâche déjà engagée ne change plus avec le projet.
  const mixed = await create(p.id, { engine: 'openclaw', agent }); await launch(mixed.id); await lastDone(mixed.id);
  assert.equal(feed.sends.length, 2); assert.equal(calls().length, 0);
  await launch(direct.id); await lastDone(direct.id); assert.equal(calls().length, 1);
  await ui('projects/' + p.id, 'PATCH', { engine: 'openclaw' });
  assert.equal((await ui('state')).body.engineByTask[direct.id], 'claude', 'a started task keeps its engine');
  const later = await create(p.id); assert.equal((await ui('state')).body.engineByTask[later.id], 'openclaw', 'a task not started follows the project');
});

test('existing projects and tasks keep working as before (no engine saved, agent assigned)', async t => {
  const { ui, project, create, launch, lastDone, calls, feed, make, services } = await setup(t);
  const agent = { connectionId: 'c1', agentId: 'homelab', name: 'homelab' };
  const p = await project('alpha', { agent, engine: undefined });
  // Projet d'avant les moteurs directs : ni moteur ni lancement direct enregistrés.
  const snap = services[0].snapshot(); const stored = snap.projects.find(x => x.id === p.id); delete stored.engine;
  const task = await create(p.id, { agent }); delete snap.tasks.find(x => x.id === task.id).engine;
  assert.equal((await ui('state')).body.engineByTask[task.id], 'openclaw', 'a project with its own OpenClaw agent stays on OpenClaw');
  await launch(task.id); await lastDone(task.id);
  assert.equal(feed.sends.length, 1); assert.equal(calls().length, 0);
  // Même tâche relancée plus tard : toujours OpenClaw (conversation engagée), même si le projet passe sur Claude Code.
  stored.engine = 'claude'; await launch(task.id, { kind: 'reprise', note: 'suite' }); await lastDone(task.id);
  assert.equal(feed.sends.length, 2); assert.equal(calls().length, 0);
});

test('COCKPIT_DIRECT=0 (directEnabled: false) turns every direct engine off', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mb-off-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createProjects } = require('../projects.cjs');
  const service = createProjects({ dataDir: dir, discover: async () => null, reconcileEvery: 3600000, directEnabled: false, workspaces: { root: dir, target: () => '', clone: async () => ({ path: dir }) } });
  t.after(() => service.close());
  const snap = service.snapshot(); assert.equal(snap.capabilities.direct, false); assert.deepEqual(snap.capabilities.engines, { claude: false, codex: false });
});

test('attachments: paths are listed in the first request only and the folder is opened to Claude with --add-dir', async t => {
  const { ui, project, create, launch, lastDone, calls } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const added = await ui('tasks/' + task.id + '/attachments?name=capture.png', 'POST', undefined, png); assert.equal(added.status, 200);
  await launch(task.id); await lastDone(task.id);
  const [first] = calls(); assert.match(first.input, /## Pièces jointes \(à lire avec Read\)\n- capture\.png \(image\/png, 1 Ko\) : .*\/data\/attachments\/.*\.png/);
  assert.ok(first.args.includes('--add-dir'));
  await launch(task.id, { kind: 'reprise', note: 'encore' }); await lastDone(task.id);
  assert.equal(calls()[1].input, 'Suite (AL-1) :\nencore', 'already sent: not repeated');
});

test('nothing secret is stored: project data holds no token, key or login', async t => {
  const { project, create, launch, lastDone, dir } = await setup(t);
  const p = await project('alpha'), task = await create(p.id); await launch(task.id); await lastDone(task.id);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'data', 'projects.json'), 'utf8'), /ghp_abcdef|sk-ant-should|oauth-keep|sk-openai/);
});
