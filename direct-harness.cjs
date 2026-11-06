'use strict';
// Plomberie commune des moteurs directs (Claude Code, Codex) : une tâche de projet exécutée sur ce PC, sans OpenClaw.
// Ce module ne décide rien sur le déroulement de la tâche (pas de plan, de validation ni de reçu imposés) : il valide le dépôt,
// prépare le worktree de la tâche, lance le moteur (arguments en tableau, demande sur l'entrée standard, jamais de shell),
// lit son flux JSONL ligne à ligne et relève des faits Git. Ce qui est propre à un moteur vient de son adaptateur.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const ENGINES = ['claude', 'codex'];
const ENGINE_LABEL = { claude: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Modèle par défaut de Claude Code : réglable par projet et par tâche.
const DEFAULT_MODEL = 'claude-sonnet-5-5';
// Commandes que Claude peut lancer sans demander (préfixes). « * » : toutes, comme Claude Code sur le poste de l'utilisateur ;
// les interdits (pousser, publier, se connecter ailleurs) restent appliqués par-dessus dans chaque moteur.
const DEFAULT_BASH = ['*'];
// Ancienne liste par défaut (préfixes git/npm/node seulement) : un projet qui l'a encore enregistrée passe au nouveau défaut.
const LEGACY_BASH = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse', 'git branch', 'git ls-files', 'npm test', 'npm run test', 'npm run lint', 'npm run build', 'node --test', 'node --check'];
const DEFAULTS = Object.freeze({ model: DEFAULT_MODEL, effort: '', maxBudgetUsd: 5, taskBudgetUsd: 20, timeoutMin: 30, maxRuns: 10, web: false, allowedBash: DEFAULT_BASH,
  fallback: '', codexModel: '', codexEffort: '' });
const MARKER = /^\s*\**\s*STATUT\s*:\s*(TERMIN[ÉE]E?|BLOQU[ÉE]E?|[ÉE]CHEC)\s*\**\s*$/gim;

class DirectError extends Error { constructor(status, message) { super(message); this.status = status; } }
const clip = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const num = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const lines = (value, max, len) => (Array.isArray(value) ? value : String(value ?? '').split('\n')).map(l => clip(l, len)).filter(l => l && !/[\0\n]/.test(l)).slice(0, max);
// Pas de tiret initial : un nom de modèle ne doit jamais pouvoir passer pour une option.
const modelName = value => /^(?!-)[\w.:\[\]-]{0,80}$/.test(value || '') ? value || '' : '';

// Réglages des moteurs directs d'un projet : toujours complets et bornés. Le moteur lui-même est un réglage du projet (project.engine).
function directSettings(input = {}, previous = {}) {
  const v = { ...DEFAULTS, ...previous, ...(input && typeof input === 'object' ? input : {}) };
  return {
    model: modelName(v.model) || DEFAULT_MODEL, effort: EFFORTS.includes(v.effort) ? v.effort : '', web: v.web === true,
    maxBudgetUsd: num(v.maxBudgetUsd, 0.1, 100, DEFAULTS.maxBudgetUsd), taskBudgetUsd: num(v.taskBudgetUsd, 0.1, 500, DEFAULTS.taskBudgetUsd),
    timeoutMin: Math.round(num(v.timeoutMin, 1, 180, DEFAULTS.timeoutMin)), maxRuns: Math.round(num(v.maxRuns, 1, 30, DEFAULTS.maxRuns)),
    allowedBash: (b => b.length && b.join('\n') !== LEGACY_BASH.join('\n') ? b : DEFAULT_BASH)(lines(v.allowedBash, 40, 200)),
    fallback: ENGINES.includes(v.fallback) ? v.fallback : '',
    codexModel: modelName(v.codexModel), codexEffort: CODEX_EFFORTS.includes(v.codexEffort) ? v.codexEffort : '',
  };
}

// Masque les secrets courants avant tout stockage ou affichage (sorties, erreurs, commandes).
function redact(value) {
  return String(value ?? '')
    .replace(/sk-ant-[\w-]{8,}/g, 'sk-ant-***').replace(/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***').replace(/\bgithub_pat_\w{16,}/g, 'github_pat_***')
    .replace(/\bxox[abprs]-[\w-]{8,}/g, 'xox*-***').replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, 'jwt***').replace(/(Bearer\s+)[\w.~+/=-]{8,}/gi, '$1***')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s'"]+/gi, '$1***');
}

// Environnement d'un moteur : celui du service, sans les variables qui ressemblent à des secrets ni celles listées dans drop,
// sauf celles de keep (authentification propre au moteur), plus set (valeurs imposées par Cockpit).
function childEnv(base = process.env, { keep = [], drop = [], set = {} } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (keep.includes(k)) { env[k] = v; continue; }
    if (k.startsWith('COCKPIT_')) continue; // Réglages du serveur privés ; ne pas contaminer les tests du projet.
    if (drop.includes(k) || /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY$|CREDENTIAL|COOKIE/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...set };
}

// Dernière ligne de statut de la réponse, retirée du texte. Sans ligne : le travail est considéré comme fait.
function verdict(text) {
  const reply = String(text || ''), match = [...reply.matchAll(MARKER)].at(-1);
  const word = match ? match[1].toUpperCase().normalize('NFD').replace(/[^A-Z]/g, '') : '';
  const body = (match ? reply.slice(0, match.index) + reply.slice(match.index + match[0].length) : reply).trim();
  return { status: word.startsWith('TERMIN') ? 'done' : word.startsWith('BLOQU') ? 'blocked' : word.startsWith('ECHEC') ? 'failed' : '', body };
}

// ----- Secours automatique -----------------------------------------------------------------------
// Seules les indisponibilités du moteur (quota, authentification, service, binaire) ouvrent droit au secours.
const UNAVAILABLE = [
  ['quota', 'quota ou limite d’usage atteint', /usage.?limit|quota|rate.?limit|\b429\b|credit balance|billing|too many requests/i],
  ['auth', 'authentification absente ou expirée', /\b401\b|\b403\b|unauthori[sz]ed|forbidden|not logged in|\blogin\b|authenticat|expired|invalid api key|refresh token/i],
  ['service', 'service indisponible', /overloaded|\b529\b|\b50[23]\b|service unavailable|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network error|stream disconnected/i],
];
function unavailability(text) {
  const hit = UNAVAILABLE.find(([, , re]) => re.test(String(text || '')));
  return hit ? { kind: hit[0], reason: hit[1] } : null;
}
// Le secours n'est permis que si le moteur primaire a échoué avant tout travail effectif : aucun outil, aucune réponse,
// aucun délai dépassé, et un worktree propre, identique avant et après (même HEAD, rien de modifié).
function fallbackDecision({ result, activity = 0, errorText = '', before, after }) {
  if (result.timedOut) return { ok: false, why: 'délai dépassé : le moteur a pu travailler' };
  if (activity > 0) return { ok: false, why: 'le moteur avait commencé à travailler (réponse ou outil)' };
  if (!before || !after || !before.head || before.head !== after.head || before.status || after.status) return { ok: false, why: 'le worktree n’est pas propre ou a changé' };
  if (result.spawnError) return { ok: true, kind: 'binary', reason: 'binaire introuvable ou impossible à lancer' };
  const hit = unavailability(errorText);
  return hit ? { ok: true, ...hit } : { ok: false, why: 'erreur non reconnue comme une indisponibilité du moteur' };
}

// ----- Processus ------------------------------------------------------------------------------
function gitRunner(args, options = {}) {
  return new Promise((resolve, reject) => execFile('git', args, { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: childEnv(), ...options }, (error, stdout, stderr) => {
    if (error) { error.stderr = String(stderr || ''); return reject(error); }
    resolve(String(stdout || ''));
  }));
}
// Arrête le processus et ses enfants : taskkill /T sous Windows, groupe de processus ailleurs.
function killTree(child, { platform = process.platform, execFileImpl = execFile, kill = process.kill.bind(process) } = {}) {
  if (!child.pid || child.exitCode !== null) return;
  if (platform === 'win32') execFileImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } setTimeout(() => { try { kill(-child.pid, 'SIGKILL'); } catch { /* déjà arrêté */ } }, 5000).unref(); }
}
// « child » est-il strictement dans « parent » ? Insensible à la casse sous Windows.
function insideDir(child, parent, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = p => { const r = P.resolve(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
  return norm(child).startsWith(norm(parent) + P.sep);
}
// Programme du moteur : un script .js passe par node ; sous Windows, un .cmd/.bat est refusé (il imposerait un shell).
function resolveProgram(command, prefixArgs = [], { platform = process.platform, execPath = process.execPath } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) return { refused: true };
  if (/\.[cm]?js$/i.test(command)) return { file: execPath, args: [command, ...prefixArgs] };
  return { file: command, args: prefixArgs };
}

// adapter : { name, createCollector(), env(base), cmdRefusal, missing(command) } — ce qui est propre au moteur.
function createHarness({ adapter, enabled = false, command, prefixArgs = [], baseEnv = process.env, workspacesRoot,
  worktreeRoot = process.env.COCKPIT_CLAUDE_WORKTREES || (workspacesRoot ? path.join(workspacesRoot, '.cockpit-worktrees') : ''), git = gitRunner, maxParallel = 2, spawnImpl = spawn,
  platform = process.platform, execFileImpl = execFile, execPath = process.execPath }) {
  const active = new Map(); // run id -> processus
  const win = platform === 'win32';
  const norm = p => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return win ? r.toLowerCase() : r; };
  const inside = (child, parent) => insideDir(child, parent, platform);
  const stop = child => killTree(child, { platform, execFileImpl });

  // Le dossier du projet doit être sa copie locale prête, sous le dossier des projets, et la racine d'un dépôt Git.
  async function repository(project) {
    const w = project.workspace;
    if (!w || w.status !== 'ready' || !w.path) throw new DirectError(409, 'La copie locale du dépôt de ce projet n’est pas prête : rien n’a été lancé.');
    const raw = String(w.path);
    if (!path.isAbsolute(raw) || raw.includes('\0') || raw.split(/[\\/]+/).includes('..')) throw new DirectError(400, 'Chemin du dépôt refusé : ' + clip(raw, 200));
    if (!workspacesRoot) throw new DirectError(500, 'Dossier des projets inconnu : chemin du dépôt impossible à valider.');
    let real, root;
    try { real = fs.realpathSync.native(raw); root = fs.realpathSync.native(workspacesRoot); } catch { throw new DirectError(409, 'Le dossier du dépôt n’existe pas : ' + clip(raw, 200)); }
    if (norm(real) !== norm(raw)) throw new DirectError(400, 'Le dossier du dépôt passe par un lien symbolique : refusé.');
    if (!inside(real, root)) throw new DirectError(400, 'Le dépôt doit se trouver dans le dossier des projets (' + root + ').');
    if (!fs.existsSync(path.join(real, '.git'))) throw new DirectError(409, 'Ce dossier n’est pas un dépôt Git : ' + real);
    const top = (await git(['-C', real, 'rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (!top || norm(fs.realpathSync.native(top)) !== norm(real)) throw new DirectError(409, 'Ce dossier n’est pas la racine d’un dépôt Git : ' + real);
    return real;
  }

  // Un worktree et une branche par tâche, quel que soit le moteur ; la copie principale du projet n'est jamais modifiée.
  async function worktree(project, task, repo) {
    if (!worktreeRoot) throw new DirectError(500, 'Dossier des worktrees inconnu.');
    const dir = path.join(worktreeRoot, path.basename(repo).replace(/[^\w.-]/g, '_') + '-' + project.id.slice(0, 8), task.code.replace(/[^A-Za-z0-9-]/g, '') || task.id.slice(0, 8));
    const branch = 'cockpit/' + task.code.toLowerCase().replace(/[^a-z0-9-]/g, '') + '-' + task.id.slice(0, 6);
    const common = async cwd => { const out = (await git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(); return norm(fs.realpathSync.native(out)); };
    if (fs.existsSync(dir)) {
      const [head, mine, theirs] = await Promise.all([git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''), common(dir).catch(() => ''), common(repo)]);
      if (head.trim() !== branch || mine !== theirs) throw new DirectError(409, 'Le dossier ' + dir + ' existe mais n’est pas le worktree de cette tâche : rien n’a été modifié.');
      return { path: dir, branch, created: false };
    }
    const baseSha = (await git(['-C', repo, 'rev-parse', 'HEAD'])).trim();
    const exists = await git(['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try { await git(['-C', repo, 'worktree', 'add', ...(exists ? ['--', dir, branch] : ['-b', branch, '--', dir, baseSha])]); }
    catch (error) { throw new DirectError(409, 'Création du worktree impossible : ' + redact(clip(error.stderr || error.message, 300))); }
    return { path: dir, branch, baseSha, created: true };
  }
  // État Git du worktree (HEAD et changements), pour prouver qu'un moteur n'a rien modifié avant un secours.
  async function gitState(cwd) {
    const g = args => git(['-C', cwd, ...args]).then(out => out.trim(), () => null);
    const [head, status] = await Promise.all([g(['rev-parse', 'HEAD']), g(['status', '--porcelain', '--untracked-files=all'])]);
    return head === null || status === null ? null : { head, status };
  }

  // Lance le moteur ; résout toujours (jamais d'exception) avec ce qui s'est passé.
  function run({ runId, args, cwd, prompt, timeoutMs, onEvent = () => {} }) {
    const collector = adapter.createCollector(), started = Date.now();
    const program = resolveProgram(command, prefixArgs, { platform, execPath });
    if (program.refused) return Promise.resolve({ collector, durationMs: 0, spawnError: adapter.cmdRefusal });
    return new Promise(resolve => {
      let child, stderr = '', buffer = '', timedOut = false, settled = false;
      const done = value => { if (settled) return; settled = true; clearTimeout(timer); active.delete(runId); resolve({ collector, stderr: redact(stderr.slice(-4000)), timedOut, durationMs: Date.now() - started, ...value }); };
      try { child = spawnImpl(program.file, [...program.args, ...args], { cwd, env: adapter.env(baseEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !win }); }
      catch (error) { return done({ spawnError: error.message }); }
      active.set(runId, child);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const timer = setTimeout(() => { timedOut = true; stop(child); }, timeoutMs);
      child.on('error', error => done({ spawnError: error.code === 'ENOENT' ? adapter.missing(command) : error.message }));
      const line = raw => { const value = raw.trim(); if (!value) return; const ev = collector.push(value); if (ev) onEvent(ev, collector); };
      child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      child.on('close', (code, signal) => { line(buffer); done({ code, signal }); });
    });
  }

  // Faits Git relevés par Cockpit après l'exécution (aucun jeton) : branche, commits, fichiers, changements non commités.
  async function summary({ cwd, baseSha }) {
    const g = args => git(['-C', cwd, ...args]).then(out => out.trim(), () => '');
    const range = baseSha ? baseSha + '..HEAD' : 'HEAD~0..HEAD';
    const [branch, head, log, files, dirty] = await Promise.all([g(['rev-parse', '--abbrev-ref', 'HEAD']), g(['rev-parse', 'HEAD']), g(['log', '--format=%h %s', '-n', '50', range]), g(['diff', '--name-status', range]), g(['status', '--porcelain'])]);
    const list = value => value ? value.split('\n').filter(Boolean) : [];
    return { at: new Date().toISOString(), branch, baseSha: baseSha || '', head, commits: list(log).map(l => redact(clip(l, 200))), files: list(files).slice(0, 200), uncommitted: list(dirty).slice(0, 100) };
  }

  return { name: adapter.name, enabled: !!enabled, repository, worktree, gitState, run, summary, active, maxParallel, worktreeRoot,
    close: () => { for (const child of active.values()) stop(child); } };
}

module.exports = { createHarness, directSettings, resolveProgram, killTree, insideDir, verdict, redact, childEnv, unavailability, fallbackDecision,
  clip, DirectError, ENGINES, ENGINE_LABEL, DEFAULTS, DEFAULT_BASH, DEFAULT_MODEL, CODEX_EFFORTS, MARKER };
