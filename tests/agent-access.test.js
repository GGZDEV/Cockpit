const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { createProjects } = require('../projects.cjs');
const { createAgentAccess, loadClients, tailscaleAddress } = require('../agent-access.cjs');

function fakeFeedMe() {
  const sends = [];
  const server = http.createServer((req, res) => {
    const send = (s, v) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/agents/') return send(200, { connections: [{ id: 'c1', name: 'OpenClaw', kind: 'openclaw', gateway: { state: 'connected' }, catalog: { agents: [{ id: 'homelab', name: 'Homelab' }, { id: 'main', name: 'Home' }] } }] });
    sends.push(req.url); send(404, { error: 'introuvable' });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, sends, origin: 'http://127.0.0.1:' + server.address().port })));
}
// Clonage simulé : aucun accès réseau ni git pendant les tests.
function fakeWorkspaces(root) {
  const clones = [];
  return { clones, root, target: repo => path.join(root, repo.split('/').pop()), clone: async repo => { clones.push(repo); if (/introuvable/.test(repo)) throw new Error('remote: Repository not found.'); return { path: path.join(root, repo.split('/').pop()), reused: false }; } };
}
const GH = name => 'https://github.com/ggzdev/' + name;
async function setup(t) {
  const feed = await fakeFeedMe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-agents-'));
  const workspaces = fakeWorkspaces(path.join(dir, 'dev'));
  const projects = createProjects({ dataDir: dir, discover: async () => feed.origin, reconcileEvery: 3600000, workspaces });
  const file = path.join(dir, 'agent-access.json');
  const clients = loadClients(file);
  const server = createAgentAccess({ projects, file, clients });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { projects.close(); server.closeAllConnections(); server.close(); feed.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/agent/v1/';
  const call = async (route, method = 'GET', body, key = clients.claude.token, headers = {}) => {
    const r = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { call, projects, feed, clients, base, dir, workspaces };
}

test('agent access: one key per agent, refused without key or from a web page', async t => {
  const { call, clients } = await setup(t);
  assert.deepEqual(Object.keys(clients).sort(), ['claude', 'codex', 'openclaw']);
  assert.notEqual(clients.claude.token, clients.openclaw.token);
  assert.equal((await call('state', 'GET', undefined, 'mauvaise')).status, 401);
  assert.equal((await call('state', 'GET', undefined, clients.claude.token, { Origin: 'https://exemple.fr' })).status, 403);
  assert.equal((await call('state')).status, 200);
});

test('agent can create and organise projects and tasks with names and French words', async t => {
  const { call, projects, feed } = await setup(t);
  const p = await call('projects', 'POST', { name: 'Maison connectée', status: 'actif', priority: 'haute', repository: GH('maison'), context: { objective: 'Tout automatiser' } });
  assert.equal(p.status, 201); assert.equal(p.body.key, 'MC'); assert.equal(p.body.status, 'active'); assert.equal(p.body.priority, 3); assert.equal(p.body.createdBy, 'Claude');
  const task = await call('tasks', 'POST', { project: 'maison connectee', title: 'Inventaire des capteurs', instructions: 'Lister', agent: 'Homelab', priority: 'urgent' });
  assert.equal(task.status, 201); assert.equal(task.body.code, 'MC-1'); assert.equal(task.body.agent, 'homelab (Homelab)'); assert.equal(task.body.status, 'todo');
  const full = projects.snapshot().tasks[0];
  assert.deepEqual(full.agent, { connectionId: 'c1', agentId: 'homelab', name: 'Homelab' }); assert.equal(full.createdBy, 'Claude'); assert.equal(full.runs.length, 0);
  assert.equal(feed.sends.length, 0, 'creating or assigning never contacts the agent');
  const moved = await call('tasks/mc-1', 'PATCH', { status: 'bloqué', due: '2026-12-01' });
  assert.equal(moved.body.status, 'blocked'); assert.equal(moved.body.due, '2026-12-01');
  const unknown = await call('tasks', 'POST', { project: 'Inexistant', title: 'x' });
  assert.equal(unknown.status, 404); assert.match(unknown.body.error, /MC \(Maison connectée\)/);
  assert.equal((await call('projects/MC', 'PATCH', { archived: true })).body.archived, true);
  assert.equal((await call('state')).body.projects.length, 0); assert.equal((await call('state?archived=1')).body.projects.length, 1);
  const badAgent = await call('tasks/MC-1', 'PATCH', { agent: 'personne' });
  assert.equal(badAgent.status, 400); assert.match(badAgent.body.error, /homelab \(Homelab\), main \(Home\)/);
});

test('agent cannot launch, accept, delete, fake "en cours" or validate a result', async t => {
  const { call, projects } = await setup(t);
  await call('projects', 'POST', { name: 'Test', repository: GH('test') });
  const task = (await call('tasks', 'POST', { project: 'Test', title: 'T', instructions: 'i', agent: 'homelab' })).body;
  for (const [route, method] of [['tasks/' + task.code + '/launch', 'POST'], ['tasks/' + task.code + '/accept', 'POST'], ['tasks/' + task.code, 'DELETE']]) {
    const r = await call(route, method, {}); assert.equal(r.status, 403, route + ' ' + method); assert.match(r.body.error, /réservé à l’utilisateur/);
  }
  assert.equal((await call('tasks/' + task.code, 'PATCH', { status: 'doing' })).status, 400);
  assert.equal((await call('tasks/' + task.code, 'PATCH', { status: 'doing', agent: null })).body.status, 'doing', 'a manual task may be in progress');
  // Résultat d'agent en attente de validation : l'agent ne peut pas le valider à la place de l'utilisateur.
  const saved = projects.snapshot().tasks[0];
  Object.assign(saved, { status: 'review', runs: [{ id: 'r', status: 'succeeded', outcome: 'result', events: [] }] });
  assert.equal((await call('tasks/' + task.code, 'PATCH', { status: 'done' })).status, 403);
  saved.runs[0].status = 'started';
  assert.equal((await call('tasks/' + task.code, 'PATCH', { title: 'Autre' })).status, 409, 'no edit during an execution');
});

test('MCP server exposes the tools and creates through the agent access', async t => {
  const { base, clients } = await setup(t);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'cockpit-projets.cjs'), '--client', 'codex', '--url', base.replace('/agent/v1/', '')], { env: { ...process.env, COCKPIT_TOKEN: clients.codex.token }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const pending = new Map(); let buffer = '';
  child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); pending.get(m.id)?.(m); } });
  let n = 0; const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const names = (await rpc('tools/list', {})).result.tools.map(x => x.name);
  assert.ok(names.includes('projets_creer_tache') && !names.some(x => /lancer|supprimer|valider/.test(x)));
  const created = await rpc('tools/call', { name: 'projets_creer_projet', arguments: { name: 'Vacances', context: { repository: GH('vacances') } } });
  assert.equal(created.result.structuredContent.createdBy, 'Codex');
  const task = await rpc('tools/call', { name: 'projets_creer_tache', arguments: { projet: 'Vacances', title: 'Réserver' } });
  assert.equal(task.result.structuredContent.code, 'VA-1');
  const shot = path.join(os.tmpdir(), 'mb-capture-' + process.pid + '.png'); fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  const joined = await rpc('tools/call', { name: 'projets_joindre_fichier', arguments: { tache: 'VA-1', chemin: shot } }); fs.rmSync(shot);
  assert.equal(joined.result.structuredContent.attachments[0].name, path.basename(shot));
  assert.ok(names.includes('projets_ici'));
  const err = await rpc('tools/call', { name: 'projets_modifier_tache', arguments: { tache: 'XX-9', status: 'done' } });
  assert.equal(err.result.isError, true);
});

test('Tailscale address detection only accepts the 100.64.0.0/10 range', () => {
  assert.equal(tailscaleAddress({ eth: [{ family: 'IPv4', address: '192.168.1.27' }], ts: [{ family: 'IPv4', address: '100.101.102.103' }] }), '100.101.102.103');
  assert.equal(tailscaleAddress({ eth: [{ family: 'IPv4', address: '100.200.1.1' }] }), null);
});

test('an agent can describe the publishing procedure but never allow automatic publishing', async t => {
  const { call, projects } = await setup(t);
  await call('projects', 'POST', { name: 'Pub', repository: 'https://github.com/ggzdev/pub', context: { publishing: 'git push', autoPublish: true } });
  assert.equal(projects.snapshot().projects[0].context.autoPublish, undefined);
  assert.equal(projects.snapshot().projects[0].context.publishing, 'git push');
  await call('projects/PU', 'PATCH', { context: { autoPublish: true } });
  assert.equal(projects.snapshot().projects[0].context.autoPublish, undefined);
});
