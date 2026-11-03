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
  if (['.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs', '.prettierrc', 'prettier.config.js'].some(f => exists(repo, f))) a.notes.push('un linter/formateur est configuré : le lancer avant de conclure');
  if (!a.summary) { const readme = read(path.join(repo, 'README.md'), 3000).split('\n').map(l => l.trim()).filter(l => l && !/^[#!<\[`-]/.test(l)); a.summary = readme[0] || ''; }
  return a;
}

// ----- Rendu : court, stable, en français ---------------------------------------------------------
function render(project, analysis) {
  const c = project.context || {}, a = analysis, out = [MARK, '', '# ' + clip(project.name, 80)];
  const about = clip(project.description || a.summary, 240);
  if (about) out.push(about);
  out.push('', '## Projet');
  if (c.objective) out.push('- Objectif : ' + clip(c.objective, 400).replace(/\n+/g, ' '));
  out.push('- Pile : ' + a.stack.join(', '));
  if (a.dirs.length) out.push('- Dossiers : ' + a.dirs.join(', '));
  if (c.environment) out.push('- Environnement : ' + clip(c.environment, 300).replace(/\n+/g, ' '));
  const cmds = Object.entries(a.commands);
  out.push('', '## Commandes');
  const label = { test: 'Tests', build: 'Build', lint: 'Lint', typecheck: 'Types', check: 'Vérification' };
  out.push(...(cmds.length ? cmds.map(([k, v]) => `- ${label[k] || k} : \`${v}\`${a.hints[k] ? ' — ' + a.hints[k] : ''}`) : ['- Aucune commande de test détectée : en chercher une dans le README avant de modifier le code.']));
  out.push('', '## Conventions', '- Imiter le style du code voisin ; pas de nouvelle dépendance ni de refonte hors de la demande.');
  for (const note of a.notes) out.push('- ' + note[0].toUpperCase() + note.slice(1) + '.');
  if (c.instructions) out.push('- Consignes du projet :', ...clip(c.instructions, 1200).split('\n').filter(Boolean).map(l => '  ' + l));
  out.push('', '## Règles de travail (économie de jetons)',
    '- Lire par plages (`Read` avec offset/limit) ; jamais `cat` sur un gros fichier ; chercher avec `grep -n … | head -40`.',
    '- Plafonner toute sortie de commande : `| tail -30` pour tests et build, `git diff --stat` avant `git diff <fichier>`, `ls`/`find` bornés.',
    '- Tests : d’abord le fichier concerné ; la suite complète une seule fois avant de conclure.',
    '- Ne rien publier : pas de push, de déploiement ni d’envoi hors de la machine. Un seul commit local à la fin (`git add -A && git commit -m "<résumé court>"`).',
    '- Réponse finale courte : ce qui a changé (fichiers), résultat des tests, point restant. Pas de récit des étapes.',
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

// Prépare le dossier d'un projet : génère le CLAUDE.md s'il n'existe pas. Renvoie l'état à mémoriser dans le projet.
// previous : état précédent ; il autorise la mise à jour d'un fichier que Cockpit a lui-même généré et que personne n'a retouché.
async function prepare(project, repo, previous = {}, { regenerate = false, now = () => new Date().toISOString() } = {}) {
  const target = path.join(repo, FILE), current = fs.existsSync(target) ? read(target, 200000) : null;
  const ours = current !== null && previous.status === 'generated' && previous.hash === sha(current);
  if (current !== null && !ours) {
    const isTracked = await tracked(repo);
    if (regenerate) throw Object.assign(new Error('Ce CLAUDE.md ' + (isTracked ? 'fait partie du dépôt' : 'a été modifié') + ' : Cockpit ne l’écrase pas. Supprimez-le ou modifiez-le vous-même.'), { status: 409 });
    return { status: 'existing', path: target, tracked: isTracked, chars: current.length, at: now() };
  }
  const text = render(project, analyze(repo));
  fs.writeFileSync(target, text);
  await ensureExcluded(repo);
  return { status: 'generated', path: target, hash: sha(text), chars: text.length, at: now() };
}

// Un worktree reçoit le CLAUDE.md du dossier principal s'il ne l'a pas (cas du fichier généré, non versionné) ; jamais d'écrasement.
function seedWorktree(repo, dir) {
  const from = path.join(repo, FILE), to = path.join(dir, FILE);
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  fs.copyFileSync(from, to); return true;
}

module.exports = { analyze, render, prepare, seedWorktree, ensureExcluded, MARK, FILE };
