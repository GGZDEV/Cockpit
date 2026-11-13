'use strict';
// Faux binaire Claude Code pour les tests : aucun réseau, aucun jeton.
// Journalise chaque appel (arguments, dossier, demande reçue, variables sensibles vues, CLAUDE.md présent) dans FAKE_CLAUDE_LOG,
// imite la liaison session ↔ dossier de Claude Code (et le coût cumulé d'une session reprise) et émet un flux stream-json réaliste.
// Comportement : fichier « mode » à côté du journal (ok, blocked, fail-marker, error, crash, hang, budget, quota, auth, tool-quota, old-cli).
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const log = process.env.FAKE_CLAUDE_LOG, dir = path.dirname(log);
const modeFile = path.join(dir, 'mode'), mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';

// `claude --help` : liste des options. Le mode « old-cli » imite une version qui ignore les options récentes.
if (args.includes('--help')) {
  const flags = ['--print', '--output-format', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--tools', '--permission-mode', '--allowedTools', '--disallowedTools', '--add-dir', '--model', '--session-id', '--resume'];
  if (mode !== 'old-cli') flags.push('--settings', '--max-budget-usd', '--exclude-dynamic-system-prompt-sections', '--effort');
  process.stdout.write('Usage: claude [options]\n' + flags.map(f => '  ' + f + ' <v>').join('\n') + '\n');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
if (opt('--input-format') === 'stream-json') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.type === 'user') { input = m.message.content; main(); }
    if (m.type === 'control_response') {
      fs.appendFileSync(path.join(dir, 'responses.log'), JSON.stringify(m) + '\n');
      process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Réponse native reçue', session_id: opt('--session-id') || opt('--resume') }) + '\n');
    }
  });
} else {
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', main);
}

