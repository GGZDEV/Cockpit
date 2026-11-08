'use strict';
// Banc commun des tests des moteurs directs : dépôts Git jetables, faux FeedMe, faux Claude et faux Codex (aucun jeton).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createProjects } = require('../../projects.cjs');
const claude = require('../../claude-direct.cjs');
const codex = require('../../codex-direct.cjs');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const FAKE_CODEX = path.join(__dirname, '..', 'fixtures', 'fake-codex.js');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'README.md'), '# ' + path.basename(dir) + '\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), description: 'Dépôt de test', scripts: { test: 'node --test tests/' } }));
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), body); }
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  return dir;
}
// Faux FeedMe minimal pour vérifier que le moteur OpenClaw fonctionne toujours à côté.
function fakeFeedMe() {
  const sends = [];
  const server = http.createServer(async (req, res) => {
    const send = (s, v) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/api/agents/') return send(200, { connections: [{ id: 'c1', name: 'OpenClaw', kind: 'openclaw', gateway: { state: 'connected' }, catalog: { agents: [{ id: 'homelab', name: 'homelab' }] } }] });
    if (req.url === '/api/agents/conversations') return send(200, { id: 'conv1' });
    if (req.url.endsWith('/messages')) { sends.push(JSON.parse(body).text); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('event: start\ndata: {}\n\nevent: replace\ndata: {"text":"Fait\\nSTATUT: TERMINÉ"}\n\nevent: done\ndata: {}\n\n'); return; }
    send(404, { error: 'introuvable' });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, sends, origin: 'http://127.0.0.1:' + server.address().port })));
}

