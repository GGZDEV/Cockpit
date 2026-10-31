const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createProjects } = require('../projects.cjs');
const { createAgentAccess, loadClients } = require('../agent-access.cjs');
const { createWorkspaces, githubRepo } = require('../workspace.cjs');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GH = name => 'https://github.com/ggzdev/' + name;

// Passerelle simulée : le catalogue en cache ne connaît pas encore « site-vitrine », la relecture si.
function fakeFeedMe() {
  const server = http.createServer((req, res) => {
    const send = (s, v) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/agents/') return send(200, { connections: [{ id: 'c1', name: 'OpenClaw', kind: 'openclaw', gateway: { state: 'connected' }, catalog: { agents: [{ id: 'main', name: 'Home' }] } }] });
    if (req.url === '/api/agents/connections/c1/agents') return send(200, { agents: [{ id: 'main', name: 'Home' }, { id: 'site-vitrine', name: 'Site vitrine' }] });
    send(404, { error: 'introuvable' });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, origin: 'http://127.0.0.1:' + server.address().port })));
}
function fakeWorkspaces(root) {
  const clones = [];
  return { clones, target: repo => path.join(root, repo.split('/').pop()),
    clone: async repo => { clones.push(repo); if (/introuvable/.test(repo)) throw new Error('remote: Repository not found.'); return { path: path.join(root, repo.split('/').pop()), reused: false }; } };
}
async function setup(t) {
  const feed = await fakeFeedMe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ws-'));
  const workspaces = fakeWorkspaces(path.join(dir, 'dev'));
  const projects = createProjects({ dataDir: dir, discover: async () => feed.origin, reconcileEvery: 3600000, workspaces });
  const clients = loadClients(path.join(dir, 'agent-access.json'));
  const server = createAgentAccess({ projects, clients });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { projects.close(); server.closeAllConnections(); server.close(); feed.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/agent/v1/';
  const call = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + clients.openclaw.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  // Interface Projets (même service que la page web).
  const ui = async (route, method = 'GET', body, raw) => {
    const res = { status: 0, headers: {}, chunks: [], writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(v) { if (v) this.chunks.push(Buffer.from(v)); this.done?.(); }, on() { return this; }, once() { return this; }, emit() {}, write(c) { this.chunks.push(Buffer.from(c)); return true; } };
    const finished = new Promise(r => { res.done = r; });
    const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield data; } };
    const json = (r, s, v) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); };
    projects.handle(req, res, new URL('http://localhost/api/projects/' + route), json);
    await finished;
    const out = Buffer.concat(res.chunks);
    return { status: res.status, body: /json/.test(res.headers['Content-Type'] || '') ? JSON.parse(out) : out };
  };
  return { call, ui, projects, workspaces, dir };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('GitHub addresses are parsed strictly', () => {
  assert.equal(githubRepo('https://github.com/GGZDEV/Cockpit.git').web, 'https://github.com/GGZDEV/Cockpit');
  assert.equal(githubRepo('https://github.com/GGZDEV/Cockpit/').name, 'Cockpit');
  for (const bad of ['git@github.com:a/b.git', 'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/..', 'file:///c/x', '']) assert.equal(githubRepo(bad), null, bad);
});

