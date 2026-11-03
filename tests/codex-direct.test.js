const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const codex = require('../codex-direct.cjs');
const { setup, git, arg } = require('./helpers/direct-setup.js');

const DANGER = /dangerously|danger-full-access|bypass/;

test('Codex as the project engine: one session, workspace-write sandbox, project rules in the request, honest counters', async t => {
  const { ui, project, create, launch, lastDone, codexCalls, calls, root, dir } = await setup(t, { codexEnabled: true });
  const p = await project('alpha', { engine: 'codex', direct: { codexModel: 'gpt-5.5-codex', codexEffort: 'high' } });
  assert.equal(p.engine, 'codex');
  const task = await create(p.id, { expected: 'feature-codex.txt' });
  assert.equal((await launch(task.id)).status, 202);
  let done = await lastDone(task.id);
  const [call] = codexCalls(), run = done.runs[0];
  assert.equal(calls().length, 0, 'Claude is not called'); assert.equal(codexCalls().length, 1, 'a single call');
  assert.deepEqual(call.args.slice(0, 2), ['exec', '--json']); assert.equal(call.sandbox, 'workspace-write'); assert.equal(arg(call.args, '--sandbox'), 'workspace-write');
  for (const c of ['approval_policy="never"', 'web_search="disabled"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_slash_tmp=true', 'model_reasoning_effort="high"']) assert.ok(call.args.includes(c), c);
  assert.ok(call.args.includes('--ignore-user-config') && call.args.includes('--ignore-rules'));
  assert.equal(arg(call.args, '--model'), 'gpt-5.5-codex'); assert.equal(call.args.at(-1), '-', 'the request goes through stdin');
  assert.ok(!call.args.some(a => DANGER.test(a)) && !call.args.some(a => a.includes('Ajoute feature.txt')));
  // Codex ne lit pas CLAUDE.md : les règles du projet sont jointes à la première demande, avec la consigne de ne pas commiter.
  assert.match(call.input, /^## Consignes du projet\n<!-- Généré par Cockpit/); assert.match(call.input, /Plafonner toute sortie/); assert.match(call.input, /Ne fais pas de commit/);
  assert.match(call.input, /Tâche AL-1 — « Tâche \d+ »\n\nAjoute feature\.txt\n\n## Résultat attendu\nfeature-codex\.txt/);
  assert.ok(call.cwd.startsWith(path.join(dir, 'worktrees')));
  assert.deepEqual(call.env, { CODEX_HOME: path.join(dir, 'codex-home'), PATH: true }, 'dedicated CODEX_HOME, no API key, token or Claude OAuth');
  assert.equal(run.engine, 'codex'); assert.equal(run.outcome, 'result'); assert.equal(done.status, 'review'); assert.equal(done.engine, 'codex');
  assert.match(run.sessionId, /^[0-9a-f-]{36}$/); assert.equal(done.direct.sessionId, run.sessionId); assert.equal(done.direct.engine, 'codex');
  const m = run.metrics;
  assert.deepEqual([m.engine, m.model, m.input, m.cacheRead, m.output, m.reasoning, m.turns, m.tools], ['codex', 'gpt-5.5-codex', 200, 1000, 80, 30, 1, 2]);
  assert.deepEqual([m.cacheWrite, m.calls, m.costUsd, m.apiMs], [null, null, null, null], 'counters Codex does not expose are never invented');
  assert.deepEqual(run.summary.uncommitted, ['?? feature-codex.txt'], 'Codex cannot commit: Cockpit reports the change as uncommitted');
  assert.equal(git(path.join(root, 'alpha'), 'status', '--porcelain'), '', 'the main copy is untouched');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'data', 'projects.json'), 'utf8'), /ghp_abcdef|sk-openai-should|codex-should-not|oauth-keep/);
  // Suite : même session (exec resume), même bac à sable, message court.
  await launch(task.id, { kind: 'reprise', note: 'Ajoute un test' }); done = await lastDone(task.id);
  const next = codexCalls()[1];
  assert.deepEqual(next.args.slice(0, 3), ['exec', 'resume', '--json']); assert.equal(next.args.at(-2), run.sessionId); assert.ok(next.args.includes('sandbox_mode="workspace-write"')); assert.ok(!next.args.includes('--sandbox'));
  assert.equal(next.input, 'Suite (AL-1) :\nAjoute un test'); assert.equal(next.cwd, call.cwd);
  assert.equal(await ui('state').then(r => r.body.engineByTask[task.id]), 'codex');
});

