'use strict';
// Adaptateur « Claude Code direct » : arguments de `claude -p`, lecture du flux stream-json (texte, outils, compteurs) et
// environnement de Claude. Profil volontairement léger : peu d'outils, ni compétences, ni serveurs MCP, ni mémoire automatique,
// ni hooks, ni instructions Git intégrées ; les consignes du projet viennent du seul CLAUDE.md du dossier de travail.
// Le reste (dépôt, worktree, lancement sans shell, délai) est partagé avec Codex dans direct-harness.cjs.
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { execFile } = require('node:child_process');
const h = require('./direct-harness.cjs');
const applications = require('./applications-runtime.cjs');

// Interdits quelles que soient les autorisations du projet : rien ne sort de la machine sans validation.
const DENY_BASH = ['git push', 'git remote', 'gh', 'npm publish', 'npm run deploy', 'npm run publish', 'curl', 'wget', 'ssh', 'scp', 'rsync'];

// Réglages passés en ligne de commande (--settings) : rien de ce qui alourdit le contexte sans servir une tâche de code.
// Clés documentées : https://code.claude.com/docs/en/settings-reference (includeGitInstructions, autoMemoryEnabled, disableAllHooks, enabledPlugins).
// Outil de captures (scripts/visual-check.cjs) : toujours autorisé, même quand le projet restreint les commandes.
const VISUAL_CHECK = path.join(__dirname, 'scripts', 'visual-check.cjs');

const LEAN_SETTINGS = JSON.stringify({ autoMemoryEnabled: false, disableAllHooks: true, includeGitInstructions: false, enabledPlugins: {} });

// Style de réponse « caveman » (https://github.com/juliusbrussee/caveman, Apache-2.0) ajouté au prompt système de chaque appel :
// réponses brèves, code et erreurs intacts. Les extensions et commandes slash étant coupées, la règle est passée en texte.
const CAVEMAN = fs.readFileSync(path.join(__dirname, 'claude-caveman.md'), 'utf8').trim();

// Options facultatives : retirées si la version de Claude Code installée ne les connaît pas (lu dans `claude --help`, aucun appel d'API).
const OPTIONAL_FLAGS = ['--exclude-dynamic-system-prompt-sections', '--effort', '--max-budget-usd', '--settings'];
function probeFlags(command, prefixArgs = [], { execPath = process.execPath, execFileImpl = execFile, env = process.env } = {}) {
  const js = /\.[cm]?js$/i.test(command);
  return new Promise(resolve => execFileImpl(js ? execPath : command, js ? [command, ...prefixArgs, '--help'] : [...prefixArgs, '--help'],
    { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, env: h.childEnv(env) }, (error, stdout) => {
      // Binaire illisible : on suppose tout pris en charge, l'erreur réelle viendra du lancement.
      resolve(error ? null : new Set(String(stdout).match(/--[a-z][a-z-]*/g) || []));
    }));
}

// Environnement de Claude : l'authentification Claude (OAuth enregistrée, CLAUDE_CODE_OAUTH_TOKEN) est conservée ;
// une clé API Anthropic est retirée pour que l'abonnement OAuth reste utilisé.
const childEnv = (base = process.env) => h.childEnv(base, { keep: ['CLAUDE_CODE_OAUTH_TOKEN'], drop: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] });

