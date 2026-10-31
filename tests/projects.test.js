const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createProjects } = require('../projects.cjs');
const { createServer } = require('../server');

// Faux FeedMe : reproduit les routes agents réellement utilisées (aucune passerelle réelle).
function fakeFeedMe({ connected = true } = {}) {
  const state = { sends: [], conversations: new Map(), hold: null, reply: 'Fait : https://example.com/rapport\nSTATUT: TERMINÉ', active: false };
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    let body = ''; for await (const c of req) body += c; body = body ? JSON.parse(body) : {};
    const url = req.url;
    if (url === '/api/agents/') return send(200, { connections: [{ id: 'c1', name: 'OpenClaw', kind: 'openclaw', gateway: { state: connected ? 'connected' : 'disconnected' }, catalog: { agents: [{ id: 'homelab', name: 'homelab' }] } }] });
    if (url === '/api/agents/conversations' && req.method === 'POST') { const id = 'conv' + (state.conversations.size + 1); state.conversations.set(id, []); return send(200, { id }); }
    const m = /^\/api\/agents\/conversations\/([^/]+)(\/messages)?$/.exec(url);
    if (m && m[2]) {
      state.sends.push(body.text); state.conversations.get(m[1]).push({ role: 'user', content: body.text, status: 'complete' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: start\ndata: {}\n\n');
      const finish = () => { res.write('event: replace\ndata: ' + JSON.stringify({ text: state.reply }) + '\n\n'); res.write('event: done\ndata: {"status":"complete"}\n\n'); res.end(); state.conversations.get(m[1]).push({ role: 'assistant', content: state.reply, status: 'complete' }); };
      if (state.hold) state.hold.push(finish); else finish();
      return;
    }
    if (m) return send(200, { messages: state.conversations.get(m[1]) || [], active: state.active });
    send(404, { error: 'introuvable' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: 'http://127.0.0.1:' + server.address().port })));
}
async function setup(t, options) {
  const feed = await fakeFeedMe(options);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-projects-'));
  const make = () => createProjects({ dataDir, discover: async () => feed.origin, reconcileEvery: 3600000 });
  let projects = make();
  const server = createServer({ projects: { handle: (...a) => projects.handle(...a), allowedRoute: (...a) => projects.allowedRoute(...a) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { projects.close(); server.closeAllConnections(); server.close(); feed.server.closeAllConnections(); feed.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, method = 'GET', body) => { const r = await fetch(origin + '/api/projects/' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { api, feed, restart: () => { projects.close(); projects = make(); return projects; } };
}
const settle = () => new Promise(r => setTimeout(r, 120));
const agent = { connectionId: 'c1', agentId: 'homelab', name: 'homelab' };

test('full path: project, task, assignment, explicit launch, result to validate, acceptance', async t => {
  const { api, feed } = await setup(t);
  const project = (await api('projects', 'POST', { name: 'Homelab', context: { objective: 'Fiabiliser le serveur' } })).body;
  assert.equal(project.key, 'HO');
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'Sauvegardes', instructions: 'Planifier PBS', agent })).body;
  assert.equal(task.code, 'HO-1');
  await settle(); assert.equal(feed.state.sends.length, 0, 'creating and assigning never launches');
  const moved = (await api('tasks/' + task.id, 'PATCH', { status: 'doing' })).body;
  assert.equal(moved.runs.length, 0, 'a manual move shows no execution');
  const launched = await api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'k1' });
  assert.equal(launched.status, 202); assert.equal(launched.body.run.status, 'pending');
  await settle();
  const state = (await api('state')).body, saved = state.tasks[0], run = saved.runs[0];
  assert.equal(feed.state.sends.length, 1);
  assert.match(feed.state.sends[0], /Fiabiliser le serveur/); assert.match(feed.state.sends[0], /STATUT: TERMINÉ/);
  assert.equal(run.status, 'succeeded'); assert.equal(saved.status, 'review');
  assert.equal(run.result, 'Fait : https://example.com/rapport'); assert.equal(run.links[0].url, 'https://example.com/rapport');
  assert.equal(state.capabilities.interrupt, false);
  const accepted = (await api('tasks/' + task.id + '/accept', 'POST', {})).body;
  assert.equal(accepted.status, 'done');
});

