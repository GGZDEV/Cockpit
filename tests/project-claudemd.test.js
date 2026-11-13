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

test('project context is complete and has no imposed work or response method', () => {
  const huge = 'x'.repeat(50000), instructions = Array.from({ length: 500 }, (_, i) => 'règle ' + i).join('\n');
  const text = md.render({ name: 'N', context: { objective: huge, instructions, environment: huge } }, md.analyze(__dirname));
  assert.ok(text.includes(huge)); assert.match(text, /règle 499/);
  assert.doesNotMatch(text, /Règles de travail|suite complète|Réponse finale courte|Un seul commit|Plafonner/);
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
  assert.equal(await md.seedWorktree(r, wt), true); assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8'));
  fs.writeFileSync(path.join(wt, 'CLAUDE.md'), 'local'); assert.equal(await md.seedWorktree(r, wt), false); assert.equal(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), 'local');
  git(wt, 'add', '-A'); assert.equal(git(wt, 'status', '--porcelain'), '', 'git add -A inside the worktree never picks the file up');
});

test('environment sync refreshes managed settings and rules, preserves task edits/tracked files, removes only owned deleted files', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p'), { '.claude/rules/tracked.md': 'tracked branch rule' });
  let state = await md.prepare({ name: 'P', context: { instructions: 'First' } }, r);
  fs.mkdirSync(path.join(r, '.claude/skills/local'), { recursive: true });
  fs.writeFileSync(path.join(r, '.claude/skills/local/SKILL.md'), 'skill-v1');
  fs.writeFileSync(path.join(r, '.mcp.json'), '{"mcpServers":{}}');
  const wt = path.join(dir, 'wt'); git(r, 'worktree', 'add', '-q', '-b', 'env', wt);
  await md.seedWorktree(r, wt, state);
  assert.equal(fs.readFileSync(path.join(wt, '.claude/skills/local/SKILL.md'), 'utf8'), 'skill-v1');
  fs.writeFileSync(path.join(wt, '.claude/rules/tracked.md'), 'task branch rule');
  fs.writeFileSync(path.join(wt, '.mcp.json'), 'task specific');
  fs.writeFileSync(path.join(r, '.claude/skills/local/SKILL.md'), 'skill-v2');
  state = await md.prepare({ name: 'P', context: { instructions: 'Updated' } }, r, state);
  await md.seedWorktree(r, wt, state);
  assert.match(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), /Updated/);
  assert.equal(fs.readFileSync(path.join(wt, '.claude/skills/local/SKILL.md'), 'utf8'), 'skill-v2');
  assert.equal(fs.readFileSync(path.join(wt, '.mcp.json'), 'utf8'), 'task specific');
  assert.equal(fs.readFileSync(path.join(wt, '.claude/rules/tracked.md'), 'utf8'), 'task branch rule');
  fs.unlinkSync(path.join(r, '.claude/skills/local/SKILL.md'));
  await md.seedWorktree(r, wt, state);
  assert.ok(!fs.existsSync(path.join(wt, '.claude/skills/local/SKILL.md')));
  assert.ok(!git(wt, 'status', '--porcelain').includes('.mcp.json'));
});

test('tracked CLAUDE.md gets complete Cockpit context separately without overwrites', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p'), { 'CLAUDE.md': '# Team rules' });
  let state = await md.prepare({ name: 'P', context: { instructions: 'i'.repeat(3000) + 'END' } }, r);
  const rule = path.join(r, '.claude/rules/cockpit-project.md');
  assert.match(fs.readFileSync(rule, 'utf8'), /i{3000}END/);
  state = await md.prepare({ name: 'P', context: { instructions: 'new rule' } }, r, state);
  assert.match(fs.readFileSync(rule, 'utf8'), /new rule/);
  assert.equal(fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8'), '# Team rules');
  fs.writeFileSync(rule, 'manually edited');
  await md.prepare({ name: 'P', context: { instructions: 'do not overwrite' } }, r, state);
  assert.equal(fs.readFileSync(rule, 'utf8'), 'manually edited');
});

test('legacy worktree copies upgrade using previously generated root hashes', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p'));
  let state = await md.prepare({ name: 'Old' }, r);
  const wt = path.join(dir, 'wt'); git(r, 'worktree', 'add', '-q', '-b', 'old', wt);
  fs.copyFileSync(path.join(r, 'CLAUDE.md'), path.join(wt, 'CLAUDE.md'));
  state = await md.prepare({ name: 'New' }, r, state);
  await md.seedWorktree(r, wt, state);
  assert.match(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8'), /# New/);
});

test('project preparation never writes through user symlinks', async t => {
  const dir = tmp(t), r = repo(path.join(dir, 'p'), { 'CLAUDE.md': '# Team' });
  const outside = path.join(dir, 'external'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(r, '.claude'), 'dir');
  await md.prepare({ name: 'P', context: { instructions: 'Do not write outside' } }, r);
  assert.deepEqual(fs.readdirSync(outside), []);
});