const rule = entry => entry === '*' ? 'Bash' : /^[A-Za-z]+\(/.test(entry) ? entry : 'Bash(' + entry.replace(/(:\*|\s\*)$/, '') + ':*)';
// Arguments de `claude -p`. mode « plan » : lecture seule (option par tâche) ; mode « work » : le travail normal.
// Les listes variables (--allowedTools, --add-dir…) sont toujours suivies d'une autre option ; la session est en dernier.
// budgetUsd : plafond de cette exécution. flags : options reconnues par le binaire (null = toutes).
function buildArgs({ mode = 'work', sessionId, fresh, settings, model, addDirs = [], budgetUsd, flags = null }) {
  const s = h.directSettings(settings);
  const has = flag => !OPTIONAL_FLAGS.includes(flag) || !flags || flags.has(flag);
  // Travail : les mêmes outils que Claude Code sur le poste (web, sous-agents, liste de tâches…) ; plan : lecture seule.
  const tools = mode === 'plan' ? ['Read', 'Glob', 'Grep'] : ['default'];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--disable-slash-commands'];
  if (has('--settings')) args.push('--settings', LEAN_SETTINGS);
  args.push('--tools', tools.join(','), '--permission-mode', mode === 'plan' ? 'plan' : 'acceptEdits');
  if (mode !== 'plan') args.push('--allowedTools', ...s.allowedBash.map(rule), ...(s.allowedBash.includes('*') ? [] : [rule('node ' + VISUAL_CHECK)]), 'WebFetch', 'WebSearch');
  const denied = applications.enabled() ? ['git push', 'npm publish'] : DENY_BASH;
  args.push('--disallowedTools', ...denied.map(rule));
  // Dossier temporaire du système : scripts jetables (décoder une pièce jointe, essais) sans salir le worktree.
  const dirs = mode === 'plan' ? addDirs : [...addDirs, os.tmpdir()];
  if (dirs.length) args.push('--add-dir', ...dirs);
  if (has('--max-budget-usd')) args.push('--max-budget-usd', String(budgetUsd ?? s.maxBudgetUsd));
  if (has('--exclude-dynamic-system-prompt-sections')) args.push('--exclude-dynamic-system-prompt-sections');
  args.push('--append-system-prompt', [CAVEMAN, applications.instructions()].filter(Boolean).join('\n\n'), '--model', h.directSettings({ model: model || s.model }).model);
  if (s.effort && has('--effort')) args.push('--effort', s.effort);
  args.push(fresh ? '--session-id' : '--resume', sessionId);
  return args;
}

// ----- Lecture du flux stream-json ----------------------------------------------------------
const short = value => h.redact(h.clip(value, 100)).replace(/\s+/g, ' ');
function toolHint(block) {
  const i = block.input || {};
  const target = i.file_path ? path.basename(String(i.file_path)) : i.pattern || i.path || i.command || i.url || i.query || '';
  return block.name + (target ? ' · ' + short(target) : '');
}
const ctx = u => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
// activity : réponses et outils vus (le message init seul n'en est pas) ; sert à refuser un secours après un début de travail.
function createCollector() {
  const st = { sessionId: '', model: '', calls: new Map(), models: new Set(), text: '', plan: '', tools: 0, activity: 0, result: null };
  function push(raw) {
    let m; try { m = JSON.parse(raw); } catch { return null; }
    if (!m || typeof m !== 'object') return null;
    if (m.type === 'system' && m.subtype === 'init') { st.sessionId = m.session_id || ''; st.model = m.model || ''; return { kind: 'init', model: st.model }; }
    if (m.type === 'assistant' && m.message) {
      const msg = m.message;
      // Un même appel peut arriver en plusieurs morceaux : on garde un seul compteur par identifiant de message.
      if (msg.usage) st.calls.set(msg.id || 'anon-' + st.calls.size, { model: msg.model || '', usage: msg.usage });
      if (msg.model) st.models.add(msg.model);
      let out = null;
      for (const b of msg.content || []) {
        if (b.type === 'text' && b.text?.trim()) { st.text = b.text; st.activity++; out ||= { kind: 'text' }; }
        if (b.type === 'tool_use') { st.tools++; st.activity++; if (b.name === 'ExitPlanMode' && b.input?.plan) st.plan = String(b.input.plan); out = { kind: 'tool', text: toolHint(b) }; }
      }
      return out;
    }
    if (m.type === 'result') { st.result = m; return { kind: 'result' }; }
    return null;
  }
  // Compteurs de cette exécution. Le flux ne donne les sorties qu'en partie (le compteur final d'un message arrive après lui) :
  // les totaux viennent donc du résultat final (modelUsage : tous les modèles, appels auxiliaires inclus), vérifié sur un passage réel
  // contre le journal de session (mêmes chiffres). Une session reprise annonce des cumuls pour toute la conversation : costBefore et
  // usageBefore (cumuls de la précédente exécution) en sont retirés. Repli : usage du résultat, puis somme des appels vus dans le flux.
  const FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output'];
  function metrics({ costBefore = 0, usageBefore = null } = {}) {
    const r = st.result || {}, sum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const { usage: u } of st.calls.values()) { sum.input += u.input_tokens || 0; sum.cacheWrite += u.cache_creation_input_tokens || 0; sum.cacheRead += u.cache_read_input_tokens || 0; sum.output += u.output_tokens || 0; }
    const byModel = Object.entries(r.modelUsage && typeof r.modelUsage === 'object' ? r.modelUsage : {}).map(([model, x]) => ({ model,
      input: x.inputTokens || 0, cacheWrite: x.cacheCreationInputTokens || 0, cacheRead: x.cacheReadInputTokens || 0, output: x.outputTokens || 0, costUsd: x.costUSD || 0 }));
    const u = r.usage;
    const cumulative = byModel.length ? Object.fromEntries(FIELDS.map(k => [k, byModel.reduce((a, m) => a + m[k], 0)]))
      : u && typeof u.input_tokens === 'number' ? { input: u.input_tokens, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 } : null;
    // Cumul croissant : la part de cette exécution est la différence ; sinon les chiffres sont déjà ceux de l'exécution.
    const total = !cumulative ? sum : usageBefore && FIELDS.every(k => cumulative[k] >= usageBefore[k]) ? Object.fromEntries(FIELDS.map(k => [k, cumulative[k] - usageBefore[k]])) : cumulative;
    const first = st.calls.values().next().value, raw = Number(r.total_cost_usd) || 0;
    return { engine: 'claude', model: [...st.models].join(', ') || st.model, ...total, totalTokens: total.input + total.cacheWrite + total.cacheRead + total.output,
      calls: st.calls.size, turns: r.num_turns || 0, tools: st.tools, firstCallContext: first ? ctx(first.usage) : null,
      durationMs: r.duration_ms || 0, apiMs: r.duration_api_ms || 0, costUsd: raw >= costBefore ? raw - costBefore : raw, costTotal: raw, usageTotal: cumulative,
      denials: Array.isArray(r.permission_denials) ? r.permission_denials.length : 0, byModel, source: byModel.length ? 'modelUsage' : u ? 'result' : 'stream' };
  }
  // Issue normalisée : réussite, texte final, erreur lisible, budget atteint.
  function outcome({ code, stderr = '' } = {}) {
    const r = st.result;
    if (r && !r.is_error && code === 0) return { ok: true, text: r.result || '' };
    return { ok: false, budget: r?.subtype === 'error_max_budget_usd', lostSession: /No conversation found/i.test(stderr + ' ' + (r?.result || '')),
      error: r?.result || (Array.isArray(r?.errors) ? r.errors.join(' ') : '') || stderr || 'Claude Code s’est arrêté sans résultat (code ' + code + ').' };
  }
  return { push, metrics, outcome, state: st };
}

const adapter = {
  name: 'claude', createCollector, env: childEnv,
  cmdRefusal: 'Sous Windows, indiquez claude.exe (installateur natif) dans COCKPIT_CLAUDE_BIN : un fichier .cmd passerait par un shell.',
  missing: command => 'Claude Code est introuvable (' + command + ') : installez-le ou indiquez son chemin dans COCKPIT_CLAUDE_BIN.',
};
function createEngine({ command = process.env.COCKPIT_CLAUDE_BIN || 'claude', prefixArgs = [], ...options } = {}) {
  const harness = h.createHarness({ adapter, command, prefixArgs, ...options });
  let probed; // sondé une fois par moteur : les options reconnues ne changent pas pendant que Cockpit tourne
  return { ...harness, buildArgs, flags: () => probed ||= probeFlags(command, prefixArgs, { execPath: options.execPath, env: options.baseEnv }) };
}

module.exports = { createEngine, buildArgs, VISUAL_CHECK, createCollector, probeFlags, childEnv, DENY_BASH, LEAN_SETTINGS, CAVEMAN, OPTIONAL_FLAGS };
