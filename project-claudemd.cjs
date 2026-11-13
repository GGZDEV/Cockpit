'use strict';
// CLAUDE.md d'un projet : le seul fichier de consignes que Claude Code lit dans le dossier de travail.
// Claude Code n'a pas d'objet « projet » : un projet = un dossier de code + un CLAUDE.md + des sessions rangées par dossier.
// Cockpit prépare ce dossier à la création du projet : analyse légère du dépôt (aucun appel d'IA, aucun jeton), puis fichier court
// et stable (il fait partie du préfixe mis en cache par Claude : le modifier à chaque tâche coûterait des jetons).
// Un CLAUDE.md déjà présent dans le dépôt n'est jamais modifié ; un fichier généré puis retouché à la main n'est plus réécrit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { childEnv, clip } = require('./direct-harness.cjs');

const MARK = '<!-- Généré par Cockpit. Modifiez-le librement : Cockpit ne le réécrit plus dès que vous l’avez changé. -->';
const FILE = 'CLAUDE.md';
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cockpit-worktrees']);
const DIR_HINTS = { src: 'code source', lib: 'bibliothèque', app: 'application', public: 'fichiers servis', tests: 'tests', test: 'tests', __tests__: 'tests', spec: 'tests', docs: 'documentation',
  scripts: 'scripts', deploy: 'déploiement', config: 'configuration', server: 'serveur', client: 'client', api: 'API', components: 'composants', pages: 'pages', assets: 'ressources', data: 'données' };

const sha = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const read = (file, max = 40000) => { try { return fs.readFileSync(file, 'utf8').slice(0, max); } catch { return ''; } };
const json = file => { try { return JSON.parse(read(file, 200000)); } catch { return null; } };
const exists = (...parts) => fs.existsSync(path.join(...parts));

