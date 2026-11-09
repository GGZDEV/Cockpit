'use strict';
// Préparation du worktree d'une tâche avant le moteur : dépendances installées, puis tests de départ (baseline) mesurés une fois par commit.
// Jamais de shell : programmes en tableau d'arguments, délai maximal, environnement filtré (childEnv), sortie tronquée et caviardée.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./direct-harness.cjs');

const INSTALL_TIMEOUT = 10 * 60000, TEST_TIMEOUT = 10 * 60000, KEEP = 64 * 1024;
const readPackage = cwd => { try { const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); return pkg && typeof pkg === 'object' ? pkg : null; } catch { return null; } };
const hasDeps = pkg => ['dependencies', 'devDependencies', 'optionalDependencies'].some(k => pkg[k] && typeof pkg[k] === 'object' && Object.keys(pkg[k]).length);
// Script de test réel : absent ou texte par défaut de `npm init` = rien à mesurer.
const testScript = cwd => { const t = readPackage(cwd)?.scripts?.test; return typeof t === 'string' && !!t.trim() && !/no test specified/i.test(t); };

// Installation à faire : rien si node_modules existe (worktree réutilisé) ou s'il n'y a rien à installer.
function installPlan(cwd) {
  const pkg = readPackage(cwd), has = file => fs.existsSync(path.join(cwd, file));
  if (!pkg || has('node_modules')) return null;
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { tool: 'npm', args: ['ci', '--no-audit', '--no-fund', '--prefer-offline'], label: 'npm ci' };
  if (has('pnpm-lock.yaml')) return { tool: 'pnpm', args: ['install', '--frozen-lockfile'], label: 'pnpm install' };
  if (has('yarn.lock')) return { tool: 'yarn', args: ['install', '--frozen-lockfile'], label: 'yarn install' };
  // Sans verrou : installation sans rien écrire dans le dépôt (ni package.json ni package-lock.json).
  if (hasDeps(pkg)) return { tool: 'npm', args: ['install', '--no-audit', '--no-fund', '--no-save', '--no-package-lock'], label: 'npm install' };
  return null;
}

// Programme d'un outil : chemin trouvé dans PATH (jamais un .cmd sous Windows, qui imposerait un shell ; npm y passe par node + npm-cli.js).
function locate(tool, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  if (platform === 'win32') {
    const cli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return tool === 'npm' && fs.existsSync(cli) ? { file: execPath, args: [cli] } : null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, tool);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return { file, args: [] }; } catch { /* suivant */ }
  }
  return null;
}

// Lance un programme ; résout toujours avec { code, timedOut, aborted, output, error }. Arrêt du groupe de processus en cas de délai ou d'arrêt.
function runCommand(file, args, { cwd, env, timeoutMs, signal, platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let output = '', timedOut = false, aborted = false, settled = false, child;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ timedOut, aborted, output, ...value }); };
    const onAbort = () => { aborted = true; if (child) h.killTree(child, { platform }); };
    const timer = setTimeout(() => { timedOut = true; if (child) h.killTree(child, { platform }); }, timeoutMs);
    if (signal?.aborted) return finish({ aborted: true, code: null });
    try { child = spawnImpl(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32' }); }
    catch (error) { return finish({ code: null, error: error.message }); }
    signal?.addEventListener('abort', onAbort, { once: true });
    const take = chunk => { output = (output + chunk).slice(-KEEP); };
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    child.on('error', error => finish({ code: null, error: error.code === 'ENOENT' ? file + ' introuvable' : error.message }));
    child.on('close', code => finish({ code }));
  });
}

