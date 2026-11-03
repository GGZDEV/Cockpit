'use strict';
// Adaptateur « Codex direct » (plomberie commune : direct-harness.cjs) : `codex exec --json` (nouvelle session) puis
// `codex exec resume <id>` (même session), lecture du flux JSONL, environnement et CODEX_HOME dédié.
// Bac à sable de Codex : lecture seule pour l'analyse, écriture dans le worktree seulement pour l'exécution et la correction,
// sans réseau ni recherche web. Jamais --dangerously-bypass-approvals-and-sandbox. Demande sur l'entrée standard, jamais de shell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./direct-harness.cjs');

// Codex installé par OpenClaw sur le serveur ; ailleurs, COCKPIT_CODEX_BIN ou « codex » dans le PATH.
const OPENCLAW_CODEX = '/home/openclaw/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex/bin/codex.js';
const defaultCommand = (env = process.env, exists = fs.existsSync) => env.COCKPIT_CODEX_BIN || (exists(OPENCLAW_CODEX) ? OPENCLAW_CODEX : 'codex');
// Dossier de Codex propre à Cockpit (connexion, sessions), distinct du ~/.codex de l'utilisateur.
const defaultHome = (env = process.env) => env.COCKPIT_CODEX_HOME || path.join(os.homedir(), '.cockpit', 'codex-home');
const SESSION = /^[A-Za-z0-9][\w-]{7,99}$/;
const FORBIDDEN = '--dangerously-bypass-approvals-and-sandbox';

// Arguments de Codex. Le bac à sable est imposé en ligne de commande (la configuration de CODEX_HOME est ignorée) :
// --sandbox pour une nouvelle session, -c sandbox_mode=… pour une reprise (exec resume n'a pas d'option --sandbox).
// /tmp et TMPDIR ne sont pas inscriptibles : Codex n'écrit que dans le worktree de la tâche.
function buildArgs({ mode = 'work', sessionId, fresh, settings, model }) {
  const s = h.directSettings(settings);
  const sandbox = mode === 'plan' ? 'read-only' : 'workspace-write';
  const common = ['--json', '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'];
  if (model || s.codexModel) common.push('--model', model || s.codexModel);
  if (s.codexEffort) common.push('-c', `model_reasoning_effort="${s.codexEffort}"`);
  if (fresh) return ['exec', ...common, '--sandbox', sandbox, '-'];
  if (!SESSION.test(String(sessionId || ''))) throw new h.DirectError(409, 'Identifiant de session Codex invalide : relancez l’analyse.');
  return ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, sessionId, '-'];
}

// ----- Lecture du flux JSONL de `codex exec --json` ----------------------------------------------
// thread.started (session), item.started/completed (réponse, commande, fichiers…), turn.completed (compteurs), turn.failed, error.
const short = value => h.redact(h.clip(value, 100)).replace(/\s+/g, ' ');
const TOOL = { command_execution: i => 'Commande · ' + short(i.command), file_change: i => 'Fichiers · ' + short((i.changes || []).map(c => path.basename(String(c.path || ''))).join(', ')),
  mcp_tool_call: i => 'Outil · ' + short([i.server, i.tool].filter(Boolean).join('/')), web_search: i => 'Recherche web · ' + short(i.query) };