// codexEnabled : Codex direct (activé comme Claude par défaut dans les tests qui le demandent).
// Préparation des worktrees (npm ci, tests de départ) neutre par défaut : les tests qui la vérifient fournissent la leur.
const NO_PREPARATION = { plan: () => null, install: async () => null, testScript: () => false, baseline: async () => null };
async function setup(t, { engine: engineOptions = {}, codexEnabled = false, codexEngine: codexOptions = {}, repos = {}, taskEnv = NO_PREPARATION } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-direct-'));
  const root = path.join(dir, 'dev'), log = path.join(dir, 'fake', 'calls.log'), codexLog = path.join(dir, 'fake-codex', 'calls.log');
  fs.mkdirSync(path.dirname(log), { recursive: true }); fs.mkdirSync(path.dirname(codexLog), { recursive: true });
  for (const name of ['alpha', 'beta']) repo(path.join(root, name), repos[name]);
  const feed = await fakeFeedMe();
  const gitAsync = args => new Promise((resolve, reject) => require('node:child_process').execFile('git', args, { encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out)));
  const workspaces = { root, git: gitAsync, target: url => path.join(root, url.split('/').pop()), clone: async url => ({ path: path.join(root, url.split('/').pop()), reused: true }) };
  // NODE_TEST_CONTEXT ferait d'un « node --test » imbriqué un sous-test du lanceur courant.
  const baseEnv = { ...process.env, NODE_TEST_CONTEXT: undefined, FAKE_CLAUDE_LOG: log, FAKE_CODEX_LOG: codexLog, GH_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz', ANTHROPIC_API_KEY: 'sk-ant-should-not-pass',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-keep', OPENAI_API_KEY: 'sk-openai-should-not-pass-0123456789', CODEX_API_KEY: 'codex-should-not-pass', CODEX_HOME: path.join(dir, 'ailleurs') };
  const worktreeRoot = path.join(dir, 'worktrees');
  const engine = claude.createEngine({ enabled: true, command: process.execPath, prefixArgs: [FAKE], workspacesRoot: root, worktreeRoot, baseEnv, ...engineOptions });
  const codexEng = codex.createEngine({ enabled: codexEnabled, command: FAKE_CODEX, codexHome: path.join(dir, 'codex-home'), workspacesRoot: root, worktreeRoot, baseEnv, ...codexOptions });
  const make = () => createProjects({ dataDir: path.join(dir, 'data'), discover: async () => feed.origin, reconcileEvery: 3600000, workspaces, claudeEngine: engine, codexEngine: codexEng, taskEnv });
  const services = [make()];
  t.after(async () => {
    services.forEach(s => s.close()); feed.server.closeAllConnections(); feed.server.close();
    while (engine.active.size || codexEng.active.size) await new Promise(r => setTimeout(r, 20)); // processus arrêtés et état final écrit
    await new Promise(r => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const service = () => services.at(-1);
  const ui = async (route, method = 'GET', body, raw) => {
    const res = { status: 0, headers: {}, chunks: [], writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(v) { if (v) this.chunks.push(Buffer.from(v)); this.done?.(); }, on() { return this; }, once() { return this; }, emit() {}, write(c) { this.chunks.push(Buffer.from(c)); return true; } };
    const finished = new Promise(r => { res.done = r; });
    const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield data; } };
    const json = (r, s, v) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
    service().handle(req, res, new URL('http://localhost/api/projects/' + route), json);
    await finished;
    const out = Buffer.concat(res.chunks);
    return { status: res.status, body: /json/.test(res.headers['Content-Type'] || '') ? JSON.parse(out) : out };
  };
  // Accès des agents (API /agent/v1) sans serveur HTTP : mêmes routes que Claude, Codex ou l'agent cockpit d'OpenClaw.
  const agent = async (route, method = 'GET', body) => {
    const res = { status: 0, headers: {}, chunks: [], writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(v) { if (v) this.chunks.push(Buffer.from(v)); this.done?.(); }, on() { return this; }, once() { return this; }, emit() {}, write(c) { this.chunks.push(Buffer.from(c)); return true; } };
    const finished = new Promise(r => { res.done = r; });
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield data; } };
    const json = (r, st, v) => { r.writeHead(st, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
    service().agentHandle(req, res, new URL('http://localhost/agent/v1/' + route), json, 'claude');
    await finished;
    return { status: res.status, body: JSON.parse(Buffer.concat(res.chunks)) };
  };
  const read = file => () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  // Les appels « --help » du sondage d'options ne sont pas des exécutions : ils ne passent pas par le journal.
  const calls = read(log), codexCalls = read(codexLog);
  const mode = value => fs.writeFileSync(path.join(path.dirname(log), 'mode'), value);
  const codexMode = value => fs.writeFileSync(path.join(path.dirname(codexLog), 'mode'), value);
  const task = async tid => (await ui('state')).body.tasks.find(x => x.id === tid);
  const until = async (tid, check, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) { const value = await task(tid); if (check(value)) return value; if (Date.now() > end) throw new Error('Délai dépassé : ' + JSON.stringify(value.runs.at(-1)?.events)); await new Promise(r => setTimeout(r, 25)); }
  };
  const lastDone = tid => until(tid, x => x.runs.length && !x.runs.some(r => ['pending', 'started'].includes(r.status)));
  const project = async (name, extra = {}) => {
    const p = (await ui('projects', 'POST', { name, context: { repository: 'https://github.com/ggzdev/' + name, objective: 'Objectif ' + name }, ...extra })).body;
    await new Promise(r => setTimeout(r, 30)); // clonage simulé puis préparation du CLAUDE.md
    return (await ui('state')).body.projects.find(x => x.id === p.id);
  };
  let n = 0;
  const create = async (pid, extra = {}) => (await ui('tasks', 'POST', { projectId: pid, title: 'Tâche ' + (++n), instructions: 'Ajoute feature.txt', ...extra })).body;
  const launch = (tid, body = {}) => ui('tasks/' + tid + '/launch', 'POST', { launchKey: 'k' + (++n), ...body });
  return { ui, agent, calls, codexCalls, mode, codexMode, task, until, lastDone, project, create, launch, dir, root, engine, codexEngine: codexEng, services, make, feed };
}
const arg = (args, name) => args[args.indexOf(name) + 1];

module.exports = { setup, repo, git, arg, FAKE, FAKE_CODEX };