test('an agent project needs a GitHub repository and is cloned on this PC', async t => {
  const { call, workspaces, projects } = await setup(t);
  const none = await call('projects', 'POST', { name: 'Sans dépôt' });
  assert.equal(none.status, 400); assert.match(none.body.error, /GitHub est obligatoire/);
  assert.equal((await call('projects', 'POST', { name: 'Mauvais', repository: 'https://gitlab.com/a/b' })).status, 400);
  const p = await call('projects', 'POST', { name: 'Site vitrine', repository: 'https://github.com/ggzdev/site-vitrine.git', agent: 'site-vitrine' });
  assert.equal(p.status, 201);
  assert.equal(p.body.context.repository, GH('site-vitrine'));
  assert.equal(p.body.agent, 'site-vitrine (Site vitrine)', 'a freshly created OpenClaw agent is found by re-reading the gateway');
  assert.equal(p.body.localFolder.status, 'cloning');
  await settle();
  assert.deepEqual(workspaces.clones, [GH('site-vitrine')]);
  const ready = (await call('state')).body.projects[0];
  assert.equal(ready.localFolder.status, 'ready'); assert.match(ready.localFolder.path, /site-vitrine$/);
  assert.equal((await call('projects', 'POST', { name: 'Doublon', repository: GH('site-vitrine') })).status, 409);
  assert.equal((await call('projects/SV', 'PATCH', { repository: '' })).status, 400, 'the repository cannot be removed by an agent');

  // Les tâches reprennent l'agent du projet sans réglage.
  const task = await call('tasks', 'POST', { project: 'SV', title: 'Page d’accueil', instructions: 'Créer la page', expected: 'Une PR' });
  assert.equal(task.body.agent, 'site-vitrine (Site vitrine)'); assert.equal(task.body.localFolder, ready.localFolder.path);
  assert.equal((await call('tasks', 'POST', { project: 'SV', title: 'À la main', agent: null })).body.agent, 'manuelle');
  const brief = projects.brief(projects.snapshot().tasks[0], projects.snapshot().projects[0], { kind: 'initial' });
  assert.match(brief, /Copie locale sur le PC de l’utilisateur : .*site-vitrine/);

  // Claude Code ouvert dans le dossier (ou un sous-dossier) retrouve le projet.
  const here = await call('workspace?path=' + encodeURIComponent(path.join(ready.localFolder.path, 'src')));
  assert.equal(here.status, 200); assert.equal(here.body.project.key, 'SV'); assert.equal(here.body.tasks.length, 2);
  assert.equal((await call('workspace?path=' + encodeURIComponent(os.tmpdir()))).status, 404);
});

test('a failed clone is reported and can be retried, never silently', async t => {
  const { call, workspaces } = await setup(t);
  await call('projects', 'POST', { name: 'Perdu', repository: GH('introuvable') });
  await settle();
  const failed = (await call('state')).body.projects[0].localFolder;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Repository not found/);
  await call('projects/PE', 'PATCH', { description: 'autre chose' }); await settle();
  assert.equal(workspaces.clones.length, 1, 'editing the project does not re-clone on its own');
  assert.equal((await call('projects/PE/clone', 'POST', {})).status, 200); await settle();
  assert.equal(workspaces.clones.length, 2);
});