function createCollector({ model = '' } = {}) {
  const st = { sessionId: '', model, text: '', plan: '', tools: 0, activity: 0, turns: 0, usage: null, errors: [], completed: false, failed: false, seen: new Set() };
  function push(raw) {
    let m; try { m = JSON.parse(raw); } catch { return null; }
    if (!m || typeof m !== 'object') return null;
    if (m.type === 'thread.started') { st.sessionId = SESSION.test(String(m.thread_id || '')) ? m.thread_id : ''; return { kind: 'init', model: st.model }; }
    if (m.type === 'item.started' || m.type === 'item.updated' || m.type === 'item.completed') {
      const i = m.item || {}, first = !st.seen.has(i.id); st.seen.add(i.id);
      if (i.type === 'error') { st.errors.push(String(i.message || '')); return null; }
      if (first) st.activity++; // toute réponse, réflexion ou action du modèle : le moteur a commencé à travailler
      if (i.type === 'agent_message' && m.type === 'item.completed' && String(i.text || '').trim()) { st.text = String(i.text); return { kind: 'text' }; }
      if (TOOL[i.type] && first) { st.tools++; return { kind: 'tool', text: TOOL[i.type](i) }; }
      return null;
    }
    if (m.type === 'turn.completed') {
      st.turns++; st.completed = true;
      const u = m.usage;
      if (u && typeof u.input_tokens === 'number') {
        const a = st.usage ||= { input: 0, cached: 0, output: 0, reasoning: 0 };
        a.input += u.input_tokens || 0; a.cached += u.cached_input_tokens || 0; a.output += u.output_tokens || 0; a.reasoning += u.reasoning_output_tokens || 0;
      }
      return { kind: 'result' };
    }
    if (m.type === 'turn.failed') { st.failed = true; st.errors.push(String(m.error?.message || 'Échec du tour Codex.')); return { kind: 'result' }; }
    if (m.type === 'error') { st.errors.push(String(m.message || '')); return null; }
    return null;
  }
  // Compteurs : seulement ce que Codex expose. Coût, écriture de cache, nombre d'appels et durée côté API : non exposés (null).
  // Entrée = input_tokens − cached_input_tokens (même sens que pour Claude : hors cache). Durée mesurée par Cockpit.
  // model : modèle demandé à Codex (--model) ; sans lui, le modèle utilisé n'est pas exposé.
  function metrics({ durationMs = null, model: requested = '' } = {}) {
    const u = st.usage;
    return { engine: 'codex', model: requested || st.model || null, input: u ? Math.max(0, u.input - u.cached) : null, cacheWrite: null, cacheRead: u ? u.cached : null, output: u ? u.output : null,
      reasoning: u ? u.reasoning : null, calls: null, turns: st.turns, tools: st.tools, durationMs, apiMs: null, costUsd: null, byModel: [], source: u ? 'codex-jsonl' : 'none' };
  }
  function outcome({ code, stderr = '' } = {}) {
    if (st.completed && !st.failed && code === 0) return { ok: true, text: st.text };
    const error = st.errors.filter(Boolean).join(' ') || stderr || 'Codex s’est arrêté sans résultat (code ' + code + ').';
    return { ok: false, budget: false, lostSession: /no (saved )?(session|conversation|thread|rollout)\b[^\n]*found|(session|thread)[^\n]*not found/i.test(error + ' ' + stderr), error };
  }
  return { push, metrics, outcome, state: st };
}

// Environnement de Codex : aucune variable secrète (OPENAI_API_KEY, CODEX_API_KEY, jetons… retirés, l'OAuth de Claude aussi) ;
// l'authentification vient seulement de la connexion ChatGPT enregistrée dans le CODEX_HOME dédié.
const childEnv = (base, home) => h.childEnv(base, { drop: ['CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'], set: { CODEX_HOME: home } });

function createEngine({ command = defaultCommand(), codexHome = defaultHome(), model = '', workspacesRoot, ...options } = {}) {
  const home = path.resolve(codexHome);
  const adapter = {
    name: 'codex', createCollector: () => createCollector({ model }),
    env: base => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); return childEnv(base, home); },
    cmdRefusal: 'Sous Windows, indiquez codex.exe ou le script codex.js dans COCKPIT_CODEX_BIN : un fichier .cmd passerait par un shell.',
    missing: cmd => 'Codex est introuvable (' + cmd + ') : installez-le ou indiquez son chemin dans COCKPIT_CODEX_BIN.',
  };
  const harness = h.createHarness({ adapter, command, workspacesRoot, ...options });
  // CODEX_HOME contient la connexion de Codex : jamais dans un dossier de projet ni de worktree, où un moteur pourrait l'écrire ou le commiter.
  const unsafeHome = [workspacesRoot, harness.worktreeRoot].filter(Boolean).some(dir => home === path.resolve(dir) || h.insideDir(home, dir));
  function run(options) {
    if (unsafeHome) return Promise.resolve({ collector: adapter.createCollector(), durationMs: 0, spawnError: 'CODEX_HOME (' + home + ') est dans le dossier des projets ou des worktrees : refusé. Choisissez un autre dossier (COCKPIT_CODEX_HOME).' });
    if (options.args.includes(FORBIDDEN)) throw new Error('Option interdite : ' + FORBIDDEN);
    return harness.run(options);
  }
  return { ...harness, run, buildArgs, codexHome: home, command };
}

module.exports = { createEngine, buildArgs, createCollector, childEnv, defaultCommand, defaultHome, OPENCLAW_CODEX, FORBIDDEN };
