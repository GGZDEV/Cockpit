const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const md = require('../project-claudemd.cjs');
const { repo, git } = require('./helpers/direct-setup.js');

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-md-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('analysis detects the stack, the test command and the folders without any AI call', t => {
  const dir = tmp(t);
  const node = repo(path.join(dir, 'node'), { 'package.json': JSON.stringify({ name: 'n', engines: { node: '>=20' }, scripts: { test: 'node --test tests/', lint: 'eslint .' }, devDependencies: { typescript: '1', vite: '1' } }), 'pnpm-lock.yaml': '', 'src/a.ts': '', 'tests/a.test.js': '', '.editorconfig': 'indent_style = space\nindent_size = 4\n', 'node_modules/x/y.js': '' });
  const a = md.analyze(node);
  assert.deepEqual(a.stack.slice(0, 1), ['Node.js >=20']); assert.ok(a.stack.includes('TypeScript') && a.stack.includes('Vite'));
  assert.equal(a.commands.test, 'pnpm test'); assert.equal(a.commands.lint, 'pnpm lint');
  assert.ok(a.dirs.includes('src/ (code source)') && a.dirs.includes('tests/ (tests)') && !a.dirs.some(d => d.startsWith('node_modules')));
  assert.ok(a.notes.some(n => /4 espaces/.test(n)));
  const py = repo(path.join(dir, 'py'), { 'pyproject.toml': '[tool.pytest]\n[tool.ruff]\n', 'package.json': '{}' });
  fs.rmSync(path.join(py, 'package.json')); assert.deepEqual([md.analyze(py).stack[0], md.analyze(py).commands.test, md.analyze(py).commands.lint], ['Python', 'python3 -m pytest -q', 'ruff check .']);
  const rust = repo(path.join(dir, 'rs'), { 'Cargo.toml': '[package]\n' }); fs.rmSync(path.join(rust, 'package.json'));
  assert.equal(md.analyze(rust).commands.test, 'cargo test');
  const none = path.join(dir, 'none'); fs.mkdirSync(none); assert.deepEqual(md.analyze(none).stack, ['pile non détectée automatiquement']);
});

test('the generated file stays short whatever the project context, and is French', () => {
  const huge = 'x'.repeat(50000), a = md.analyze(__dirname);
  const text = md.render({ name: 'N'.repeat(500), description: huge, context: { objective: huge, instructions: Array.from({ length: 500 }, (_, i) => 'règle ' + i).join('\n'), environment: huge } }, a);
  assert.ok(text.length < 4500, 'bounded: ' + text.length);
  assert.match(text, /^<!-- Généré par Cockpit/); assert.match(text, /## Règles de travail \(économie de jetons\)/);
  assert.match(text, /jamais `git add -A`/); assert.match(text, /relire `git status`/);
});

test('prepare: generates once, ignores the file in Git, never overwrites an existing or edited file', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p')), project = { name: 'P', context: { objective: 'But' } };
  let state = await md.prepare(project, r, undefined, { now: () => 'T' });
  assert.equal(state.status, 'generated'); assert.equal(state.at, 'T'); assert.equal(git(r, 'status', '--porcelain'), '');
  await md.ensureExcluded(r); await md.ensureExcluded(r);
  assert.equal(fs.readFileSync(path.join(r, '.git', 'info', 'exclude'), 'utf8').split('\n').filter(l => l === '/CLAUDE.md').length, 1, 'excluded once');
  // Mise à jour d'un fichier non retouché : le contexte du projet est repris.
  state = await md.prepare({ ...project, context: { objective: 'Nouveau but' } }, r, state, { regenerate: true });
  assert.match(fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8'), /Nouveau but/);
  // Fichier retouché ou dépôt qui a son propre CLAUDE.md : intact.
  fs.appendFileSync(path.join(r, 'CLAUDE.md'), 'à moi\n');
  const kept = await md.prepare(project, r, state); assert.equal(kept.status, 'existing');
  await assert.rejects(md.prepare(project, r, state, { regenerate: true }), /ne l’écrase pas/);
  const own = repo(path.join(dir, 'own'), { 'CLAUDE.md': '# Équipe\n' });
  assert.equal((await md.prepare(project, own)).tracked, true); assert.equal(fs.readFileSync(path.join(own, 'CLAUDE.md'), 'utf8'), '# Équipe\n');
});

test('a task worktree receives the project file, but never overwrites its own', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p')); await md.prepare({ name: 'P' }, r);
  const wt = path.join(dir, 'wt'); git(r, 'worktree', 'add', '-q', '-b', 'b1', wt);
  assert.ok(!fs.existsSync(path.join(wt, 'CLAUDE.md')), 'untracked files are not part of a worktree');
  assert.equal(md.seedWorktree(r, wt), true); assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8'));
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local'); assert.equal(md.seedWorktree(r, wt), false); assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), 'local');
  git(wt, 'add', '-A'); assert.equal(git(wt, 'status', '--porcelain'), '', 'git add -A inside the worktree never picks the file up');
});
