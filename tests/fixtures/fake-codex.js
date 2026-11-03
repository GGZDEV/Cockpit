'use strict';
// Faux binaire Codex pour les tests : aucun réseau, aucun jeton, aucune lecture de CODEX_HOME.
// Journalise chaque appel (arguments, dossier, demande reçue, variables sensibles vues) dans FAKE_CODEX_LOG,
// imite la liaison session ↔ dossier et émet un flux JSONL réaliste de `codex exec --json`.
// Bac à sable simulé : rien n'est écrit en lecture seule. Comportement : fichier « mode » à côté du journal
// (ok, auth, quota, tool-quota, write-quota, crash, hang, blocked, fail-marker, no-usage).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', main);

function main() {
  const log = process.env.FAKE_CODEX_LOG, dir = path.dirname(log);
  const modeFile = path.join(dir, 'mode'), mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';
  const store = path.join(dir, 'sessions.json'), sessions = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
  const resume = args[0] === 'exec' && args[1] === 'resume';
  const sandbox = resume ? (args.find(a => a.startsWith('sandbox_mode=')) || '').replace(/^sandbox_mode="(.*)"$/, '$1') : args[args.indexOf('--sandbox') + 1];
  const env = { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN: process.env.GH_TOKEN, PATH: !!process.env.PATH };
  fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), input, mode, sandbox, env }) + '\n');
  if (args.at(-1) !== '-') { process.stderr.write('la demande doit arriver sur stdin\n'); process.exit(3); }
  const id = resume ? args.at(-2) : crypto.randomUUID();
  if (resume && sessions[id] !== process.cwd()) { process.stderr.write('Error: No saved session found with ID ' + id + '\n'); process.exit(1); }
  if (!resume) { sessions[id] = process.cwd(); fs.writeFileSync(store, JSON.stringify(sessions)); }
  if (mode === 'crash') { process.stderr.write('boom token=abcdef123456789\n'); process.exit(2); }
  const out = value => process.stdout.write(JSON.stringify(value) + '\n');
  out({ type: 'thread.started', thread_id: id });
  out({ type: 'turn.started' });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const failed = message => { out({ type: 'error', message }); out({ type: 'turn.failed', error: { message } }); process.exit(1); };
  if (mode === 'auth') return failed('unexpected status 401 Unauthorized: Your authentication token has expired. Please run codex login.');
  if (mode === 'quota') return failed('You\'ve hit your usage limit (usage_limit_reached). Try again later.');
  if (mode === 'write-quota') { if (sandbox === 'workspace-write') fs.writeFileSync('partiel.txt', 'écrit avant la panne\n'); return failed('429 Too Many Requests'); }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Je lis le dépôt.' } });
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat README.md --token=ghp_abcdefghijklmnopqrstuvwxyz"', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat README.md"', aggregated_output: '# repo', exit_code: 0, status: 'completed' } });
  if (mode === 'tool-quota') return failed('429 Too Many Requests: rate limit');
  const plan = sandbox === 'read-only';
  if (!plan && mode === 'ok') {
    fs.appendFileSync('feature-codex.txt', 'fait par le faux Codex\n');
    out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: path.join(process.cwd(), 'feature-codex.txt'), kind: 'add' }], status: 'completed' } });
  }
  const text = mode === 'blocked' ? 'Quelle branche de base ?\nSTATUT: BLOQUÉ' : mode === 'fail-marker' ? 'Impossible : dépendance absente.\nSTATUT: ÉCHEC'
    : plan ? '## Plan Codex\n1. Ajouter feature-codex.txt\n2. Lancer les tests\nPlan prêt.' : 'Fait : feature-codex.txt ajouté (non commité).';
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text } });
  out({ type: 'turn.completed', ...(mode === 'no-usage' ? {} : { usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 30 } }) });
}
