const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const claude = require('../claude-direct.cjs');
const harness = require('../direct-harness.cjs');
const { setup, git, arg } = require('./helpers/direct-setup.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('creating a project prepares the folder: short CLAUDE.md, never committed, engine Claude Code by default', async t => {
  const { project, root, ui } = await setup(t, { repos: { alpha: { 'tests/a.test.js': '', 'src/x.js': '' } } });
  const p = await project('alpha', { description: 'Mon projet', context: { repository: 'https://github.com/ggzdev/alpha', objective: 'Objectif alpha', instructions: 'Répondre en français.' } });
  assert.equal(p.engine, 'claude', 'new projects use Claude Code');
  assert.equal(p.claudeMd.status, 'generated');
  const file = path.join(root, 'alpha', 'CLAUDE.md'), body = fs.readFileSync(file, 'utf8');
  assert.ok(body.length < 2600, 'short and stable: ' + body.length);
  assert.match(body, /Généré par Cockpit/); assert.match(body, /# alpha/); assert.match(body, /Objectif : Objectif alpha/);
  assert.match(body, /Tests : `npm test`/); assert.match(body, /src\/ \(code source\)/); assert.match(body, /Répondre en français/);
  assert.match(body, /Plafonner toute sortie/); assert.match(body, /STATUT: BLOQUÉ/);
  assert.equal(git(path.join(root, 'alpha'), 'status', '--porcelain'), '', 'ignored locally: never committed by accident');
  assert.match(fs.readFileSync(path.join(root, 'alpha', '.git', 'info', 'exclude'), 'utf8'), /^\/CLAUDE\.md$/m);
  // Régénération : permise tant que le fichier n'a pas été retouché, refusée ensuite.
  const again = await ui('projects/' + p.id + '/claude-md', 'POST', {});
  assert.equal(again.status, 200); assert.equal(again.body.claudeMd.status, 'generated');
  fs.appendFileSync(file, '\n- règle ajoutée à la main\n');
  const refused = await ui('projects/' + p.id + '/claude-md', 'POST', {});
  assert.equal(refused.status, 409); assert.match(refused.body.error, /Cockpit ne l’écrase pas/);
  assert.match(fs.readFileSync(file, 'utf8'), /règle ajoutée à la main/);
});

test('an existing CLAUDE.md of the repository is never touched', async t => {
  const { project, root } = await setup(t, { repos: { alpha: { 'CLAUDE.md': '# Mes règles\n' } } });
  const p = await project('alpha');
  assert.equal(p.claudeMd.status, 'existing');
  assert.equal(fs.readFileSync(path.join(root, 'alpha', 'CLAUDE.md'), 'utf8'), '# Mes règles\n');
  assert.equal(git(path.join(root, 'alpha'), 'status', '--porcelain'), '');
});