function main() {
  const store = path.join(dir, 'sessions.json'), sessions = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
  const resume = opt('--resume'), fresh = opt('--session-id'), id = resume || fresh;
  const claudeMd = fs.existsSync('CLAUDE.md') ? fs.readFileSync('CLAUDE.md', 'utf8').slice(0, 200) : null;
  fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), input, mode, claudeMd, env: { GH_TOKEN: process.env.GH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, PATH: !!process.env.PATH } }) + '\n');
  if (resume && !sessions[resume]) { process.stderr.write('No conversation found with session ID: ' + resume + '\n'); process.exit(1); }
  if (fresh) { sessions[fresh] = { cwd: process.cwd(), cost: 0 }; fs.writeFileSync(store, JSON.stringify(sessions)); }
  if (mode === 'crash') { process.stderr.write('boom token=abcdef123456789\n'); process.exit(2); }
  const model = opt('--model') || 'claude-opus-5-5';
  const out = value => process.stdout.write(JSON.stringify(value) + '\n');
  out({ type: 'system', subtype: 'init', session_id: id, model, cwd: process.cwd(), tools: (opt('--tools') || '').split(',') });
  if (mode === 'native-question' || mode === 'native-permission') {
    out({ type: 'control_request', request_id: 'native-1', request: { subtype: 'can_use_tool', tool_name: mode === 'native-question' ? 'AskUserQuestion' : 'Bash', input: mode === 'native-question' ? { questions: [{ question: 'Quelle branche ?', options: [{label:'main'}, {label:'dev'}] }] } : { command: 'echo allowed' } } }); return;
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  // Indisponibilités : quota ou authentification avant tout travail (secours permis), ou après un premier outil (secours refusé).
  const unavailable = { quota: 'API Error: 429 rate_limit_error · Claude usage limit reached', auth: 'Invalid API key · Please run /login', 'tool-quota': 'API Error: 429 rate_limit_error' }[mode];
  if (unavailable) {
    if (mode === 'tool-quota') out({ type: 'assistant', message: { id: 'msg_q', model, content: [{ type: 'tool_use', id: 'tq', name: 'Read', input: { file_path: 'README.md' } }], usage: { input_tokens: 3, output_tokens: 2 } } });
    out({ type: 'result', subtype: 'success', is_error: true, result: unavailable, duration_ms: 20, num_turns: 0, session_id: id, total_cost_usd: 0 });
    process.exit(1);
  }
  const plan = opt('--permission-mode') === 'plan';
  const usage = (i, w, r, o) => ({ input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o });
  // Même message en deux morceaux (outil puis texte) : un seul appel doit être compté.
  out({ type: 'assistant', message: { id: 'msg_1', model, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }], usage: usage(10, 1000, 0, 50) } });
  out({ type: 'assistant', message: { id: 'msg_1', model, content: [{ type: 'text', text: 'Je lis le dépôt.' }], usage: usage(10, 1000, 0, 50) } });
  // Captures de visual-check : deux PNG et un fichier qui n'en est pas un, dans le dossier fourni par Cockpit.
  if (mode === 'visual' && process.env.COCKPIT_VISUAL_DIR) {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    for (const name of ['accueil-mobile.png', 'accueil-bureau.png']) fs.writeFileSync(path.join(process.env.COCKPIT_VISUAL_DIR, name), png);
    fs.writeFileSync(path.join(process.env.COCKPIT_VISUAL_DIR, 'notes.txt'), 'ignoré');
  }
  if (!plan && mode === 'ok') {
    fs.appendFileSync('feature.txt', 'fait par le faux Claude\n');
    execFileSync('git', ['add', 'feature.txt']);
    execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-qm', 'Fonction ajoutée']);
    out({ type: 'assistant', message: { id: 'msg_2', model, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git commit -m x --token=ghp_abcdefghijklmnopqrstuvwxyz' } }], usage: usage(4, 100, 1000, 20) } });
  }
  if (plan) out({ type: 'assistant', message: { id: 'msg_3', model, content: [{ type: 'tool_use', id: 't3', name: 'ExitPlanMode', input: { plan: '## Plan\n1. Ajouter feature.txt\n2. Lancer les tests' } }], usage: usage(2, 0, 1100, 40) } });
  const text = mode === 'blocked' ? 'Quelle branche de base ?\nSTATUT: BLOQUÉ' : mode === 'fail-marker' ? 'Impossible : dépendance absente.\nSTATUT: ÉCHEC'
    : plan ? 'Plan prêt : ajouter feature.txt puis lancer les tests.' : 'Fait : feature.txt ajouté et commité.';
  out({ type: 'assistant', message: { id: 'msg_4', model, content: [{ type: 'text', text }], usage: usage(5, 200, 1000, 80) } });
  const session = sessions[id] || { cost: 0 }, cost = session.cost + (mode === 'budget' ? 0.5 : 0.0123);
  // Comme Claude Code lors d'une reprise : les compteurs annoncés sont cumulés sur toute la conversation.
  const add = (a, b) => ({ inputTokens: (a?.inputTokens || 0) + b.inputTokens, outputTokens: (a?.outputTokens || 0) + b.outputTokens, cacheReadInputTokens: (a?.cacheReadInputTokens || 0) + b.cacheReadInputTokens, cacheCreationInputTokens: (a?.cacheCreationInputTokens || 0) + b.cacheCreationInputTokens, costUSD: (a?.costUSD || 0) + b.costUSD });
  const modelUsage = { ...(session.modelUsage || {}) };
  modelUsage[model] = add(modelUsage[model], { inputTokens: 21, outputTokens: 190, cacheReadInputTokens: 2000, cacheCreationInputTokens: 1300, costUSD: 0.012 });
  modelUsage['claude-haiku-5-5'] = add(modelUsage['claude-haiku-5-5'], { inputTokens: 300, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0003 });
  sessions[id] = { ...session, cost, modelUsage }; fs.writeFileSync(store, JSON.stringify(sessions));
  if (mode === 'error' || mode === 'budget') { out({ type: 'result', subtype: mode === 'budget' ? 'error_max_budget_usd' : 'error_during_execution', is_error: true, duration_ms: 50, num_turns: 1, session_id: id, total_cost_usd: cost, errors: ['Erreur simulée'] }); process.exit(1); }
  // Coût annoncé = cumul de la conversation entière (comme Claude Code lors d'une reprise).
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: 3, result: text, session_id: id, total_cost_usd: cost,
    usage: usage(21, 1300, 2000, 190), permission_denials: [], modelUsage });
}