test('repeated clicks and concurrent launches create a single execution', async t => {
  const { api, feed } = await setup(t);
  feed.state.hold = [];
  const project = (await api('projects', 'POST', { name: 'Cockpit' })).body;
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'A', instructions: 'B', agent })).body;
  const results = await Promise.all([api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'same' }), api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'same' }), api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'other' })]);
  await settle();
  const state = (await api('state')).body;
  assert.equal(state.tasks[0].runs.length, 1);
  assert.equal(feed.state.sends.length, 1);
  assert.ok(results.some(r => r.status === 409));
  assert.equal(state.tasks[0].runs[0].status, 'pending', 'not shown as started before the agent confirms');
  assert.notEqual(state.tasks[0].status, 'doing');
  feed.state.hold.forEach(f => f()); await settle();
});

test('unavailable agents and incomplete tasks are refused without creating a run', async t => {
  const { api, feed } = await setup(t, { connected: false });
  const project = (await api('projects', 'POST', { name: 'X' })).body;
  const empty = (await api('tasks', 'POST', { projectId: project.id, title: 'Sans consignes' })).body;
  const missing = await api('tasks/' + empty.id + '/launch', 'POST', { launchKey: 'a' });
  assert.equal(missing.status, 400); assert.match(missing.body.error, /consignes/);
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'T', instructions: 'I', agent })).body;
  const offline = await api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'b' });
  assert.equal(offline.status, 409); assert.match(offline.body.error, /indisponible/);
  assert.equal((await api('state')).body.tasks.every(t => t.runs.length === 0), true);
  assert.equal(feed.state.sends.length, 0);
});

test('a blocking question, an answer and a reprise keep the previous attempts', async t => {
  const { api, feed } = await setup(t);
  feed.state.reply = 'Quel disque cibler ?\nSTATUT: BLOQUÉ';
  const project = (await api('projects', 'POST', { name: 'Homelab' })).body;
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'Disque', instructions: 'Récupérer', agent })).body;
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '1' }); await settle();
  let saved = (await api('state')).body.tasks[0];
  assert.equal(saved.status, 'blocked'); assert.equal(saved.runs[0].outcome, 'question');
  feed.state.reply = 'Impossible : disque illisible\nSTATUT: ÉCHEC';
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '2', kind: 'answer', note: '/dev/sda' }); await settle();
  saved = (await api('state')).body.tasks[0];
  assert.equal(saved.runs[1].status, 'failed'); assert.match(saved.runs[1].error, /illisible/); assert.equal(saved.status, 'blocked');
  assert.match(feed.state.sends[1], /\/dev\/sda/);
  assert.equal(saved.conversation.id, 'conv1', 'the same agent conversation is reused');
  assert.equal(saved.runs.length, 2);
});

test('after a restart, a run is recovered from the gateway history and never resent', async t => {
  const { api, feed, restart } = await setup(t);
  feed.state.hold = [];
  const project = (await api('projects', 'POST', { name: 'P' })).body;
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'T', instructions: 'I', agent })).body;
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: 'x' }); await settle();
  const service = restart();
  feed.state.active = true; await service.reconcile();
  let saved = (await api('state')).body.tasks[0];
  assert.equal(saved.runs[0].status, 'started'); assert.equal(saved.runs[0].tracking, 'recovering');
  feed.state.active = false; feed.state.conversations.get('conv1').push({ role: 'assistant', content: 'Terminé\nSTATUT: TERMINÉ', status: 'complete' });
  await service.reconcile();
  saved = (await api('state')).body.tasks[0];
  assert.equal(saved.runs[0].status, 'succeeded'); assert.equal(saved.status, 'review');
  assert.equal(feed.state.sends.length, 1);
});