test('tasks take attachments: checked, downloadable, listed in the brief, removed with the task', async t => {
  const { call, ui, projects, dir } = await setup(t);
  await call('projects', 'POST', { name: 'Docs', repository: GH('docs') });
  const task = (await call('tasks', 'POST', { project: 'DO', title: 'Corriger la page', instructions: 'Voir la capture' })).body;
  const up = await call('tasks/DO-1/attachments', 'POST', { name: '../../capture écran.png', data: PNG.toString('base64') });
  assert.equal(up.status, 201);
  const att = up.body.attachments[0];
  assert.equal(att.name, 'capture écran.png'); assert.equal(att.type, 'image/png'); assert.equal(att.by, 'OpenClaw');
  assert.ok(att.localPath.startsWith(path.join(dir, 'attachments')), 'stored under data/attachments, never at the given path');
  assert.equal((await call('tasks/DO-1/attachments', 'POST', { name: 'virus.png', data: Buffer.from('MZ fake').toString('base64') })).status, 415);
  assert.equal((await call('tasks/DO-1/attachments', 'POST', { name: 'outil.exe', data: PNG.toString('base64') })).status, 415);
  assert.equal((await call('tasks/DO-1/attachments', 'POST', { name: 'page.html', data: Buffer.from('<script>').toString('base64') })).status, 415);

  const file = await call(att.download);
  assert.equal(file.status, 200); assert.deepEqual(file.body, PNG);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff'); assert.match(file.headers.get('content-security-policy'), /sandbox/);

  // Depuis l'interface : envoi brut, puis suppression.
  const pdf = await ui('tasks/' + task.id + '/attachments?name=' + encodeURIComponent('cahier.pdf'), 'POST', null, Buffer.from('%PDF-1.4 test'));
  assert.equal(pdf.status, 200); assert.equal(pdf.body.task.attachments.length, 2);
  const brief = projects.brief(projects.snapshot().tasks[0], projects.snapshot().projects[0], { kind: 'initial' });
  assert.match(brief, /## Pièces jointes[\s\S]*capture écran\.png[\s\S]*GET tasks\/DO-1\/attachments\//);
  assert.equal((await ui('tasks/' + task.id + '/attachments/' + pdf.body.attachment.id, 'DELETE')).body.attachments.length, 1);
  assert.equal((await call('tasks/DO-1/attachments/' + pdf.body.attachment.id)).status, 404);
  assert.equal((await call('tasks/DO-1/attachments/' + att.id, 'DELETE')).status, 403, 'an agent cannot delete');
  await ui('tasks/' + task.id, 'DELETE');
  assert.equal(fs.existsSync(path.dirname(att.localPath)), false);
});

test('UI projects stay free, inherit the project agent and clone a GitHub address', async t => {
  const { ui, workspaces } = await setup(t);
  const perso = (await ui('projects', 'POST', { name: 'Vacances' })).body;
  assert.equal(perso.workspace, undefined, 'no repository, nothing cloned');
  const code = (await ui('projects', 'POST', { name: 'Appli', agent: { connectionId: 'c1', agentId: 'main', name: 'Home' }, context: { repository: GH('appli') } })).body;
  assert.equal(code.workspace.status, 'cloning');
  const quick = (await ui('tasks', 'POST', { projectId: code.id, title: 'Rapide' })).body;
  assert.equal(quick.agent.agentId, 'main');
  await settle(); assert.deepEqual(workspaces.clones, [GH('appli')]);
});

test('the real cloner never overwrites an existing folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-clone-'));
  const calls = [];
  const git = async args => { calls.push(args); if (args[2] === 'remote') return args[1].endsWith('mien') ? 'https://github.com/ggzdev/mien.git\n' : 'https://github.com/autre/x.git\n'; return ''; };
  const ws = createWorkspaces({ root, git });
  fs.mkdirSync(path.join(root, 'mien')); fs.mkdirSync(path.join(root, 'occupe'));
  assert.deepEqual(await ws.clone(GH('mien')), { path: path.join(root, 'mien'), reused: true });
  await assert.rejects(ws.clone(GH('occupe')), /existe déjà/);
  // Le même dépôt déjà présent sous un autre nom de dossier est réutilisé.
  fs.mkdirSync(path.join(root, 'MetaDashBoard', '.git'), { recursive: true });
  const named = async args => args[1]?.endsWith('MetaDashBoard') ? 'https://github.com/GGZDEV/Cockpit.git\n' : git(args);
  assert.deepEqual(await createWorkspaces({ root, git: named }).clone('https://github.com/GGZDEV/Cockpit'), { path: path.join(root, 'MetaDashBoard'), reused: true });
  await ws.clone(GH('neuf'));
  assert.deepEqual(calls.at(-1), ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--', GH('neuf') + '.git', path.join(root, 'neuf')]);
  fs.rmSync(root, { recursive: true, force: true });
});