// ----- Analyse légère du dépôt ----------------------------------------------------------------
function analyze(repo) {
  const a = { stack: [], commands: {}, hints: {}, dirs: [], notes: [], title: '', summary: '' };
  const pkg = json(path.join(repo, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }, has = name => name in deps;
    const manager = exists(repo, 'pnpm-lock.yaml') ? 'pnpm' : exists(repo, 'yarn.lock') ? 'yarn' : exists(repo, 'bun.lockb') || exists(repo, 'bun.lock') ? 'bun' : 'npm';
    const scripts = pkg.scripts || {}, run = name => manager === 'npm' ? (name === 'test' ? 'npm test' : 'npm run ' + name) : manager + ' ' + name;
    a.stack.push('Node.js' + (pkg.engines?.node ? ' ' + pkg.engines.node : ''), pkg.type === 'module' ? 'modules ES' : 'CommonJS/ES selon les fichiers');
    for (const [dep, label] of [['typescript', 'TypeScript'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['next', 'Next.js'], ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'], ['electron', 'Electron'], ['tailwindcss', 'Tailwind']]) if (has(dep)) a.stack.push(label);
    if (!Object.keys(deps).length) a.notes.push('aucune dépendance npm : ne pas en ajouter sans nécessité');
    for (const key of ['test', 'build', 'lint', 'typecheck', 'check']) if (scripts[key]) a.commands[key] = run(key);
    if (/node --test/.test(scripts.test || '')) a.hints.test = 'un seul fichier : `node --test <fichier>.test.js`';
    a.title = pkg.name || ''; a.summary = pkg.description || '';
  }
  const py = read(path.join(repo, 'pyproject.toml')) + read(path.join(repo, 'requirements.txt'), 4000) + read(path.join(repo, 'setup.cfg'), 4000);
  if (py || exists(repo, 'setup.py')) { a.stack.push('Python'); if (/pytest/.test(py) || exists(repo, 'tests') || exists(repo, 'pytest.ini')) a.commands.test ||= 'python3 -m pytest -q'; if (/ruff/.test(py)) a.commands.lint ||= 'ruff check .'; }
  if (exists(repo, 'Cargo.toml')) { a.stack.push('Rust'); a.commands.test ||= 'cargo test'; a.commands.check ||= 'cargo check'; }
  if (exists(repo, 'go.mod')) { a.stack.push('Go'); a.commands.test ||= 'go test ./...'; a.commands.check ||= 'go vet ./...'; }
  if (exists(repo, 'pom.xml')) { a.stack.push('Java (Maven)'); a.commands.test ||= 'mvn -q test'; }
  if (exists(repo, 'build.gradle') || exists(repo, 'build.gradle.kts')) { a.stack.push('Java/Kotlin (Gradle)'); a.commands.test ||= './gradlew test'; }
  if (exists(repo, 'composer.json')) { a.stack.push('PHP'); a.commands.test ||= 'composer test'; }
  if (exists(repo, 'Gemfile')) { a.stack.push('Ruby'); a.commands.test ||= 'bundle exec rake test'; }
  try { if (fs.readdirSync(repo).some(f => /\.(sln|csproj)$/.test(f))) { a.stack.push('.NET'); a.commands.test ||= 'dotnet test'; } } catch { /* dossier illisible */ }
  const make = read(path.join(repo, 'Makefile'), 20000);
  for (const key of ['test', 'check', 'lint', 'build']) if (new RegExp('^' + key + '\\s*:', 'm').test(make)) a.commands[key] ||= 'make ' + key;
  if (!a.stack.length) a.stack.push('pile non détectée automatiquement');
  try {
    a.dirs = fs.readdirSync(repo, { withFileTypes: true }).filter(d => d.isDirectory() && !IGNORED_DIRS.has(d.name) && !d.name.startsWith('.')).map(d => d.name).sort().slice(0, 12)
      .map(name => DIR_HINTS[name] ? name + '/ (' + DIR_HINTS[name] + ')' : name + '/');
  } catch { /* dossier illisible */ }
  const editor = read(path.join(repo, '.editorconfig'), 4000), indent = /indent_style\s*=\s*(\w+)/.exec(editor)?.[1], size = /indent_size\s*=\s*(\d+)/.exec(editor)?.[1];
  if (indent) a.notes.push('indentation : ' + (indent === 'tab' ? 'tabulations' : (size || '2') + ' espaces') + ' (.editorconfig)');
  if (['.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs', '.prettierrc', 'prettier.config.js'].some(f => exists(repo, f))) a.notes.push('un linter/formateur est configuré');
  if (!a.summary) { const readme = read(path.join(repo, 'README.md'), 3000).split('\n').map(l => l.trim()).filter(l => l && !/^[#!<\[`-]/.test(l)); a.summary = readme[0] || ''; }
  return a;
}

// ----- Rendu : court, stable, en français ---------------------------------------------------------
function render(project, analysis) {
  const c = project.context || {}, a = analysis, out = [MARK, '', '# ' + clip(project.name, 80)];
  const about = clip(project.description || a.summary, 240);
  if (about) out.push(about);
  out.push('', '## Projet');
  if (c.objective) out.push('- Objectif : ' + String(c.objective));
  out.push('- Pile : ' + a.stack.join(', '));
  if (a.dirs.length) out.push('- Dossiers : ' + a.dirs.join(', '));
  if (c.environment) out.push('- Environnement : ' + String(c.environment));
  const cmds = Object.entries(a.commands);
  out.push('', '## Commandes');
  const label = { test: 'Tests', build: 'Build', lint: 'Lint', typecheck: 'Types', check: 'Vérification' };
  out.push(...(cmds.length ? cmds.map(([k, v]) => `- ${label[k] || k} : \`${v}\`${a.hints[k] ? ' — ' + a.hints[k] : ''}`) : ['- Aucune commande de test détectée automatiquement.']));
  out.push('', '## Conventions');
  for (const note of a.notes) out.push('- ' + note[0].toUpperCase() + note.slice(1) + '.');
  if (c.instructions) out.push('- Consignes du projet :', ...String(c.instructions).split('\n').filter(Boolean).map(l => '  ' + l));
  out.push('', '## Intégration Cockpit',
    '- Les modifications restent dans la branche de cette tâche. La publication est pilotée par Cockpit et Deployer ; ne contourne pas les validations existantes.',
    '- Si une réponse de l’utilisateur est indispensable, finir par la ligne seule `STATUT: BLOQUÉ` (question au-dessus) ; si c’est impossible, `STATUT: ÉCHEC` (raison au-dessus).');
  return out.join('\n') + '\n';
}

// ----- Dossier du projet --------------------------------------------------------------------------------
function gitRun(args) { return new Promise(resolve => execFile('git', args, { timeout: 30000, windowsHide: true, env: childEnv() }, (error, stdout) => resolve(error ? null : String(stdout).trim()))); }

// Le fichier ne doit jamais finir dans un commit par accident : exclusion locale (.git/info/exclude, partagée par les worktrees).
async function ensureExcluded(repo) {
  const file = await gitRun(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (!file) return false;
  const body = read(file, 100000);
  if (body.split(/\r?\n/).some(l => l.trim() === '/' + FILE)) return true;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, (body && !body.endsWith('\n') ? '\n' : '') + '/' + FILE + '\n'); return true; } catch { return false; }
}
const tracked = async repo => (await gitRun(['-C', repo, 'ls-files', '--error-unmatch', FILE])) !== null;

// Si le dépôt possède déjà ses consignes, les champs Cockpit restent des règles natives
// séparées. Un fichier retouché ou versionné n'est jamais remplacé.
async function prepareContext(project, repo, previous = {}) {
  const rel = '.claude/rules/cockpit-project.md', target = path.join(repo, rel);
  const body = ['# Contexte du projet Cockpit', ...['objective', 'environment', 'instructions'].filter(k => project.context?.[k]).map(k => '\n## ' + ({ objective: 'Objectif', environment: 'Environnement', instructions: 'Consignes' })[k] + '\n' + project.context[k])].join('\n') + '\n';
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if ((await gitRun(['-C', repo, 'ls-files', '--error-unmatch', rel])) !== null || (current !== null && sha(current) !== previous.hash)) return { status: 'existing' };
  if (body === '# Contexte du projet Cockpit\n' && current === null) return {};
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  const exclude = await gitRun(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (exclude && !read(exclude, Infinity).split(/\r?\n/).includes('/' + rel)) fs.appendFileSync(exclude, '\n/' + rel + '\n');
  return { status: 'generated', hash: sha(body) };
}

// Prépare le dossier d'un projet : génère le CLAUDE.md s'il n'existe pas. Renvoie l'état à mémoriser dans le projet.
// previous : état précédent ; il autorise la mise à jour d'un fichier que Cockpit a lui-même généré et que personne n'a retouché.
async function prepare(project, repo, previous = {}, { regenerate = false, now = () => new Date().toISOString() } = {}) {
  const target = path.join(repo, FILE), current = fs.existsSync(target) ? read(target, Infinity) : null;
  const isTracked = await tracked(repo);
  const ours = !isTracked && current !== null && previous.status === 'generated' && previous.hash === sha(current);
  if (current !== null && !ours) {
    if (regenerate) throw Object.assign(new Error('Ce CLAUDE.md ' + (isTracked ? 'fait partie du dépôt' : 'a été modifié') + ' : Cockpit ne l’écrase pas. Supprimez-le ou modifiez-le vous-même.'), { status: 409 });
    const context = await prepareContext(project, repo, previous.context);
    return { status: 'existing', path: target, tracked: isTracked, chars: current.length, context, at: now() };
  }
  const text = render(project, analyze(repo));
  fs.writeFileSync(target, text);
  await ensureExcluded(repo);
  return { status: 'generated', path: target, hash: sha(text), previousHashes: [...new Set([...(previous.previousHashes || []), ...(ours ? [previous.hash] : [])])].slice(-20), chars: text.length, at: now() };
}

// Configuration locale de projet héritée à chaque lancement. Les fichiers suivis dans Git
// appartiennent à la branche ; seuls les fichiers locaux sont synchronisés. Un manifeste dans
// le répertoire administratif Git protège toute modification propre à une tâche.
async function seedWorktree(repo, dir, previous = {}) {
  const manifestPath = await gitRun(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'cockpit-environment.json']);
  if (!manifestPath) throw new Error('Répertoire Git de la tâche introuvable.');
  const manifest = json(manifestPath) || {}, next = {};
  const sourceTracked = new Set((await gitRun(['-C', repo, 'ls-files', '-z']) || '').split('\0'));
  const destTracked = new Set((await gitRun(['-C', dir, 'ls-files', '-z']) || '').split('\0'));
  const candidates = [];
  const walk = rel => {
    const from = path.join(repo, rel);
    let stat; try { stat = fs.lstatSync(from); } catch { return; }
    // Ne pas recopier de liens vers des fichiers extérieurs au projet.
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const entry of fs.readdirSync(from)) walk(rel + '/' + entry); }
    else if (stat.isFile() && !sourceTracked.has(rel)) candidates.push(rel);
  };
  for (const rel of [FILE, 'CLAUDE.local.md', '.claude', '.mcp.json']) walk(rel);
  const excludePath = await gitRun(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  let excludes = excludePath ? read(excludePath, Infinity) : '';
  let changed = false;
  for (const rel of new Set([...candidates, ...Object.keys(manifest)])) {
    if (destTracked.has(rel)) continue;
    const target = path.join(dir, rel);
    // Refuser aussi une traversée d'un dossier local remplacé par un lien.
    let safe = true, cursor = dir;
    for (const part of rel.split('/')) { cursor = path.join(cursor, part); try { if (fs.lstatSync(cursor).isSymbolicLink()) safe = false; } catch {} }
    if (!safe) continue;
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const currentHash = current === null ? null : sha(current);
    const from = path.join(repo, rel), present = candidates.includes(rel);
    const body = present ? fs.readFileSync(from) : null, sourceHash = body === null ? null : sha(body);
    const legacy = rel === FILE && previous.previousHashes?.includes(currentHash);
    const managed = current === null || currentHash === manifest[rel] || currentHash === sourceHash || legacy;
    if (!managed) { if (manifest[rel]) next[rel] = manifest[rel]; continue; }
    if (!present) { if (current !== null && currentHash === manifest[rel]) { fs.unlinkSync(target); changed = true; } continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (currentHash !== sourceHash) { fs.writeFileSync(target, body); changed = true; }
    next[rel] = sourceHash;
    const line = '/' + rel;
    if (excludePath && !excludes.split(/\r?\n/).includes(line)) excludes += (excludes.endsWith('\n') ? '' : '\n') + line + '\n';
  }
  if (excludePath && excludes !== read(excludePath, Infinity)) fs.writeFileSync(excludePath, excludes);
  fs.writeFileSync(manifestPath, JSON.stringify(next));
  return changed;
}

module.exports = { analyze, render, prepare, seedWorktree, ensureExcluded, MARK, FILE };