test('a task can be continued in the same conversation, even after acceptance, with a short message', async t => {
  const { api, feed } = await setup(t);
  const project = (await api('projects', 'POST', { name: 'Appli', context: { objective: 'Version iPhone' } })).body;
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'iPhone', instructions: 'Adapter l’écran', agent })).body;
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '1' }); await settle();
  await api('tasks/' + task.id + '/accept', 'POST', {});
  const again = await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '2', kind: 'reprise', note: 'Oui, continue.' });
  assert.equal(again.status, 202); await settle();
  const saved = (await api('state')).body.tasks[0];
  assert.equal(saved.status, 'review', 'the next result is to be validated again');
  assert.equal(saved.runs.length, 2); assert.equal(saved.runs[1].conversationId, saved.runs[0].conversationId);
  assert.match(feed.state.sends[1], /^Tâche AP-1 — « iPhone » : suite\.\n\nOui, continue\./);
  assert.doesNotMatch(feed.state.sends[1], /Version iPhone/, 'no need to resend the whole brief');
  // Consignes modifiées entre-temps : elles sont renvoyées en entier.
  await api('tasks/' + task.id, 'PATCH', { instructions: 'Adapter l’écran et le clavier' });
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '3', kind: 'reprise', note: 'Reprends avec ça' }); await settle();
  assert.match(feed.state.sends[2], /clavier/); assert.match(feed.state.sends[2], /Reprends avec ça/);
});

test('publishing follows the project procedure, automatic only when the user allowed it', async t => {
  const { api, feed } = await setup(t);
  const project = (await api('projects', 'POST', { name: 'Site', context: { publishing: 'git push origin main puis npm run deploy:tablet' } })).body;
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'Page', instructions: 'Faire', agent })).body;
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '1' }); await settle();
  assert.match(feed.state.sends[0], /## Publication \(procédure du projet\)\ngit push origin main/);
  assert.match(feed.state.sends[0], /demande mon accord avant de publier/);
  await api('projects/' + project.id, 'PATCH', { context: { ...project.context, autoPublish: true } });
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '2', kind: 'retry' }); await settle();
  assert.match(feed.state.sends[1], /## Publication \(autorisée par l’utilisateur pour ce projet\)/);
  assert.match(feed.state.sends[1], /publie-le toi-même en suivant exactement la procédure/);
});

test('closing a task from the chat: with or without a result, never while the agent works', async t => {
  const { api, feed } = await setup(t);
  const project = (await api('projects', 'POST', { name: 'Cockpit' })).body;
  const manual = (await api('tasks', 'POST', { projectId: project.id, title: 'Sans agent' })).body;
  const closed = (await api('tasks/' + manual.id + '/accept', 'POST', {})).body;
  assert.equal(closed.status, 'done'); assert.ok(closed.acceptedAt);
  const task = (await api('tasks', 'POST', { projectId: project.id, title: 'Chat', instructions: 'Faire', agent })).body;
  feed.state.hold = [];
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '1' }); await settle();
  const busy = await api('tasks/' + task.id + '/accept', 'POST', {});
  assert.equal(busy.status, 409, 'an agent at work keeps the task open');
  feed.state.hold.forEach(f => f()); feed.state.hold = null; await settle();
  // Une question après un résultat : clore ne valide pas l'ancien résultat à sa place.
  feed.state.reply = 'Quelle couleur ?\nSTATUT: BLOQUÉ';
  await api('tasks/' + task.id + '/launch', 'POST', { launchKey: '2', kind: 'reprise', note: 'Et le thème ?' }); await settle();
  const saved = (await api('state')).body.tasks.find(x => x.id === task.id);
  assert.equal(saved.runs[0].outcome, 'result');
  assert.equal(saved.runs.at(-1).outcome, 'question');
  const done = (await api('tasks/' + task.id + '/accept', 'POST', {})).body;
  assert.equal(done.status, 'done');
  assert.equal(done.runs.some(r => r.accepted), false, 'no result was validated by closing on a question');
});