test('a task goes straight to Claude Code: one call, lean arguments, task folder, no OpenClaw', async t => {
  const { project, create, launch, lastDone, calls, root, dir, feed } = await setup(t);
  const p = await project('alpha'), task = await create(p.id, { expected: 'feature.txt existe', criteria: 'Tests verts' });
  const started = await launch(task.id);
  assert.equal(started.status, 202); assert.equal(started.body.run.engine, 'claude');
  const done = await lastDone(task.id), [call] = calls(), run = done.runs[0];
  assert.equal(calls().length, 1, 'a single call: no analysis, plan, approval or receipt chain');
  assert.equal(feed.sends.length, 0, 'OpenClaw is not involved');
  const a = call.args;
  assert.equal(a[0], '-p'); assert.equal(arg(a, '--output-format'), 'stream-json'); assert.ok(a.includes('--verbose'));
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--disable-slash-commands') && a.includes('--exclude-dynamic-system-prompt-sections'));
  assert.equal(arg(a, '--tools'), 'default', 'same tools as Claude Code on the desktop'); assert.equal(arg(a, '--permission-mode'), 'acceptEdits');
  assert.equal(arg(a, '--model'), 'claude-sonnet-5-5', 'Sonnet 5.5 by default');
  assert.ok(!a.includes('--append-system-prompt') && !a.includes('--system-prompt'), 'no custom system prompt: project rules live in CLAUDE.md');
  assert.ok(!a.includes('--bare') && !a.includes('--dangerously-skip-permissions'), 'OAuth kept, permissions kept');
  assert.deepEqual(JSON.parse(arg(a, '--settings')), { autoMemoryEnabled: false, disableAllHooks: true, includeGitInstructions: false, enabledPlugins: {} });
  assert.match(arg(a, '--session-id'), UUID); assert.equal(arg(a, '--session-id'), a.at(-1), 'session is the last argument');
  const allowed = a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools')), denied = a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--max-budget-usd'));
  assert.ok(allowed.includes('Bash') && allowed.includes('WebFetch'), 'any command (node, python…) like Claude Code; denials below still win');
  assert.ok(a.slice(a.indexOf('--add-dir') + 1).includes(require('node:os').tmpdir()), 'temporary folder usable for throwaway scripts');
  for (const d of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(ssh:*)', 'Bash(npm publish:*)']) assert.ok(denied.includes(d), d);
  assert.equal(arg(a, '--max-budget-usd'), '5');
  assert.ok(!a.some(x => x.includes('Ajoute feature.txt')), 'the request goes through stdin, never in argv');
  // Demande courte : la tâche seulement, ni contexte de projet ni cadre.
  assert.match(call.input, /^Tâche AL-1 — « Tâche \d+ »\n\nAjoute feature\.txt\n\n## Résultat attendu\nfeature\.txt existe\n\n## Critères de réussite\nTests verts$/);
  assert.ok(call.input.length < 300 && !/Objectif alpha|Cadre|publi/i.test(call.input));
  // Dossier de travail : worktree de la tâche, avec le CLAUDE.md du projet ; la copie principale reste intacte.
  assert.ok(call.cwd.startsWith(path.join(dir, 'worktrees')) && call.cwd.endsWith('AL-1'));
  assert.match(call.claudeMd, /Généré par Cockpit/);
  assert.equal(git(path.join(root, 'alpha'), 'status', '--porcelain'), ''); assert.ok(!fs.existsSync(path.join(root, 'alpha', 'feature.txt')));
  assert.deepEqual(call.env, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-keep', PATH: true }, 'no GitHub token or API key reaches the engine; the subscription login is kept');
  // Résultat, relevé Git et compteurs.
  assert.equal(run.status, 'succeeded'); assert.equal(run.outcome, 'result'); assert.equal(done.status, 'review');
  assert.equal(run.result, 'Fait : feature.txt ajouté et commité.');
  assert.equal(run.summary.branch, done.direct.branch); assert.match(done.direct.branch, /^cockpit\/al-1-/);
  assert.deepEqual(run.summary.files, ['A\tfeature.txt']); assert.deepEqual(run.summary.commits.map(c => c.replace(/^\w+ /, '')), ['Fonction ajoutée']); assert.deepEqual(run.summary.uncommitted, []);
  const m = run.metrics;
  // Totaux du résultat final (tous les modèles, auxiliaire compris) : le flux ne donne pas les sorties complètes. Appels et premier contexte : vus dans le flux.
  assert.deepEqual([m.engine, m.model, m.input, m.cacheWrite, m.cacheRead, m.output, m.calls, m.firstCallContext], ['claude', 'claude-sonnet-5-5', 321, 1300, 2000, 202, 3, 1010]);
  assert.equal(m.totalTokens, 321 + 1300 + 2000 + 202); assert.equal(m.source, 'modelUsage'); assert.equal(m.byModel.length, 2);
  assert.ok(run.events.some(e => e.text === 'Bash · git commit -m x --token=***'), 'secrets masked in the activity log');
});

test('the same session is resumed on every message: same folder, short follow-up, cumulative cost not counted twice', async t => {
  const { project, create, launch, lastDone, calls } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  await launch(task.id); await lastDone(task.id);
  await launch(task.id, { kind: 'reprise', note: 'Ajoute aussi un test' }); const done = await lastDone(task.id);
  const [first, second] = calls();
  assert.equal(arg(second.args, '--resume'), arg(first.args, '--session-id'), 'same session'); assert.ok(!second.args.includes('--session-id'));
  assert.equal(second.cwd, first.cwd);
  assert.equal(second.input, 'Suite (AL-1) :\nAjoute aussi un test', 'follow-up only: the instructions are not resent');
  const [r1, r2] = done.runs;
  assert.ok(Math.abs(r1.metrics.costUsd - 0.0123) < 1e-9 && Math.abs(r2.metrics.costUsd - 0.0123) < 1e-9, 'the cumulative cost announced by a resumed session is reduced to this run');
  assert.ok(Math.abs(done.direct.costTotal - 0.0246) < 1e-9);
  for (const run of [r1, r2]) assert.deepEqual([run.metrics.input, run.metrics.cacheRead, run.metrics.output, run.metrics.totalTokens], [321, 2000, 202, 3823], 'tokens too are reduced to this run (the session reports cumulative totals)');
  assert.deepEqual(done.direct.usage, { input: 642, cacheWrite: 2600, cacheRead: 4000, output: 404 });
  assert.equal(arg(second.args, '--max-budget-usd'), String(5 + 0.0123), 'the cap of a resumed run is added to what the conversation already spent');
  assert.equal(done.runs.length, 2); assert.equal(done.direct.sessionId, arg(first.args, '--session-id'));
});

test('model: Sonnet 5.5 by default, adjustable per project and per task, never an option in disguise', async t => {
  const { project, create, launch, lastDone, calls, ui } = await setup(t);
  const p = await project('alpha', { direct: { model: 'claude-opus-5-5', effort: 'medium' } });
  assert.equal(p.direct.model, 'claude-opus-5-5');
  const t1 = await create(p.id); await launch(t1.id); await lastDone(t1.id);
  assert.equal(arg(calls()[0].args, '--model'), 'claude-opus-5-5'); assert.equal(arg(calls()[0].args, '--effort'), 'medium');
  const t2 = await create(p.id, { model: 'claude-haiku-5-5' }); await launch(t2.id); await lastDone(t2.id);
  assert.equal(arg(calls()[1].args, '--model'), 'claude-haiku-5-5', 'the task wins');
  assert.equal((await ui('tasks/' + t2.id, 'PATCH', { model: '--dangerously-skip-permissions' })).body.model, '', 'a model name can never be an option');
  const q = await project('beta'); assert.equal(q.direct, undefined);
  const t3 = await create(q.id); await launch(t3.id); await lastDone(t3.id);
  assert.equal(arg(calls()[2].args, '--model'), 'claude-sonnet-5-5');
});

test('plan first is an option of the task (off by default): read-only plan, remarks revise it, then "execute" resumes the same session', async t => {
  const { project, create, launch, lastDone, calls, ui } = await setup(t);
  const p = await project('alpha');
  const plain = await create(p.id); await launch(plain.id); await lastDone(plain.id);
  assert.equal(arg(calls()[0].args, '--permission-mode'), 'acceptEdits', 'no plan unless asked');
  assert.equal((await launch(plain.id, { kind: 'execute' })).status, 409, 'nothing to execute');

  const task = await create(p.id, { planFirst: true });
  await launch(task.id); let done = await lastDone(task.id);
  const planCall = calls()[1];
  assert.equal(arg(planCall.args, '--permission-mode'), 'plan'); assert.equal(arg(planCall.args, '--tools'), 'Read,Glob,Grep'); assert.ok(!planCall.args.includes('--allowedTools'));
  assert.match(planCall.input, /## Phase : plan\nNe modifie rien/);
  assert.equal(done.runs[0].outcome, 'plan'); assert.equal(done.status, 'review'); assert.match(done.runs[0].result, /Ajouter feature\.txt/); assert.equal(done.direct.planPending, true);
  assert.deepEqual(done.runs[0].summary.files, [], 'nothing modified by the plan');
  // Remarque pendant que le plan est en attente : le plan est révisé, rien n'est exécuté.
  await launch(task.id, { kind: 'reprise', note: 'Sans toucher au README' }); done = await lastDone(task.id);
  assert.equal(arg(calls()[2].args, '--permission-mode'), 'plan'); assert.equal(arg(calls()[2].args, '--resume'), arg(planCall.args, '--session-id'));
  // Exécution : même session, mode normal, sans réécrire les consignes.
  await launch(task.id, { kind: 'execute', note: 'Vas-y' }); done = await lastDone(task.id);
  const exec = calls()[3];
  assert.equal(arg(exec.args, '--resume'), arg(planCall.args, '--session-id')); assert.equal(arg(exec.args, '--permission-mode'), 'acceptEdits'); assert.equal(arg(exec.args, '--tools'), 'default');
  assert.equal(exec.input, 'Suite (AL-2) :\nVas-y\n\nLe plan est accepté : exécute-le (ma remarque éventuelle ci-dessus prévaut).');
  assert.equal(done.runs[2].outcome, 'result'); assert.equal(done.direct.planPending, false); assert.equal(done.direct.workStarted, true);
  assert.ok(!('plan' in done) && !('claude' in done), 'no plan record, approval or receipt chain');
});

test('a question blocks the task, the answer resumes the same session; explicit failure is reported', async t => {
  const { project, create, launch, lastDone, calls, mode } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  mode('blocked'); await launch(task.id); let done = await lastDone(task.id);
  assert.equal(done.status, 'blocked'); assert.equal(done.question, 'Quelle branche de base ?'); assert.equal(done.runs[0].outcome, 'question');
  mode('ok'); await launch(task.id, { kind: 'answer', note: 'main' }); done = await lastDone(task.id);
  assert.equal(calls()[1].input, 'Suite (AL-1) :\nmain'); assert.equal(done.status, 'review'); assert.equal(done.question, '');
  mode('fail-marker'); await launch(task.id, { kind: 'reprise', note: 'encore' }); done = await lastDone(task.id);
  assert.equal(done.runs.at(-1).status, 'failed'); assert.equal(done.runs.at(-1).error, 'Impossible : dépendance absente.'); assert.equal(done.status, 'blocked');
});

test('errors, crashes and budget are reported without leaking secrets; a lost session restarts cleanly with full instructions', async t => {
  const { project, create, launch, lastDone, calls, mode, dir } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  mode('crash'); await launch(task.id); let done = await lastDone(task.id);
  assert.equal(done.runs[0].status, 'failed'); assert.doesNotMatch(JSON.stringify(done), /abcdef123456789/); assert.match(done.runs[0].error, /token=\*\*\*/);
  mode('budget'); await launch(task.id, { kind: 'retry' }); done = await lastDone(task.id);
  assert.match(done.runs.at(-1).error, /Budget de l’exécution atteint/);
  // Session perdue : la reprise échoue proprement, la suivante ouvre une nouvelle session avec les consignes complètes.
  mode('ok'); await launch(task.id, { kind: 'retry' }); await lastDone(task.id);
  fs.writeFileSync(path.join(dir, 'fake', 'sessions.json'), '{}');
  await launch(task.id, { kind: 'reprise', note: 'suite' }); done = await lastDone(task.id);
  assert.match(done.runs.at(-1).error, /session Claude Code de cette tâche est introuvable/); assert.equal(done.direct.sessionId, undefined);
  const n = calls().length;
  await launch(task.id, { kind: 'retry' }); done = await lastDone(task.id);
  const call = calls().at(n);
  assert.match(arg(call.args, '--session-id'), UUID); assert.match(call.input, /## Reprise[\s\S]*session précédente introuvable[\s\S]*git status/);
  assert.equal(done.runs.at(-1).status, 'succeeded');
});

test('limits: executions per task, budget per task, parallel runs', async t => {
  const { project, create, launch, lastDone, mode, ui } = await setup(t);
  const p = await project('alpha', { direct: { maxRuns: 2 } }), task = await create(p.id);
  await launch(task.id); await lastDone(task.id); await launch(task.id, { kind: 'reprise', note: 'a' }); await lastDone(task.id);
  const r = await launch(task.id, { kind: 'reprise', note: 'b' }); assert.equal(r.status, 409); assert.match(r.body.error, /Limite atteinte : 2 exécutions/);
  const q = await project('beta', { direct: { maxBudgetUsd: 1, taskBudgetUsd: 0.55 } }), t2 = await create(q.id);
  mode('budget'); await launch(t2.id); await lastDone(t2.id);
  const b = await launch(t2.id, { kind: 'retry' }); assert.equal(b.status, 409); assert.match(b.body.error, /Budget de la tâche presque épuisé/);
  // Deux exécutions en parallèle au plus.
  mode('hang'); const a = await project('alpha'), t3 = await create(a.id), t4 = await create(a.id), t5 = await create(a.id);
  assert.equal((await launch(t3.id)).status, 202); assert.equal((await launch(t4.id)).status, 202);
  const third = await launch(t5.id); assert.equal(third.status, 409); assert.match(third.body.error, /Déjà 2 exécutions/);
  for (const x of [t3, t4]) await ui('tasks/' + x.id + '/stop', 'POST', {});
  await lastDone(t3.id); await lastDone(t4.id);
});

test('stopping a run kills the process, keeps the session and the folder; a restart marks open runs interrupted', async t => {
  const { project, create, launch, until, ui, mode, calls, make, services, engine } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  mode('hang'); await launch(task.id); await until(task.id, x => x.runs[0]?.status === 'started');
  assert.equal((await ui('tasks/' + task.id + '/stop', 'POST', {})).status, 200);
  let done = await until(task.id, x => x.runs[0].status === 'interrupted');
  assert.match(done.runs[0].error, /Arrêtée à votre demande/); assert.equal(done.status, 'blocked'); assert.ok(done.direct.sessionId);
  assert.equal((await ui('tasks/' + task.id + '/stop', 'POST', {})).status, 409);
  mode('ok'); await launch(task.id, { kind: 'retry' }); done = await until(task.id, x => x.runs[1]?.status === 'succeeded');
  assert.equal(arg(calls()[1].args, '--resume'), done.direct.sessionId, 'the stopped session is resumed');
  // Redémarrage pendant une exécution : interrompue, jamais renvoyée.
  mode('hang'); await launch(task.id, { kind: 'reprise', note: 'encore' }); await until(task.id, x => x.runs[2]?.status === 'started');
  const n = calls().length; services[0].close();
  while (engine.active.size) await new Promise(r => setTimeout(r, 20));
  services.push(make());
  done = (services[1].snapshot()).tasks.find(x => x.id === task.id);
  assert.equal(done.runs[2].status, 'interrupted'); assert.equal(calls().length, n, 'nothing is resent');
});

test('automatic fallback is off by default; when on, only after an unavailable engine that did nothing', async t => {
  const { project, create, launch, lastDone, mode, calls, codexCalls, codexMode } = await setup(t, { codexEnabled: true });
  const plain = await project('alpha'), t0 = await create(plain.id);
  mode('quota'); await launch(t0.id); let done = await lastDone(t0.id);
  assert.equal(done.runs.length, 1); assert.equal(done.status, 'blocked'); assert.equal(codexCalls().length, 0, 'no fallback unless the project asks');

  const p = await project('beta', { direct: { fallback: 'codex' } }), task = await create(p.id);
  mode('quota'); await launch(task.id); done = await lastDone(task.id);
  assert.equal(done.runs.length, 2); assert.equal(done.runs[0].status, 'failed'); assert.equal(done.runs[0].fallbackTo, 'codex');
  assert.equal(done.runs[1].engine, 'codex'); assert.equal(done.runs[1].status, 'succeeded'); assert.ok(done.runs[1].fallback);
  assert.equal(codexCalls()[0].cwd, calls()[1].cwd, 'same worktree'); assert.match(codexCalls()[0].input, /## Reprise[\s\S]*quota ou limite d’usage atteint/);
  assert.equal(done.direct.engine, 'codex');

  const t2 = await create(p.id); mode('tool-quota'); await launch(t2.id); done = await lastDone(t2.id);
  assert.equal(done.runs.length, 1, 'the engine had started working: no fallback'); assert.match(done.runs[0].error, /Secours Codex non lancé : le moteur avait commencé/);
  const t3 = await create(p.id); mode('ok'); await launch(t3.id); done = await lastDone(t3.id); assert.equal(done.runs.length, 1, 'no fallback on success');
});

test('old Claude Code versions: optional flags unknown to the installed binary are left out', async t => {
  const { project, create, launch, lastDone, calls, mode } = await setup(t);
  const p = await project('alpha', { direct: { effort: 'high' } }), task = await create(p.id);
  mode('old-cli'); await launch(task.id); await lastDone(task.id);
  const a = calls()[0].args;
  for (const f of ['--settings', '--max-budget-usd', '--exclude-dynamic-system-prompt-sections', '--effort']) assert.ok(!a.includes(f), f);
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--tools') && a.includes('--model'));
});

test('buildArgs: lists are always followed by an option, session id last, web tools in work mode only', () => {
  const a = claude.buildArgs({ mode: 'work', sessionId: 'S', fresh: false, settings: { allowedBash: ['git status', 'npm test'] }, addDirs: ['/tmp/att'] });
  assert.equal(a.at(-2), '--resume'); assert.equal(a.at(-1), 'S');
  assert.equal(arg(a, '--tools'), 'default');
  assert.deepEqual(a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--allowedTools') + 3), ['Bash(git status:*)', 'Bash(npm test:*)']);
  assert.ok(a[a.indexOf('--add-dir') + 3].startsWith('--'));
  assert.ok(!claude.buildArgs({ mode: 'plan', sessionId: 'S', fresh: true, settings: {} }).includes('WebSearch'));
  // Un projet qui a encore l'ancienne liste restreinte passe au nouveau défaut (toutes les commandes).
  const legacy = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse', 'git branch', 'git ls-files', 'npm test', 'npm run test', 'npm run lint', 'npm run build', 'node --test', 'node --check'];
  const b = claude.buildArgs({ mode: 'work', sessionId: 'S', fresh: true, settings: { allowedBash: legacy } });
  assert.deepEqual(b.slice(b.indexOf('--allowedTools') + 1, b.indexOf('--disallowedTools')), ['Bash', 'WebFetch', 'WebSearch']);
});

test('repository and worktree safety: ready copy under the projects folder, no symlink, one worktree per task, foreign folders refused', async t => {
  const { engine, root, dir } = await setup(t);
  const base = { id: 'abcdef12-0000', workspace: { status: 'ready', path: path.join(root, 'alpha') } };
  assert.equal(await engine.repository(base), fs.realpathSync(path.join(root, 'alpha')));
  await assert.rejects(engine.repository({ ...base, workspace: { status: 'cloning', path: base.workspace.path } }), /pas prête/);
  await assert.rejects(engine.repository({ ...base, workspace: { status: 'ready', path: root + '/alpha/../alpha' } }), /refusé/);
  fs.mkdirSync(path.join(dir, 'ailleurs')); await assert.rejects(engine.repository({ ...base, workspace: { status: 'ready', path: path.join(dir, 'ailleurs') } }), /dossier des projets/);
  fs.symlinkSync(path.join(root, 'alpha'), path.join(root, 'lien')); await assert.rejects(engine.repository({ ...base, workspace: { status: 'ready', path: path.join(root, 'lien') } }), /lien symbolique/);
  const repo = await engine.repository(base), task = { id: '123456-uuid', code: 'AL-7' };
  const wt = await engine.worktree(base, task, repo);
  assert.ok(wt.created && wt.baseSha && wt.branch === 'cockpit/al-7-123456'); assert.ok(wt.path.startsWith(path.join(dir, 'worktrees')));
  assert.deepEqual({ ...(await engine.worktree(base, task, repo)), created: undefined }, { path: wt.path, branch: wt.branch, created: undefined }, 'idempotent');
  fs.mkdirSync(path.join(dir, 'worktrees', 'beta-abcdef12', 'AL-8'), { recursive: true });
  const beta = { ...base, workspace: { status: 'ready', path: path.join(root, 'beta') } };
  await assert.rejects(engine.worktree(beta, { id: 'zzzzzz-uuid', code: 'AL-8' }, await engine.repository(beta)), /n’est pas le worktree de cette tâche/);
});

test('directSettings, redact, verdict and fallback decision', () => {
  const s = harness.directSettings({ model: '--bad', effort: 'nope', maxRuns: 999, timeoutMin: 0, fallback: 'openclaw', allowedBash: 'git status\n\nnpm test' });
  assert.equal(s.model, 'claude-sonnet-5-5'); assert.equal(s.effort, ''); assert.equal(s.maxRuns, 30); assert.equal(s.timeoutMin, 1); assert.equal(s.fallback, ''); assert.deepEqual(s.allowedBash, ['git status', 'npm test']);
  assert.equal(harness.redact('Authorization: Bearer abcdefghijklmnop and sk-ant-abcdefghijk'), 'Authorization: Bearer *** and sk-ant-***');
  assert.deepEqual(harness.verdict('Voilà\nSTATUT: TERMINÉ'), { status: 'done', body: 'Voilà' });
  assert.deepEqual(harness.verdict('Pas de marqueur'), { status: '', body: 'Pas de marqueur' });
  assert.equal(harness.verdict('Q ?\n**STATUT: BLOQUÉE**').status, 'blocked');
  const clean = { head: 'a', status: '' };
  assert.equal(harness.fallbackDecision({ result: {}, activity: 0, errorText: '429 rate limit', before: clean, after: clean }).ok, true);
  assert.equal(harness.fallbackDecision({ result: {}, activity: 1, errorText: '429', before: clean, after: clean }).ok, false);
  assert.equal(harness.fallbackDecision({ result: {}, activity: 0, errorText: '429', before: clean, after: { head: 'a', status: '?? x' } }).ok, false);
  assert.equal(harness.fallbackDecision({ result: { timedOut: true }, errorText: '429', before: clean, after: clean }).ok, false);
});


test('engine children do not inherit Cockpit server settings', () => {
  const env = harness.childEnv({ PATH: '/bin', COCKPIT_SERVER_MODE: '1', COCKPIT_DIRECT: '1', COCKPIT_WEB_PASSWORD_FILE: '/private/password', CLAUDE_CODE_OAUTH_TOKEN: 'login' }, { keep: ['CLAUDE_CODE_OAUTH_TOKEN'] });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'login');
  assert.equal(Object.keys(env).some(k => k.startsWith('COCKPIT_')), false);
});

test('closing a task publishes its branch: merged into main and pushed to GitHub by Cockpit, no agent', async t => {
  const { project, create, launch, lastDone, ui, root, dir } = await setup(t);
  const local = path.join(root, 'alpha'), origin = path.join(dir, 'origin-alpha.git');
  require('node:child_process').execFileSync('git', ['clone', '-q', '--bare', local, origin]);
  git(local, 'remote', 'add', 'origin', origin); git(local, 'fetch', '-q', 'origin');
  const p = await project('alpha'), task = await create(p.id);
  await launch(task.id); const done = await lastDone(task.id);
  assert.ok(done.direct.branch);
  const closed = await ui('tasks/' + task.id + '/accept', 'POST', {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body)); assert.equal(closed.body.status, 'done');
  assert.equal(closed.body.published.branch, 'main');
  assert.equal(git(origin, 'rev-parse', 'main'), closed.body.published.commit, 'pushed to the remote');
  assert.match(git(origin, 'log', '-1', '--format=%s', 'main'), /^AL-1 · /);
  assert.equal(git(origin, 'show', 'main:feature.txt').length > 0, true);
  // Rouverte puis close à nouveau sans nouveau travail : rien n'est refait.
  await ui('tasks/' + task.id, 'PATCH', { status: 'todo' });
  const again = await ui('tasks/' + task.id + '/accept', 'POST', {});
  assert.equal(again.status, 200); assert.equal(again.body.published.commit, closed.body.published.commit);
});

test('closing refuses to publish over uncommitted changes in the local copy, and leaves the task open', async t => {
  const { project, create, launch, lastDone, ui, root, dir } = await setup(t);
  const local = path.join(root, 'alpha'), origin = path.join(dir, 'origin-alpha.git');
  require('node:child_process').execFileSync('git', ['clone', '-q', '--bare', local, origin]);
  git(local, 'remote', 'add', 'origin', origin);
  const p = await project('alpha'), task = await create(p.id);
  await launch(task.id); await lastDone(task.id);
  fs.appendFileSync(path.join(local, 'README.md'), 'modif locale\n');
  const r = await ui('tasks/' + task.id + '/accept', 'POST', {});
  assert.equal(r.status, 409); assert.match(r.body.error, /non committées/);
  assert.notEqual((await ui('state')).body.tasks.find(x => x.id === task.id).status, 'done');
  assert.equal(git(origin, 'log', '--format=%s', 'main'), 'init');
});