// Passerelle simulée qui crée (ou non) l'agent demandé quand son agent principal reçoit le message.
async function agentGateway(t, { create }) {
  const catalog = [{ id: 'main', name: 'Home' }], messages = [];
  const server = http.createServer(async (req, res) => {
    const send = (s, v) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/api/agents/') return send(200, { connections: [{ id: 'c1', name: 'OpenClaw', kind: 'openclaw', gateway: { state: 'connected' }, catalog: { agents: [...catalog] } }] });
    if (req.url === '/api/agents/connections/c1/agents') return send(200, { defaultId: 'main', agents: catalog });
    if (req.url === '/api/agents/conversations' && req.method === 'POST') return send(200, { id: 'conv1', agent: JSON.parse(body).agentId });
    if (req.url === '/api/agents/conversations/conv1/messages') {
      const text = JSON.parse(body).text; messages.push(text);
      const id = /identifiant exact « ([^»]+) »/.exec(text)[1];
      if (create) catalog.push({ id, name: 'Agent ' + id });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: start\ndata: {}\n\n');
      res.end('event: replace\ndata: ' + JSON.stringify({ text: create ? 'Agent créé.\nSTATUT: TERMINÉ' : 'Commande openclaw introuvable.\nSTATUT: ÉCHEC' }) + '\n\nevent: done\ndata: {}\n\n');
      return;
    }
    send(404, { error: 'introuvable' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-req-'));
  const projects = createProjects({ dataDir: dir, discover: async () => 'http://127.0.0.1:' + server.address().port, reconcileEvery: 3600000, workspaces: fakeWorkspaces(dir) });
  t.after(() => { projects.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const json = (r, s, v) => { r.status = s; r.body = v; r.done(); };
  const ui = async (route, method = 'GET', body) => {
    const res = {}; const finished = new Promise(r => { res.done = r; });
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    projects.handle({ method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield data; } }, res, new URL('http://localhost/api/projects/' + route), json);
    await finished; return res;
  };
  return { ui, projects, messages };
}

test('the user can ask OpenClaw to create the project agent; Cockpit links it once it exists', async t => {
  const { ui, projects, messages } = await agentGateway(t, { create: true });
  const project = (await ui('projects', 'POST', { name: 'Site Vitrine', description: 'Vitrine', context: { objective: 'Vendre', repository: GH('vitrine') } })).body;
  const asked = await ui('projects/' + project.id + '/agent-request', 'POST', {});
  assert.equal(asked.status, 202); assert.equal(asked.body.agentRequest.status, 'pending'); assert.equal(asked.body.agentRequest.agentId, 'site-vitrine');
  assert.equal((await ui('projects/' + project.id + '/agent-request', 'POST', {})).status, 409, 'no duplicate request while pending');
  await settle(); await settle();
  const saved = projects.snapshot().projects[0];
  assert.deepEqual(saved.agent, { connectionId: 'c1', agentId: 'site-vitrine', name: 'Agent site-vitrine' });
  assert.equal(saved.agentRequest.status, 'done');
  assert.match(messages[0], /Objectif : Vendre/); assert.match(messages[0], /Dépôt : https:\/\/github\.com\/ggzdev\/vitrine/); assert.match(messages[0], /ne crée pas de projet dans Cockpit/);
  assert.match(messages[0], /anthropic\/claude-opus-5-5/); assert.match(messages[0], /openai\/gpt-5\.6-sol/); assert.match(messages[0], /chaîne de secours/);
  assert.equal((await ui('tasks', 'POST', { projectId: project.id, title: 'Accueil' })).body.agent.agentId, 'site-vitrine');
  assert.equal((await ui('projects/' + project.id + '/agent-request', 'POST', {})).status, 409, 'already has an agent');
});

test('a refused agent creation is shown with the reason given by OpenClaw', async t => {
  const { ui, projects } = await agentGateway(t, { create: false });
  const project = (await ui('projects', 'POST', { name: 'Perso' })).body;
  await ui('projects/' + project.id + '/agent-request', 'POST', {});
  await settle(); await settle();
  const request = projects.snapshot().projects[0].agentRequest;
  assert.equal(request.status, 'failed'); assert.match(request.error, /Commande openclaw introuvable/);
  assert.equal(projects.snapshot().projects[0].agent ?? null, null);
});
