const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const env = require('../task-env.cjs');
const { setup } = require('./helpers/direct-setup');

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, files) => { for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body)); } return dir; };
const pkg = (extra = {}) => ({ name: 'x', scripts: { test: 'node --test' }, ...extra });
// Faux lanceur : enregistre chaque commande, répond selon `reply`.
const fakeRun = (reply = () => ({ code: 0, output: '' })) => { const calls = []; const run = async (file, args, options) => { calls.push({ file, args, ...options }); return { timedOut: false, aborted: false, output: '', ...(await reply(file, args, options)) }; }; run.calls = calls; return run; };
const commands = { npm: ['/fake/npm'], pnpm: ['/fake/pnpm'] };

test('install plan follows the lockfile and never writes to the repository', t => {
  const dir = tmp(t), at = name => fs.mkdirSync(path.join(dir, name));
  const plan = files => { const d = path.join(dir, String(Math.random()).slice(2)); fs.mkdirSync(d); write(d, files); return env.installPlan(d); };
  assert.equal(plan({ 'README.md': 'x' }), null, 'pas de package.json');
  assert.equal(plan({ 'package.json': pkg() }), null, 'rien à installer');
  assert.deepEqual(plan({ 'package.json': pkg(), 'package-lock.json': '{}' }).args, ['ci', '--no-audit', '--no-fund', '--prefer-offline']);
  assert.equal(plan({ 'package.json': pkg(), 'npm-shrinkwrap.json': '{}' }).label, 'npm ci');
  assert.equal(plan({ 'package.json': pkg(), 'pnpm-lock.yaml': '' }).tool, 'pnpm');
  assert.equal(plan({ 'package.json': pkg(), 'yarn.lock': '' }).tool, 'yarn');
  const loose = plan({ 'package.json': pkg({ devDependencies: { left: '1' } }) });
  assert.equal(loose.label, 'npm install'); assert.ok(loose.args.includes('--no-save') && loose.args.includes('--no-package-lock'));
  assert.equal(plan({ 'package.json': pkg({ dependencies: { a: '1' } }), 'package-lock.json': '{}', 'node_modules/.keep': '' }), null, 'déjà installées');
  assert.equal(plan({ 'package.json': '{oops' }), null);
  at('unused');
});

test('install runs without shell, with a filtered environment, and reports missing tools or failures', async t => {
  const dir = write(tmp(t), { 'package.json': pkg({ dependencies: { a: '1' } }), 'package-lock.json': '{}' });
  const run = fakeRun();
  const taskEnv = env.createTaskEnv({ run, commands, env: { PATH: '/usr/bin', HOME: '/home/x', GH_TOKEN: 'ghp_secret', COCKPIT_WEB_PASSWORD: 'pw', NODE_TEST_CONTEXT: 'child-v8' }, git: null });
  const ok = await taskEnv.install(dir);
  assert.equal(ok.status, 'installed'); assert.equal(env.describeInstall(ok).startsWith('Dépendances installées (npm ci'), true);
  const [call] = run.calls;
  assert.equal(call.file, '/fake/npm'); assert.deepEqual(call.args, ['ci', '--no-audit', '--no-fund', '--prefer-offline']); assert.equal(call.cwd, dir);
  assert.equal(call.env.HOME, '/home/x'); assert.equal(call.env.CI, '1');
  for (const k of ['GH_TOKEN', 'COCKPIT_WEB_PASSWORD', 'NODE_TEST_CONTEXT']) assert.equal(call.env[k], undefined, k);
  assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 10 * 60000);
  const failing = env.createTaskEnv({ run: fakeRun(() => ({ code: 1, output: 'npm ERR! 404 token=abcdef123456\nnpm ERR! fin' })), commands, git: null });
  const failed = await failing.install(dir);
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.summary, /abcdef123456/); assert.match(env.describeInstall(failed), /Échec.*npm ERR! fin/);
  const yarnDir = write(tmp(t), { 'package.json': pkg({ dependencies: { a: '1' } }), 'yarn.lock': '' });
  const missing = await env.createTaskEnv({ run: fakeRun(), commands: {}, env: { PATH: tmp(t) }, git: null }).install(yarnDir);
  assert.equal(missing.status, 'missing'); assert.match(missing.summary, /yarn n’est pas installé/);
  assert.equal(await taskEnv.install(write(tmp(t), { 'package.json': pkg() })), null);
});