test('Codex plan option is read-only; a lost or unauthenticated login is reported, not hidden', async t => {
  const { project, create, launch, lastDone, codexCalls, codexMode } = await setup(t, { codexEnabled: true });
  const p = await project('alpha', { engine: 'codex' }), task = await create(p.id, { planFirst: true });
  await launch(task.id); let done = await lastDone(task.id);
  assert.equal(codexCalls()[0].sandbox, 'read-only'); assert.match(codexCalls()[0].input, /## Phase : plan/); assert.equal(done.runs[0].outcome, 'plan');
  await launch(task.id, { kind: 'execute' }); done = await lastDone(task.id);
  assert.equal(codexCalls()[1].sandbox, 'workspace-write'); assert.equal(codexCalls()[1].args.at(-2), done.runs[0].sessionId);
  const other = await create(p.id); codexMode('auth'); await launch(other.id); done = await lastDone(other.id);
  assert.equal(done.runs[0].status, 'failed'); assert.match(done.runs[0].error, /401|authentication/i); assert.equal(done.status, 'blocked');
});

test('Codex disabled or CODEX_HOME inside a project folder is refused', async t => {
  const { project, create, launch, ui, dir, root } = await setup(t);
  const p = await project('alpha', { engine: 'codex' }), task = await create(p.id);
  const r = await launch(task.id); assert.equal(r.status, 403); assert.match(r.body.error, /Codex direct est désactivé/);
  const engine = codex.createEngine({ enabled: true, command: process.execPath, codexHome: path.join(root, 'alpha', '.codex'), workspacesRoot: root, worktreeRoot: path.join(dir, 'wt') });
  const result = await engine.run({ runId: 'x', args: [], cwd: dir, prompt: '', timeoutMs: 1000 });
  assert.match(result.spawnError, /CODEX_HOME .* est dans le dossier des projets/);
  const safe = codex.createEngine({ enabled: true, command: process.execPath, codexHome: path.join(dir, 'ch'), workspacesRoot: root, worktreeRoot: path.join(dir, 'wt') });
  assert.throws(() => safe.run({ runId: 'y', args: [codex.FORBIDDEN], cwd: dir, prompt: '', timeoutMs: 1000 }), /Option interdite/);
  assert.throws(() => codex.buildArgs({ mode: 'work', fresh: false, sessionId: '../x' }), /Identifiant de session Codex invalide/);
  await ui('state');
});

test('switching the engine of a started task opens a new session with a short handoff', async t => {
  const { project, create, launch, lastDone, calls, codexCalls, ui } = await setup(t, { codexEnabled: true });
  const p = await project('alpha'), task = await create(p.id);
  await launch(task.id); let done = await lastDone(task.id);
  assert.equal((await ui('tasks/' + task.id, 'PATCH', { engine: 'codex' })).body.engine, 'codex');
  await launch(task.id, { kind: 'reprise', note: 'Continue avec Codex' }); done = await lastDone(task.id);
  assert.equal(calls().length, 1); const call = codexCalls()[0];
  assert.deepEqual(call.args.slice(0, 2), ['exec', '--json'], 'a new session, not a resume');
  assert.match(call.input, /## Reprise\nCette tâche a déjà été travaillée avec Claude Code \(changement de moteur\)[\s\S]*git status[\s\S]*Dernier résultat connu :\nFait : feature\.txt/);
  assert.match(call.input, /## Précisions\nContinue avec Codex/);
  assert.equal(done.direct.engine, 'codex'); assert.equal(done.direct.cwd, calls()[0].cwd, 'same worktree');
});