// Fin de sortie lisible : sans couleurs, caviardée, quelques lignes.
function tail(output, max = 1200, count = 15) {
  const clean = h.redact(String(output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).split('\n').map(l => l.trimEnd()).filter(Boolean);
  return clean.slice(-count).join('\n').slice(-max);
}
// Compteurs des lanceurs courants : node --test (ℹ/#), TAP, Jest/Vitest, Mocha.
function counts(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), last = re => { const all = [...text.matchAll(re)]; return all.length ? Number(all.at(-1)[1]) : null; };
  let pass = last(/^(?:ℹ|#) pass (\d+)/gm), fail = last(/^(?:ℹ|#) fail (\d+)/gm);
  if (pass === null) { pass = last(/Tests?:.*?(\d+) passed/g); fail = last(/Tests?:.*?(\d+) failed/g) ?? (pass === null ? null : 0); }
  if (pass === null) { pass = last(/^\s*(\d+) passing/gm); fail = last(/^\s*(\d+) failing/gm) ?? (pass === null ? null : 0); }
  return pass === null ? null : { passed: pass, failed: fail || 0, total: pass + (fail || 0) };
}

function createTaskEnv({ run = runCommand, env = process.env, platform = process.platform, execPath = process.execPath, commands = {}, git = h.gitRunner,
  installTimeoutMs = INSTALL_TIMEOUT, testTimeoutMs = TEST_TIMEOUT } = {}) {
  // NODE_TEST_CONTEXT ferait des tests du projet des sous-tests d'un lanceur parent ; CI=1 coupe les modes interactifs (watch).
  const childEnv = () => { const e = h.childEnv(env, { set: { CI: '1' } }); delete e.NODE_TEST_CONTEXT; return e; };
  const program = tool => commands[tool] ? { file: commands[tool][0], args: commands[tool].slice(1) } : locate(tool, { env, platform, execPath });

  // { status: 'installed'|'failed'|'missing', label, summary, durationMs } ou null s'il n'y a rien à installer.
  async function install(cwd, { signal } = {}) {
    const plan = installPlan(cwd);
    if (!plan) return null;
    const bin = program(plan.tool);
    if (!bin) return { status: 'missing', label: plan.label, summary: plan.tool + ' n’est pas installé sur ce poste : dépendances non installées.' };
    const started = Date.now(), r = await run(bin.file, [...bin.args, ...plan.args], { cwd, env: childEnv(), timeoutMs: installTimeoutMs, signal, platform });
    const ok = r.code === 0 && !r.timedOut && !r.aborted;
    return { status: ok ? 'installed' : r.aborted ? 'aborted' : 'failed', label: plan.label, durationMs: Date.now() - started,
      summary: ok ? '' : r.timedOut ? 'Délai dépassé (' + Math.round(installTimeoutMs / 60000) + ' min).' : tail(r.error || r.output, 600, 8) };
  }
  // Fichiers suivis modifiés (porcelain -z) : un test qui réécrit un fichier suivi est remis en état après la mesure.
  const tracked = async cwd => git ? (await git(['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=no']).catch(() => '')).split('\0').filter(e => e.length > 3).map(e => e.slice(3)) : [];
  // { sha, at, ok, summary, passed, failed, total, timedOut } ou null sans script de test réel.
  async function baseline(cwd, sha, { signal } = {}) {
    if (!testScript(cwd)) return null;
    const bin = program('npm');
    if (!bin) return { sha, at: new Date().toISOString(), ok: false, summary: 'npm n’est pas installé sur ce poste : tests de départ non mesurés.', unavailable: true };
    const before = new Set(await tracked(cwd));
    const r = await run(bin.file, [...bin.args, 'test'], { cwd, env: childEnv(), timeoutMs: testTimeoutMs, signal, platform });
    if (r.aborted) return null;
    const changed = (await tracked(cwd)).filter(f => !before.has(f));
    if (changed.length && git) await git(['-C', cwd, 'checkout', '--', ...changed]).catch(() => {});
    return { sha, at: new Date().toISOString(), ok: r.code === 0 && !r.timedOut, timedOut: r.timedOut || undefined, ...(counts(r.output) || {}),
      summary: r.timedOut ? 'Délai dépassé (' + Math.round(testTimeoutMs / 60000) + ' min).' : tail(r.error || r.output), ...(changed.length ? { restored: changed.slice(0, 20) } : {}) };
  }
  return { install, baseline, plan: installPlan, testScript };
}

// Textes de la chronologie et du brief.
function describeInstall(r) {
  if (r.status === 'installed') return `Dépendances installées (${r.label}, ${Math.max(1, Math.round(r.durationMs / 1000))} s)`;
  if (r.status === 'missing') return r.summary;
  if (r.status === 'aborted') return 'Installation des dépendances interrompue';
  return `Échec de l’installation des dépendances (${r.label}) : ${r.summary.split('\n').at(-1) || 'erreur inconnue'}`;
}
const score = b => b.total ? `${b.passed}/${b.total}` : '';
function describeBaseline(b) {
  if (b.unavailable) return b.summary;
  if (b.ok) return 'Tests de départ : ' + (score(b) || 'réussis');
  return b.timedOut ? 'Tests de départ : délai dépassé' : 'Tests de départ : échecs existants' + (score(b) ? ' (' + score(b) + ' réussis)' : '');
}
// Sections ajoutées au brief d'une nouvelle session. visual : commande de captures si l'outil est autorisé.
function environmentBrief({ deps, baseline, testable, visual }) {
  const out = ['## Environnement préparé'];
  out.push('- Dépendances : ' + (!deps ? 'aucune à installer, ou déjà présentes.' : deps.status === 'installed' ? `installées par Cockpit (${deps.label}).` : deps.status === 'missing' ? deps.summary + ' Installe-les toi-même si les tests en ont besoin.'
    : `échec de ${deps.label} — ${deps.summary ? 'fin de sortie :\n```\n' + deps.summary + '\n```' : 'à régler avant de tester.'}`));
  if (!testable) out.push('- Tests : pas de script `test` dans package.json.');
  else if (!baseline) out.push('- Tests de départ : non mesurés (worktree déjà modifié ou mesure interrompue).');
  else if (baseline.unavailable) out.push('- Tests de départ : ' + baseline.summary);
  else if (baseline.ok) out.push(`- Tests de départ (commit ${baseline.sha.slice(0, 7)}, \`npm test\`) : tous réussis${score(baseline) ? ' (' + score(baseline) + ')' : ''}.`);
  else out.push(`- Tests de départ (commit ${baseline.sha.slice(0, 7)}, \`npm test\`) : **échecs existants avant ton travail**${score(baseline) ? ' (' + score(baseline) + ' réussis)' : ''} — ce ne sont pas des régressions. Fin de sortie :\n\`\`\`\n${baseline.summary.slice(-800)}\n\`\`\``);
  out.push('', '## Vérification', '- Pendant le travail : lance les tests ciblés des fichiers touchés.',
    '- À la fin : la suite complète une fois, comparée aux tests de départ ; distingue les échecs existants des nouveaux et corrige les nouveaux.');
  if (visual) out.push(`- Changement visuel : \`node ${visual} --path / -- <commande qui démarre le serveur, PORT fourni>\` (ou \`--url http://127.0.0.1:<port>\`) fait des captures mobile et bureau.`,
    '  Ajoute `--inspect` pour relever erreurs JavaScript/console (`console`) et débordements horizontaux (`overflow`) ; `--click <sélecteur>`, `--type <sélecteur>=<texte>`, `--eval <js>` rejouent des interactions (capture après chacune).',
    '  Lis les PNG indiqués dans sa sortie JSON avec Read ; ils sont joints à la tâche à la fin de l’exécution.');
  return out.join('\n');
}

module.exports = { createTaskEnv, installPlan, testScript, locate, runCommand, counts, tail, describeInstall, describeBaseline, environmentBrief };