test('baseline: once per commit, counts parsed, files rewritten by the tests restored', async t => {
  const dir = write(tmp(t), { 'package.json': pkg(), 'data.json': '{"a":1}\n' });
  execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const run = fakeRun((file, args, { cwd }) => { fs.writeFileSync(path.join(cwd, 'data.json'), '{"a":2}\n'); return { code: 1, output: 'ℹ tests 12\nℹ pass 10\nℹ fail 2\nℹ duration_ms 5' }; });
  const git = args => new Promise((resolve, reject) => require('node:child_process').execFile('git', args, (e, out) => e ? reject(e) : resolve(out)));
  const b = await env.createTaskEnv({ run, commands, git }).baseline(dir, 'abc1234def');
  assert.deepEqual(run.calls[0].args, ['test']);
  assert.equal(b.sha, 'abc1234def'); assert.equal(b.ok, false); assert.deepEqual([b.passed, b.failed, b.total], [10, 2, 12]);
  assert.match(b.summary, /ℹ fail 2/); assert.deepEqual(b.restored, ['data.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), '{"a":1}\n', 'fichier suivi remis en état');
  assert.equal(env.describeBaseline(b), 'Tests de départ : échecs existants (10/12 réussis)');
  assert.equal(env.describeBaseline({ ok: true, passed: 12, total: 12 }), 'Tests de départ : 12/12');
  assert.equal(await env.createTaskEnv({ run, commands, git: null }).baseline(write(tmp(t), { 'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), 'x'), null);
  assert.deepEqual(env.counts('Tests:       1 failed, 11 passed, 12 total'), { passed: 11, failed: 1, total: 12 });
  assert.deepEqual(env.counts('  7 passing (20ms)\n  1 failing'), { passed: 7, failed: 1, total: 8 });
  assert.deepEqual(env.counts('# pass 3\n# fail 0'), { passed: 3, failed: 0, total: 3 });
  assert.equal(env.counts('rien'), null);
});

test('the real runner kills a command that exceeds its delay or is stopped', async t => {
  const dir = tmp(t), script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, "console.log('début'); setInterval(() => {}, 1000);");
  const slow = await env.runCommand(process.execPath, [script], { cwd: dir, env: process.env, timeoutMs: 300 });
  assert.equal(slow.timedOut, true); assert.match(slow.output, /début/);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 200);
  const stopped = await env.runCommand(process.execPath, [script], { cwd: dir, env: process.env, timeoutMs: 10000, signal: controller.signal });
  assert.equal(stopped.aborted, true);
  const missing = await env.runCommand(path.join(dir, 'absent'), [], { cwd: dir, env: process.env, timeoutMs: 1000 });
  assert.match(missing.error, /introuvable/);
});

test('the brief tells what is ready and how to verify, separating existing and new failures', () => {
  const brief = env.environmentBrief({ deps: { status: 'installed', label: 'npm ci' }, baseline: { sha: 'abcdef1234', ok: false, passed: 10, total: 12, summary: 'ℹ fail 2' }, testable: true, visual: '/opt/cockpit/scripts/visual-check.cjs' });
  assert.match(brief, /^## Environnement préparé\n- Dépendances : installées par Cockpit \(npm ci\)\./);
  assert.match(brief, /commit abcdef1.*échecs existants avant ton travail.*10\/12/s);
  assert.match(brief, /## Vérification\n- Pendant le travail : lance les tests ciblés[\s\S]*suite complète une fois, comparée aux tests de départ/);
  assert.match(brief, /node \/opt\/cockpit\/scripts\/visual-check\.cjs --path \/ -- /);
  assert.match(env.environmentBrief({ testable: true, baseline: { sha: 'abc', ok: true, passed: 3, total: 3 } }), /tous réussis \(3\/3\)/);
  assert.doesNotMatch(env.environmentBrief({ testable: false }), /visual-check/);
});

// Intégration : le lancement répond tout de suite, la préparation se voit dans la chronologie, la baseline n'est mesurée qu'une fois.
test('direct runs prepare the worktree asynchronously before the engine, once per commit', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const seen = { install: 0, baseline: 0 };
  const taskEnv = {
    plan: () => ({ label: 'npm ci' }), testScript: () => true,
    install: async () => { seen.install++; await gate; return { status: 'installed', label: 'npm ci', durationMs: 2000 }; },
    baseline: async (cwd, sha) => { seen.baseline++; return { sha, at: new Date().toISOString(), ok: false, passed: 10, failed: 2, total: 12, summary: 'ℹ fail 2' }; }
  };
  const { project, create, launch, until, lastDone, codexCalls: calls, task } = await setup(t, { taskEnv, codexEnabled: true });
  const p = await project('alpha', { engine: 'codex' }), x = await create(p.id);
  const started = await launch(x.id);
  assert.equal(started.status, 202, 'la réponse n’attend pas l’installation');
  await until(x.id, v => v.runs[0].events.some(e => e.text === 'Préparation des dépendances… (npm ci)'));
  assert.equal(calls().length, 0, 'le moteur attend la préparation');
  release();
  const done = await lastDone(x.id), texts = done.runs[0].events.map(e => e.text);
  assert.ok(texts.includes('Dépendances installées (npm ci, 2 s)'), texts.join(' | '));
  assert.ok(texts.includes('Tests de départ : échecs existants (10/12 réussis)'));
  assert.equal(done.direct.baseline.sha, done.direct.baseSha); assert.equal(done.direct.baseline.total, 12);
  assert.match(calls()[0].input, /## Environnement préparé\n- Dépendances : installées par Cockpit \(npm ci\)\.\n- Tests de départ .*échecs existants avant ton travail/);
  await launch(x.id, { note: 'encore', kind: 'reprise' }); await until(x.id, v => v.runs[1]?.status === 'succeeded');
  assert.equal(seen.baseline, 1, 'baseline pas relancée pour le même commit');
  assert.doesNotMatch(calls()[1].input, /Environnement préparé/, 'suite de session : message court');
  assert.ok((await task(x.id)).direct.deps.status === 'installed');
});

test('stopping during preparation aborts it and never starts the engine', async t => {
  let aborted = false, hang = true;
  const taskEnv = { plan: () => ({ label: 'npm ci' }), testScript: () => false, baseline: async () => null,
    install: (cwd, { signal }) => hang ? new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'aborted', label: 'npm ci' }); })) : null };
  const { project, create, launch, until, ui, codexCalls: calls } = await setup(t, { taskEnv, codexEnabled: true });
  const p = await project('alpha', { engine: 'codex' }), x = await create(p.id);
  await launch(x.id); await until(x.id, v => v.runs[0].events.some(e => /Préparation/.test(e.text)));
  assert.equal((await ui('tasks/' + x.id + '/stop', 'POST', {})).status, 200);
  const done = await until(x.id, v => v.runs[0].status === 'interrupted');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(aborted, true); assert.equal(calls().length, 0); assert.match(done.runs[0].error, /avant le démarrage du moteur/);
  // La session choisie par Cockpit n'a jamais existé chez Claude : « Relancer » en ouvre une nouvelle au lieu de la reprendre.
  assert.equal(done.direct.sessionId, undefined);
  hang = false; await launch(x.id, { kind: 'retry' }); await until(x.id, v => v.runs[1]?.status === 'succeeded');
  assert.ok(!calls()[0].args.includes('resume'));
});

test('a restart during preparation does not leave a session that Claude never opened', async t => {
  const taskEnv = { plan: () => ({ label: 'npm ci' }), testScript: () => false, baseline: async () => null,
    install: (cwd, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'aborted', label: 'npm ci' }))) };
  const { project, create, launch, until, codexCalls: calls, services, make } = await setup(t, { taskEnv, codexEnabled: true });
  const p = await project('alpha', { engine: 'codex' }), x = await create(p.id);
  await launch(x.id); await until(x.id, v => v.runs[0].events.some(e => /Préparation/.test(e.text)));
  services[0].close(); await new Promise(r => setTimeout(r, 100));
  services.push(make());
  const done = services[1].snapshot().tasks.find(v => v.id === x.id);
  assert.equal(done.runs[0].status, 'interrupted'); assert.equal(calls().length, 0);
  assert.equal(done.direct.sessionId, undefined);
});

test('the limit of simultaneous runs comes from COCKPIT_MAX_PARALLEL (2 by default, 1 to 8)', () => {
  const { maxParallelFromEnv } = require('../direct-harness.cjs');
  assert.equal(maxParallelFromEnv({}), 2); assert.equal(maxParallelFromEnv({ COCKPIT_MAX_PARALLEL: '4' }), 4);
  assert.equal(maxParallelFromEnv({ COCKPIT_MAX_PARALLEL: '50' }), 8); assert.equal(maxParallelFromEnv({ COCKPIT_MAX_PARALLEL: '0' }), 2);
  assert.equal(maxParallelFromEnv({ COCKPIT_MAX_PARALLEL: 'abc' }), 2);
});
