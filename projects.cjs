'use strict';
// Projets personnels et exécutions d'agents.
// Moteur d'un projet : Claude Code (par défaut), Codex, ou OpenClaw (moteur historique). Claude Code et Codex partent directement
// du PC dans une seule session par tâche, sans OpenClaw (voir « Moteurs directs » plus bas, docs/DIRECT-ENGINES.md).
// Les exécutions OpenClaw passent par la connexion OpenClaw de Cockpit (aucune seconde connexion).
// Le serveur Cockpit suit lui-même chaque exécution : un rafraîchissement de la page
// ne la coupe pas, et après un redémarrage l'état est relu dans l'historique de la passerelle
// sans jamais renvoyer la demande.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWorkspaces, githubRepo, sameRepo } = require('./workspace.cjs');
const { createAttachments, AttachmentError } = require('./attachments.cjs');
const { RULES, agentSettings, configCommand, workspaceFiles } = require('./project-agent.cjs');
const claude = require('./claude-direct.cjs');
const codex = require('./codex-direct.cjs');
const harness = require('./direct-harness.cjs');
const taskEnvironment = require('./task-env.cjs');
const claudemd = require('./project-claudemd.cjs');
const deploy = require('./project-deploy.cjs');
const bootstrap = require('./project-bootstrap.cjs');
const { createDeployerClient, DeployerError, HTTP: DEPLOY_HTTP } = require('./deployer-client.cjs');
const { createGithub, OWNER, NAME } = require('./github-repos.cjs');

const PROJECT_STATUS = ['prep', 'active', 'paused', 'done'];
const TASK_STATUS = ['todo', 'doing', 'blocked', 'review', 'done'];
const ENGINES = ['claude', 'codex', 'openclaw'];
const OPEN_RUN = ['pending', 'started'];
const MARKER = /^\s*\**\s*STATUT\s*:\s*(TERMIN[ÉE]E?|BLOQU[ÉE]E?|[ÉE]CHEC)\s*\**\s*$/im;
// La connexion OpenClaw actuelle n'expose aucune méthode d'arrêt (chat.abort n'est pas autorisé par Cockpit).
const CAPABILITIES = { interrupt: false, interruptReason: 'La connexion OpenClaw de Cockpit ne permet pas encore d’arrêter un agent. Fermer le suivi n’arrête pas son travail.' };

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const text = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function cleanLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map(link => {
    const url = text(typeof link === 'string' ? link : link?.url, 2000);
    try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) return null; } catch { return null; }
    return { url, label: text(link?.label, 160) };
  }).filter(Boolean);
}
function projectKey(name) {
  const words = String(name).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.slice(0, 3).map(w => w[0]).join('') : (words[0] || 'PR').slice(0, 2);
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PR';
}
function urlsIn(value) {
  const found = String(value || '').match(/https?:\/\/[^\s<>()"'`\]]+/g) || [];
  return cleanLinks([...new Set(found.map(u => u.replace(/[.,;:!?]+$/, '')))].map(url => ({ url })));
}

function cleanAgent(a) {
  return a && typeof a === 'object' && /^[\w-]{1,100}$/.test(a.connectionId || '') && /^[a-zA-Z0-9_-]{1,100}$/.test(a.agentId || '')
    ? { connectionId: a.connectionId, agentId: a.agentId, name: text(a.name, 160) || a.agentId } : null;
}

function createProjects({ dataDir = path.join(__dirname, 'data'), discover, fetchImpl = fetch, reconcileEvery = 15000, log = () => {}, workspaces = createWorkspaces(),
  directEnabled = process.env.COCKPIT_DIRECT !== '0', openclawEnabled = process.env.COCKPIT_SERVER_MODE !== '1', claudeEngine, codexEngine, deployer = createDeployerClient({ fetchImpl }), github = createGithub(), taskEnv = taskEnvironment.createTaskEnv() } = {}) {
  // Moteurs directs actifs par défaut ; COCKPIT_DIRECT=0 les coupe tous (retour à OpenClaw seul). Le même worktree sert aux deux moteurs.
  const claudeRun = claudeEngine || claude.createEngine({ enabled: directEnabled, workspacesRoot: workspaces.root });
  const engines = { claude: claudeRun, codex: codexEngine || codex.createEngine({ enabled: directEnabled && process.env.COCKPIT_CODEX_DIRECT !== '0', workspacesRoot: workspaces.root, worktreeRoot: claudeRun.worktreeRoot }) };
  let closing = false;
  const file = path.join(dataDir, 'projects.json');
  const files = createAttachments({ dir: path.join(dataDir, 'attachments') });
  let store = { version: 1, projects: [], tasks: [] };
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(saved.projects) && Array.isArray(saved.tasks)) store = saved; }
  catch (error) { if (error.code !== 'ENOENT') log('Projets : fichier illisible, une copie est conservée.'), fs.copyFileSync(file, file + '.' + Date.now() + '.bak'); }
  const streams = new Map(); // run id -> AbortController (suivi direct en cours)
  const launching = new Set(); // task id : verrou synchrone contre les doubles lancements
  const misses = new Map();
  let saveTimer;

  function save() {
    clearTimeout(saveTimer); saveTimer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store));
    fs.renameSync(temp, file);
  }
  const saveSoon = () => { saveTimer ||= setTimeout(save, 1500); };
  const findProject = pid => store.projects.find(p => p.id === pid) || (() => { throw new HttpError(404, 'Projet introuvable.'); })();
  const findTask = tid => store.tasks.find(t => t.id === tid) || (() => { throw new HttpError(404, 'Tâche introuvable.'); })();
  const openRun = task => task.runs.find(r => OPEN_RUN.includes(r.status));
  const event = (run, type, message) => { run.events.push({ at: now(), type, text: message }); if (run.events.length > 200) run.events.splice(1, run.events.length - 200); };

  async function feedme(route, options = {}) {
    const origin = await discover();
    if (!origin) throw new HttpError(503, 'Cockpit n’est pas lancé sur ce PC : la connexion OpenClaw est indisponible.');
    const response = await fetchImpl(origin + '/api/' + route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, redirect: 'error', signal: options.signal || AbortSignal.timeout(45000) });
    if (options.raw) return response;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(response.status === 409 ? 409 : 502, body.error || 'Cockpit a refusé la demande.');
    return body;
  }

  async function agents({ fresh = false } = {}) {
    if (!openclawEnabled) return [];
    const overview = await feedme('agents/');
    const list = [];
    for (const connection of (overview.connections || []).filter(c => c.kind === 'openclaw')) {
      const connected = connection.gateway?.state === 'connected';
      let catalog = connection.catalog;
      // fresh : relit la passerelle (agent tout juste créé) ; en cas d'échec, l'ancien catalogue reste valable.
      if ((fresh || !catalog) && connected) catalog = await feedme('agents/connections/' + encodeURIComponent(connection.id) + '/agents').catch(() => null) || catalog;
      for (const agent of catalog?.agents || []) list.push({ connectionId: connection.id, connectionName: connection.name, agentId: agent.id, name: agent.name, emoji: agent.emoji || '', available: connected });
      if (!catalog) list.push({ connectionId: connection.id, connectionName: connection.name, agentId: '', name: connection.name, available: false, reason: connected ? 'Catalogue indisponible' : 'Passerelle ' + (connection.gateway?.state || 'déconnectée') });
    }
    return list;
  }

  // ----- Projets et tâches ---------------------------------------------------------------
  function projectInput(body, project = {}) {
    const out = { ...project };
    if ('name' in body) { out.name = text(body.name, 120); if (!out.name) throw new HttpError(400, 'Donnez un nom au projet.'); }
    if ('description' in body) out.description = text(body.description, 600);
    if ('status' in body) { if (!PROJECT_STATUS.includes(body.status)) throw new HttpError(400, 'Statut de projet invalide.'); out.status = body.status; }
    if ('priority' in body) out.priority = [0, 1, 2, 3, 4].includes(Number(body.priority)) ? Number(body.priority) : 0;
    if ('due' in body) out.due = isDate(body.due) ? body.due : '';
    if ('color' in body) out.color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : out.color || '#3dd68c';
    if ('archived' in body) out.archived = !!body.archived;
    if ('agent' in body) out.agent = cleanAgent(body.agent);
    if ('engine' in body) { if (ENGINES.includes(body.engine)) out.engine = body.engine; else delete out.engine; }
    if (body.direct && typeof body.direct === 'object') out.direct = harness.directSettings(body.direct, out.direct);
    // Déploiement : réglages validés (project.deployment) ; l'état du service vit à part (project.deployState).
    if (body.deployment && typeof body.deployment === 'object' && !Array.isArray(body.deployment)) {
      try { out.deployment = deploy.cleanSettings(body.deployment, out.deployment); } catch (error) { throw error instanceof deploy.InputError ? new HttpError(400, error.message) : error; }
    }
    if ('key' in body && text(body.key, 6)) out.key = text(body.key, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || out.key;
    if (body.context && typeof body.context === 'object') {
      const c = { ...(out.context || {}) };
      for (const [k, max] of [['objective', 4000], ['instructions', 12000], ['resources', 12000], ['repository', 600], ['environment', 2000], ['publishing', 4000]]) if (k in body.context) c[k] = text(body.context[k], max);
      if ('autoPublish' in body.context) c.autoPublish = body.context.autoPublish === true;
      if ('links' in body.context) c.links = cleanLinks(body.context.links);
      if (c.repository && githubRepo(c.repository)) c.repository = githubRepo(c.repository).web;
      out.context = c;
    }
    return out;
  }
  function taskInput(body, task = {}) {
    const out = { ...task };
    if ('title' in body) { out.title = text(body.title, 200); if (!out.title) throw new HttpError(400, 'Donnez un titre à la tâche.'); }
    for (const [k, max] of [['instructions', 20000], ['expected', 4000], ['criteria', 4000], ['resources', 12000]]) if (k in body) out[k] = text(body[k], max);
    if ('links' in body) out.links = cleanLinks(body.links);
    if ('priority' in body) out.priority = [0, 1, 2, 3, 4].includes(Number(body.priority)) ? Number(body.priority) : 0;
    if ('due' in body) out.due = isDate(body.due) ? body.due : '';
    if ('includeContext' in body) out.includeContext = body.includeContext !== false;
    if ('agent' in body) out.agent = cleanAgent(body.agent);
    if ('engine' in body) { if (ENGINES.includes(body.engine)) out.engine = body.engine; else delete out.engine; }
    if ('model' in body) out.model = /^(?!-)[\w.:\[\]-]{1,80}$/.test(body.model || '') ? body.model : '';
    if ('planFirst' in body) out.planFirst = body.planFirst === true;
    // « Déployé » n'est posé que par Cockpit, après un déploiement réussi qui contient le travail de la tâche.
    if ('status' in body && body.status !== task.status) { if (body.status === 'deployed') throw new HttpError(400, 'La colonne « Déployé » se remplit seule après un déploiement réussi.'); if (!TASK_STATUS.includes(body.status)) throw new HttpError(400, 'Colonne inconnue.'); out.status = body.status; }
    if ('order' in body && Number.isFinite(Number(body.order))) out.order = Number(body.order);
    return out;
  }
  function createProject(body) {
    // Un nouveau projet travaille avec Claude Code par défaut (si les moteurs directs sont actifs) ; OpenClaw reste un choix explicite.
    const project = projectInput({ status: 'prep', priority: 0, due: '', description: '', color: '#3dd68c', ...(directEnabled ? { engine: 'claude' } : {}), ...body, context: body.context || {} }, { id: id(), createdAt: now(), seq: 0, archived: false });
    project.key ||= projectKey(project.name);
    const plan = newRepositoryPlan(body, project);
    if (plan) project.bootstrap = { status: 'pending', step: '', error: '', at: now(), request: plan };
    store.projects.push(project); syncWorkspace(project); save();
    if (plan) runBootstrap(project); else queueRegistration(project).catch(error => log('Déploiement : ' + error.message));
    return project;
  }
  function updateProject(pid, body) {
    const index = store.projects.findIndex(p => p.id === pid); if (index < 0) throw new HttpError(404, 'Projet introuvable.');
    // Mise à jour sur place : les suivis en arrière-plan (création, déploiement) gardent le même objet projet.
    const project = store.projects[index], next = { ...projectInput(body, project), updatedAt: now() };
    for (const key of Object.keys(project)) if (!(key in next)) delete project[key];
    Object.assign(project, next); syncWorkspace(project); save();
    queueRegistration(project).catch(error => log('Déploiement : ' + error.message));
    return store.projects[index];
  }

  // ----- Dossier local (clone GitHub sur ce PC) ------------------------------------------
  // Le clone démarre dès qu'un projet reçoit une adresse GitHub ; un dossier existant n'est jamais écrasé.
  function syncWorkspace(project, { retry = false } = {}) {
    const repo = githubRepo(project.context?.repository), w = project.workspace;
    if (!repo || (project.bootstrap && project.bootstrap.status !== 'done')) return; // projet neuf : le clonage fait partie de sa création
    // Même dépôt déjà traité : on ne recommence que sur demande explicite (« Réessayer »).
    if (w && sameRepo(w.repo, repo.web) && (w.status === 'cloning' || !retry)) return;
    const workspace = { repo: repo.web, path: workspaces.target(repo.web), status: 'cloning', at: now() };
    project.workspace = workspace;
    workspaces.clone(repo.web).then(async result => {
      Object.assign(workspace, { status: 'ready', path: result.path, reused: result.reused, error: '', at: now() });
      // Dossier prêt : le CLAUDE.md du projet est préparé tout de suite (sans effet sur un fichier déjà présent).
      if (directEnabled) await prepareClaudeMd(project).catch(error => log('CLAUDE.md : ' + error.message));
    }, error => Object.assign(workspace, { status: 'failed', error: text(error.message, 400), at: now() }))
      .finally(() => { if (project.workspace === workspace) save(); });
  }
  // CLAUDE.md du dossier du projet : généré s'il n'existe pas, jamais écrasé s'il existe ou a été retouché.
  async function prepareClaudeMd(project, { regenerate = false } = {}) {
    const dir = project.workspace?.path;
    if (!dir || project.workspace?.status !== 'ready') throw new HttpError(409, 'La copie locale du dépôt n’est pas prête : le CLAUDE.md sera préparé après le clonage.');
    try { project.claudeMd = await claudemd.prepare(project, dir, project.claudeMd, { regenerate }); }
    catch (error) { throw error.status ? new HttpError(error.status, error.message) : error; }
    return project.claudeMd;
  }
  // Moteur d'une tâche : celui de la tâche, sinon celui du projet. Un projet ou une tâche d'avant les moteurs directs (aucun moteur
  // enregistré, conversation déjà engagée) reste sur OpenClaw : rien ne bascule sans choix explicite.
  function engineOf(task, project) {
    if (!directEnabled) return 'openclaw';
    if (task.engine) return task.engine;
    if (task.runs?.length) return 'openclaw';
    return project?.engine || 'openclaw';
  }
  function retryWorkspace(project) {
    if (!githubRepo(project.context?.repository)) throw new HttpError(400, 'Ce projet n’a pas d’adresse GitHub à cloner.');
    if (project.workspace?.status === 'cloning') throw new HttpError(409, 'Le clonage est déjà en cours.');
    syncWorkspace(project, { retry: true }); save(); return project;
  }
  function createTask(body) {
    const project = findProject(body.projectId);
    project.seq = (project.seq || 0) + 1;
    const status = TASK_STATUS.includes(body.status) ? body.status : 'todo';
    const task = taskInput({ instructions: '', expected: '', criteria: '', resources: '', links: [], priority: 0, due: '', agent: project.agent || null, includeContext: true, ...body, status },
      { id: id(), projectId: project.id, code: project.key + '-' + project.seq, createdAt: now(), runs: [], order: Date.now() });
    store.tasks.push(task); save(); return task;
  }
  // Un changement de colonne reste un geste manuel : il ne lance, n'arrête et ne modifie aucune exécution.
  function updateTask(tid, body) {
    const task = findTask(tid);
    const next = taskInput(body, task);
    if (body.status && body.status !== task.status) next.movedAt = now();
    Object.assign(task, next, { updatedAt: now() }); save(); return task;
  }
  function deleteTask(tid) {
    const task = findTask(tid);
    if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours : la tâche ne peut pas être supprimée.');
    store.tasks = store.tasks.filter(t => t !== task); save(); files.removeAll(task);
  }
  function addAttachment(tid, name, data, by) {
    const task = findTask(tid);
    try { const meta = files.add(task, { name, data, by }); task.updatedAt = now(); save(); return meta; }
    catch (error) { if (error instanceof AttachmentError) throw new HttpError(error.status, error.message); throw error; }
  }
  function removeAttachment(tid, aid) {
    const task = findTask(tid);
    try { files.remove(task, aid); } catch (error) { if (error instanceof AttachmentError) throw new HttpError(error.status, error.message); throw error; }
    task.updatedAt = now(); save(); return task;
  }
  const attachmentLines = task => (task.attachments || []).map(a => `- ${a.name} (${a.type.split(';')[0]}, ${Math.max(1, Math.round(a.size / 1024))} Ko) — sur le PC : ${files.localPath(task.id, a)} — via l’accès agents Cockpit : GET tasks/${task.code}/attachments/${a.id}`);
  // « Clore la tâche » : accepte le dernier résultat s'il attend une validation, puis passe la tâche en Terminé.
  // Une tâche sans résultat (manuelle, question restée ouverte…) peut aussi être close.
  // Si la tâche a des commits dans sa branche, ils sont d'abord fusionnés dans la branche de production de la copie locale puis poussés sur GitHub
  // (un programme, sans agent). Le déploiement suit ensuite les réglages du projet : automatique, ou bouton « Déployer ».
  // { publish: false } : « Clore » sans fusion ni envoi (rien à livrer, ex. une simple question) ; la branche reste telle quelle.
  async function accept(tid, body = {}) {
    const task = findTask(tid);
    if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours : attendez son résultat.');
    const published = body.publish === false ? null : await publishTask(task);
    const run = task.runs.at(-1);
    if (run?.status === 'succeeded' && run.outcome === 'result' && !run.accepted) run.accepted = now();
    Object.assign(task, { status: task.status === 'deployed' && !published ? 'deployed' : 'done', acceptedAt: now(), question: '', updatedAt: now() });
    if (published) { task.published = published; if (published.recipeError) task.deployError = published.recipeError; else delete task.deployError; delete task.deployCheck; }
    save(); return task;
  }
  // File d'attente par copie locale : plusieurs tâches closes coup sur coup sont publiées l'une après l'autre,
  // chacune fusionnée par-dessus la précédente (jamais deux fusions ou deux push en même temps dans le même dépôt).
  const publishQueue = new Map();
  function publishTask(task) {
    const project = store.projects.find(p => p.id === task.projectId);
    const key = project?.workspace?.path || '';
    const next = (publishQueue.get(key) || Promise.resolve()).catch(() => {}).then(() => publishNow(task));
    const tail = next.catch(() => {});
    publishQueue.set(key, tail);
    tail.then(() => { if (publishQueue.get(key) === tail) publishQueue.delete(key); });
    return next;
  }
  async function publishNow(task) {
    const project = store.projects.find(p => p.id === task.projectId), branch = task.direct?.branch, cwd = task.direct?.cwd;
    const dir = project?.workspace?.status === 'ready' ? project.workspace.path : '', prod = deploy.settingsOf(project).branch;
    if (!branch || !dir || !workspaces.git) return null;
    const git = (...args) => workspaces.git(['-C', dir, ...args]).then(out => String(out).trim());
    const fail = message => { throw new HttpError(409, message + ' La tâche reste ouverte.'); };
    if (!(await git('rev-parse', '--verify', '--quiet', 'refs/heads/' + branch).then(() => true, () => false))) return null;
    const pending = Number(await git('rev-list', '--count', prod + '..' + branch)) > 0;
    // Rien à fusionner : déjà publié, sauf si une fusion précédente n'a pas pu être poussée sur GitHub.
    if (!pending && await git('merge-base', '--is-ancestor', branch, 'refs/remotes/origin/' + prod).then(() => true, () => false)) return null;
    // Ce qui n'est pas committé dans le worktree ne part pas (souvent un fichier réécrit par les tests) : signalé, sans bloquer.
    const leftOut = cwd ? (await workspaces.git(['-C', cwd, 'status', '--porcelain', '--untracked-files=no']).then(String, () => '')).split('\n').map(l => l.slice(3).trim()).filter(Boolean).slice(0, 20) : [];
    if (await git('rev-parse', '--abbrev-ref', 'HEAD') !== prod) fail(`La copie locale ${dir} n’est pas sur la branche ${prod}.`);
    if (await git('status', '--porcelain', '--untracked-files=no')) fail(`La copie locale ${dir} contient des modifications non committées : rien n’a été publié.`);
    // Identité Git des commits de fusion : celle de la copie locale, sinon « Cockpit ».
    const who = (await git('config', 'user.email').catch(() => '')) ? [] : ['-c', 'user.name=Cockpit', '-c', 'user.email=cockpit@localhost'];
    // Récupère GitHub dans la branche de production locale. Si elle porte déjà des fusions pas encore poussées
    // (push précédent refusé) et que GitHub a avancé entre-temps, les deux historiques sont fusionnés : rien n'est écrasé.
    const syncOrigin = async () => {
      try { await git('fetch', '-q', 'origin', prod); }
      catch (error) { fail(`La récupération de ${prod} depuis GitHub a échoué (${text(String(error.message || ''), 200)}) : rien n’a été publié.`); }
      if (await git('merge', '-q', '--ff-only', 'origin/' + prod).then(() => true, () => false)) return;
      try { await workspaces.git(['-C', dir, ...who, 'merge', '-q', '--no-ff', '-m', `Fusion de origin/${prod}`, 'origin/' + prod]); }
      catch {
        await git('merge', '--abort').catch(() => {});
        fail(`La branche ${prod} de la copie locale et celle de GitHub ont divergé et entrent en conflit : rien n’a été publié.`);
      }
    };
    await syncOrigin();
    if (pending) try { await workspaces.git(['-C', dir, ...who, 'merge', '-q', '--no-ff', '-m', `${task.code} · ${task.title}`.slice(0, 200), branch]); }
    catch (error) {
      const conflict = await git('diff', '--name-only', '--diff-filter=U').catch(() => '');
      await git('merge', '--abort').catch(() => {});
      fail(conflict ? `La branche de la tâche entre en conflit avec ${prod} : rien n’a été publié. Demandez à l’agent de récupérer ${prod} dans sa branche.` : `La fusion dans ${prod} a échoué (${text(String(error.message || ''), 200)}) : rien n’a été publié.`);
    }
    // GitHub a avancé entre la récupération et l'envoi (autre poste, push manuel) : on récupère et on renvoie, sans forcer.
    const push = () => git('push', '-q', 'origin', prod);
    try { await push().catch(async error => { if (!/rejected|non-fast-forward|fetch first/i.test(String(error.message || '') + String(error.stderr || ''))) throw error; await syncOrigin(); await push(); }); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, `La tâche est fusionnée dans ${prod} en local, mais l’envoi sur GitHub a échoué (${text(String(error.message || ''), 200)}). La tâche reste ouverte : recommencez une fois l’accès rétabli.`); }
    const commit = await git('rev-parse', 'HEAD');
    let recipeError = '';
    // A task can deliver its first Compose recipe. Adopt only the accepted main
    // copy, after the push: never let a worktree reconfigure a live deployment.
    if (process.env.COCKPIT_APPLICATIONS === '1') {
      const manifest = path.join(dir, 'deploy', 'application.json');
      if (fs.existsSync(manifest) && !deploy.settingsOf(project).type) {
        try {
          if (fs.statSync(manifest).size > 65536) throw new Error('recette trop volumineuse');
          const body = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (!body.compose || !/^http:\/\/(127\.0\.0\.1|192\.168\.1\.236):\d{2,5}\//.test(body.healthUrl || '')) throw new Error('compose et healthUrl local obligatoires');
          const d = deploy.settingsOf(project), key = await claimSlug(project);
          const payload = require('./scripts/applicationctl.cjs').recipe(key, body, { repo: githubRepo(project.context.repository).owner + '/' + githubRepo(project.context.repository).name, branch: d.branch, auto: d.auto, public_url: d.url });
          project.deployment = deploy.cleanSettings({ type: 'custom', config: payload.deploy, health: payload.health }, project.deployment);
          const registered = await queueRegistration(project);
          if (registered?.status !== 'ok') throw new Error(registered?.error || 'enregistrement impossible');
        } catch (error) { recipeError = 'Recette Applications : ' + text(error.message, 300); log(recipeError); }
      }
    }
    log(`Tâche ${task.code} publiée sur GitHub (${prod} · ${commit.slice(0, 7)})`);
    return { at: now(), branch: prod, commit, ...(leftOut.length ? { leftOut } : {}), ...(recipeError ? { recipeError } : {}) };
  }

  // ----- Lancement explicite ----------------------------------------------------------------
  // Empreinte de ce que l'agent a reçu : consignes de la tâche et contexte du projet.
  const basis = (task, project) => crypto.createHash('sha256').update(JSON.stringify([task.title, task.instructions, task.expected, task.criteria, task.resources, task.links, (task.attachments || []).map(a => a.id), task.includeContext, project.name, project.description, project.context])).digest('hex').slice(0, 16);
  // Suite d'une conversation déjà engagée : un message court suffit, l'agent a déjà les consignes.
  // Si la tâche ou le projet ont été modifiés depuis le dernier envoi, les consignes complètes sont renvoyées.
  function followUp(task, project, run) {
    const previous = task.runs.findLast(r => r !== run && r.conversationId === run.conversationId && r.prompt);
    if (!previous || !['reprise', 'answer'].includes(run.kind)) return '';
    if (previous.basis !== basis(task, project)) return '';
    const c = project.context || {}, lines = [`Tâche ${task.code} — « ${task.title} » : suite.`, '', run.note];
    if (c.autoPublish && c.publishing) lines.push('', 'Rappel : la publication de ce projet est autorisée selon la procédure déjà transmise ; publie quand le travail est terminé et vérifié.');
    lines.push('', 'Termine ta réponse par une ligne seule : STATUT: TERMINÉ, STATUT: BLOQUÉ (question au-dessus) ou STATUT: ÉCHEC.');
    return lines.join('\n').slice(0, 31000);
  }
  function brief(task, project, run) {
    const short = followUp(task, project, run); if (short) return short;
    const c = project.context || {}, lines = [];
    lines.push(`Tâche ${task.code} — « ${task.title} »`, `Projet : ${project.name}${project.description ? ' — ' + project.description : ''}`, '');
    if (run.kind === 'answer') lines.push('Réponse à ta question précédente :', run.note, '');
    if (run.kind === 'reprise') lines.push('Reprise demandée sur ton résultat précédent. Instructions de reprise :', run.note, '');
    if (run.kind === 'retry') lines.push('Nouvelle tentative après l’échec ou l’interruption précédente.' + (run.note ? ' Précisions : ' + run.note : ''), '');
    lines.push('## Consignes', task.instructions);
    if (task.expected) lines.push('', '## Résultat attendu', task.expected);
    if (task.criteria) lines.push('', '## Critères de réussite', task.criteria);
    if (task.resources || task.links?.length) lines.push('', '## Ressources de la tâche', task.resources, ...task.links.map(l => '- ' + (l.label ? l.label + ' : ' : '') + l.url));
    if (task.attachments?.length) lines.push('', '## Pièces jointes', ...attachmentLines(task));
    if (task.includeContext !== false) {
      const ctx = [];
      if (c.objective) ctx.push('Objectif : ' + c.objective);
      if (c.instructions) ctx.push('Instructions générales :\n' + c.instructions);
      if (c.repository) ctx.push('Dépôt de code : ' + c.repository);
      if (project.workspace?.status === 'ready') ctx.push('Copie locale sur le PC de l’utilisateur : ' + project.workspace.path);
      if (c.environment) ctx.push('Environnement de travail : ' + c.environment);
      if (c.resources) ctx.push('Ressources et documents :\n' + c.resources);
      if (c.links?.length) ctx.push('Liens :\n' + c.links.map(l => '- ' + (l.label ? l.label + ' : ' : '') + l.url).join('\n'));
      if (ctx.length) lines.push('', '## Contexte du projet', ...ctx);
    }
    const publish = c.autoPublish && c.publishing;
    if (c.publishing) lines.push('', publish ? '## Publication (autorisée par l’utilisateur pour ce projet)' : '## Publication (procédure du projet)', c.publishing);
    lines.push('', '## Cadre',
      ...(publish ? ['Quand le travail est terminé et vérifié, publie-le toi-même en suivant exactement la procédure « Publication » ci-dessus, sans me demander d’accord, puis indique ce qui a été publié et où. Si une étape échoue, arrête-toi et explique.'] : c.publishing ? ['La procédure « Publication » ci-dessus n’est pas autorisée automatiquement : prépare tout, puis demande mon accord avant de publier.'] : []),
      'Respecte les autorisations déjà en place. Pour une publication, un envoi externe, une suppression destructive, un déploiement ou une dépense qui ne sont pas explicitement prévus par ces consignes, ne les exécute pas : décris l’action concrète et demande mon accord.',
      'Indique les fichiers, liens et livrables produits avec leur chemin ou leur adresse complète.',
      'Termine ta réponse par une ligne seule :',
      'STATUT: TERMINÉ — le travail est fait (résumé du résultat au-dessus) ;',
      'STATUT: BLOQUÉ — il te manque une information ou un accord (ta question au-dessus) ;',
      'STATUT: ÉCHEC — la tâche ne peut pas être réalisée (explication au-dessus).');
    return lines.filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 31000);
  }

  async function launch(tid, body = {}) {
    const task = findTask(tid);
    const launchKey = text(body.launchKey, 100);
    if (!launchKey) throw new HttpError(400, 'Identifiant de lancement manquant.');
    const repeated = task.runs.find(r => r.launchKey === launchKey);
    if (repeated) return { task, run: repeated, repeated: true };
    if (launching.has(task.id) || openRun(task)) throw new HttpError(409, 'Une exécution est déjà en cours pour cette tâche.');
    const kind = ['initial', 'reprise', 'answer', 'retry', 'execute'].includes(body.kind) ? body.kind : task.runs.length ? 'retry' : 'initial';
    const note = text(body.note, 8000);
    if ((kind === 'reprise' || kind === 'answer') && !note) throw new HttpError(400, kind === 'answer' ? 'Écrivez votre réponse avant de relancer.' : 'Ajoutez les instructions de reprise.');
    const project = findProject(task.projectId), engine = engineOf(task, project);
    if (engine !== 'openclaw') return launchDirect(task, project, engine, { launchKey, kind, note });
    if (!openclawEnabled) throw new HttpError(403, 'OpenClaw n’est pas activé dans le mode serveur web. Choisissez Claude Code ou Codex.');
    if (kind === 'execute') throw new HttpError(400, 'Seul un plan rédigé par Claude Code ou Codex peut être exécuté.');
    const missing = [!task.title && 'un titre', !task.instructions && 'des consignes', !task.agent && 'un agent assigné'].filter(Boolean);
    if (missing.length) throw new HttpError(400, 'Avant de lancer, ajoutez ' + missing.join(', ') + '.');
    launching.add(task.id);
    try {
      const list = await agents();
      const agent = list.find(a => a.connectionId === task.agent.connectionId && a.agentId === task.agent.agentId);
      if (!agent) throw new HttpError(409, `L’agent « ${task.agent.name} » n’existe plus sur la passerelle OpenClaw. Choisissez un autre agent.`);
      if (!agent.available) throw new HttpError(409, `L’agent « ${agent.name} » est indisponible : la passerelle OpenClaw n’est pas connectée. Rien n’a été lancé.`);
      const conversation = task.conversation?.connectionId === agent.connectionId && task.conversation?.agentId === agent.agentId ? task.conversation : null;
      let conversationId = conversation?.id;
      if (!conversationId) {
        const created = await feedme('agents/conversations', { method: 'POST', body: JSON.stringify({ connectionId: agent.connectionId, agentId: agent.agentId }) });
        conversationId = created.id;
        task.conversation = { id: conversationId, connectionId: agent.connectionId, agentId: agent.agentId };
      }
      const run = { id: id(), launchKey, kind, note, agent: { ...task.agent, name: agent.name }, conversationId, status: 'pending', createdAt: now(), events: [] };
      run.prompt = brief(task, project, run);
      event(run, 'requested', 'Lancement demandé · transmission à ' + agent.name);
      task.runs.push(run);
      if (task.runs.length > 30) task.runs.splice(0, task.runs.length - 30);
      run.basis = basis(task, project);
      task.question = '';
      // Continuer une tâche terminée la remet en jeu : son prochain résultat sera de nouveau à valider.
      if (['done', 'deployed'].includes(task.status)) { task.status = 'todo'; delete task.acceptedAt; task.movedAt = now(); }
      save();
      follow(task, run);
      return { task, run };
    } finally { launching.delete(task.id); }
  }

  function finalize(task, run, content) {
    const reply = String(content || '');
    const match = run.engine === 'claude' ? null : [...reply.matchAll(new RegExp(MARKER.source, 'gim'))].at(-1);
    const verdict = match ? match[1].toUpperCase().normalize('NFD').replace(/[^A-Z]/g, '') : '';
    const body = (match ? reply.slice(0, match.index) + reply.slice(match.index + match[0].length) : reply).trim();
    run.endedAt = now(); run.startedAt ||= run.endedAt; delete run.liveText; delete run.tracking;
    if (verdict.startsWith('ECHEC')) {
      run.status = 'failed'; run.error = body || 'L’agent indique un échec sans explication.';
      event(run, 'failed', 'L’agent signale un échec');
      task.status = 'blocked';
    } else if (verdict.startsWith('BLOQU')) {
      run.status = 'succeeded'; run.outcome = 'question'; run.result = body;
      event(run, 'question', 'L’agent attend une réponse');
      task.status = 'blocked'; task.question = body;
    } else {
      run.status = 'succeeded'; run.outcome = 'result'; run.result = body; run.links = urlsIn(body);
      event(run, 'result', match ? 'Résultat reçu · à valider' : 'Résultat reçu (sans statut explicite de l’agent) · à valider');
      task.status = 'review';
    }
    task.updatedAt = now(); save();
  }
  function fail(task, run, status, message) {
    run.status = status; run.error = message; run.endedAt = now(); delete run.liveText; delete run.tracking;
    event(run, status, status === 'interrupted' ? 'Exécution interrompue' : 'Échec'); task.status = 'blocked'; task.updatedAt = now(); save();
  }
  function markStarted(task, run, message) {
    if (run.status !== 'pending') return;
    run.status = 'started'; run.startedAt = now(); event(run, 'started', message);
    if (task.status !== 'done') task.status = 'doing';
    save();
  }

  // Suivi direct : le serveur garde le flux, le navigateur ne fait que lire l'état.
  async function follow(task, run) {
    const controller = new AbortController(); streams.set(run.id, controller); run.tracking = 'live';
    let finished = false;
    try {
      const response = await feedme('agents/conversations/' + encodeURIComponent(run.conversationId) + '/messages', { method: 'POST', raw: true, body: JSON.stringify({ text: run.prompt }), signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const body = await response.json().catch(() => ({}));
        if (/introuvable/i.test(body.error || '')) { delete task.conversation; save(); return fail(task, run, 'failed', 'La conversation de cette tâche n’existe plus dans Cockpit. Rien n’a été envoyé ; une nouvelle conversation sera créée à la relance.'); }
        return fail(task, run, 'failed', response.status === 409 ? 'L’agent traite déjà une autre demande dans cette conversation. Réessayez quand elle sera terminée.' : body.error || 'Cockpit a refusé la demande.');
      }
      const decoder = new TextDecoder(); let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!name || data == null) continue;
          let payload = {}; try { payload = JSON.parse(data); } catch { continue; }
          if (name === 'start') { event(run, 'sent', 'Demande transmise à OpenClaw · en attente du démarrage'); save(); }
          else if (name === 'replace' || name === 'delta') { markStarted(task, run, 'Démarrage confirmé : l’agent répond'); run.liveText = name === 'replace' ? payload.text : (run.liveText || '') + payload.text; saveSoon(); }
          else if (name === 'done') { finished = true; finalize(task, run, run.liveText); }
          else if (name === 'error') {
            finished = true;
            // « Réception arrêtée » : seul le suivi est coupé, l'agent distant peut continuer.
            if (/Réception arrêtée|Connexion/i.test(payload.message || '')) { run.tracking = 'recovering'; event(run, 'tracking', 'Suivi direct perdu · relecture de l’historique OpenClaw'); save(); }
            else fail(task, run, 'failed', payload.message || 'L’agent n’a pas pu terminer.');
          }
        }
      }
      if (!finished && OPEN_RUN.includes(run.status)) { run.tracking = 'recovering'; event(run, 'tracking', 'Flux interrompu · relecture de l’historique OpenClaw'); save(); }
    } catch (error) {
      if (!OPEN_RUN.includes(run.status)) return;
      if (error.status && !run.events.some(e => e.type === 'sent')) return fail(task, run, 'failed', error.message);
      run.tracking = 'recovering'; event(run, 'tracking', 'Suivi direct perdu · relecture de l’historique OpenClaw'); save();
    } finally { streams.delete(run.id); }
  }

  // Après un redémarrage ou une coupure : relire la passerelle, ne jamais renvoyer la demande.
  async function reconcile() {
    for (const task of store.tasks) for (const run of task.runs) {
      if (!OPEN_RUN.includes(run.status) || streams.has(run.id) || isDirectRun(run)) continue;
      run.tracking = 'recovering';
      let conversation;
      try { conversation = await feedme('agents/conversations/' + encodeURIComponent(run.conversationId)); }
      catch (error) { run.trackingError = error.message; continue; }
      delete run.trackingError;
      const messages = conversation.messages || [];
      const head = run.prompt.slice(0, 300).trim();
      const at = messages.findLastIndex(m => m.role === 'user' && String(m.content || '').trim().startsWith(head));
      const reply = at >= 0 ? messages.slice(at + 1).findLast(m => m.role === 'assistant' && m.status !== 'streaming' && String(m.content || '').trim()) : null;
      if (conversation.active) {
        misses.delete(run.id);
        if (at >= 0) markStarted(task, run, 'Démarrage confirmé par l’historique OpenClaw');
        const live = messages.slice(at + 1).findLast(m => m.role === 'assistant');
        if (live?.content) run.liveText = live.content;
        continue;
      }
      if (reply) { misses.delete(run.id); event(run, 'tracking', 'Résultat retrouvé dans l’historique OpenClaw'); finalize(task, run, reply.content); continue; }
      const count = (misses.get(run.id) || 0) + 1; misses.set(run.id, count);
      if (count >= 4) {
        misses.delete(run.id);
        fail(task, run, at >= 0 ? 'interrupted' : 'failed', at >= 0
          ? 'L’exécution s’est arrêtée sans résultat dans l’historique OpenClaw. Vous pouvez relancer : l’historique est conservé.'
          : 'La demande n’apparaît pas dans l’historique de l’agent : elle n’a sans doute pas été reçue. Vous pouvez relancer.');
      }
    }
  }
  // ----- Moteurs directs : Claude Code et Codex ---------------------------------------------------
  // Une tâche = une session du moteur, ouverte dans le worktree de la tâche (branche cockpit/<code>) puis reprise à chaque message.
  // Aucune chaîne imposée : la demande part telle quelle, le moteur travaille, Cockpit relève les faits Git (branche, commits, fichiers).
  // Un plan préalable en lecture seule est une option de la tâche (planFirst), désactivée par défaut. Les consignes du projet vivent
  // dans le CLAUDE.md du dossier, pas dans chaque demande. Secours automatique (réglage du projet, désactivé par défaut) :
  // seulement si le moteur a échoué avant tout travail et sans rien modifier.
  const LABEL = harness.ENGINE_LABEL;
  const isDirectRun = run => harness.ENGINES.includes(run.engine);
  const directRuns = task => task.runs.filter(isDirectRun);
  const starting = new Set(); // tâches en cours de lancement : comptent dans la limite d'exécutions simultanées
  const preparing = new Map(); // run id -> AbortController (dépendances et tests de départ avant le moteur)
  // Budget par tâche, partagé entre les moteurs : somme des coûts mesurés (estimation de Claude). Un coût non exposé (Codex) n'est jamais inventé.
  const spent = task => directRuns(task).reduce((sum, r) => sum + (Number(r.metrics?.costUsd) || 0), 0);
  const MIN_RUN_USD = 0.1; // en dessous, une exécution n'a pas de quoi aboutir : on refuse plutôt que de la couper aussitôt
  const runBudget = (task, s) => Math.floor(Math.min(s.maxBudgetUsd, s.taskBudgetUsd - spent(task)) * 100) / 100;
  const asHttp = error => error instanceof harness.DirectError ? new HttpError(error.status, error.message) : error;
  const modelFor = (name, task, s, fallback) => !fallback && task.model ? task.model : name === 'codex' ? s.codexModel : s.model;

  async function launchDirect(task, project, name, { launchKey, kind, note }) {
    const engine = engines[name], label = LABEL[name];
    if (!engine.enabled) throw new HttpError(403, label + ' direct est désactivé sur ce PC (COCKPIT_DIRECT=0).');
    const missing = [!task.title && 'un titre', !task.instructions && 'des consignes'].filter(Boolean);
    if (missing.length) throw new HttpError(400, 'Avant de lancer, ajoutez ' + missing.join(' et ') + '.');
    const s = harness.directSettings(project.direct), d = task.direct || {};
    if (kind === 'execute' && !d.planPending) throw new HttpError(409, 'Aucun plan en attente d’exécution.');
    const mode = kind !== 'execute' && (d.planPending || (task.planFirst && !d.workStarted)) ? 'plan' : 'work';
    if (directRuns(task).length >= s.maxRuns) throw new HttpError(409, `Limite atteinte : ${s.maxRuns} exécutions pour cette tâche (réglage du projet).`);
    const budgetUsd = runBudget(task, s);
    if (name === 'claude' && budgetUsd < MIN_RUN_USD) throw new HttpError(409, `Budget de la tâche presque épuisé : ${spent(task).toFixed(2)} $ sur ${s.taskBudgetUsd} $ (estimation, réglage du projet).`);
    const running = engines.claude.active.size + engines.codex.active.size + starting.size + preparing.size;
    if (running >= engines.claude.maxParallel) throw new HttpError(409, `Déjà ${running} exécutions en cours sur ce PC (limite : ${engines.claude.maxParallel}, réglable par COCKPIT_MAX_PARALLEL) : réessayez quand l’une d’elles sera terminée.`);
    launching.add(task.id); starting.add(task.id);
    try {
      const repo = await engine.repository(project);
      await prepareClaudeMd(project); // actualise uniquement les fichiers encore gérés par Cockpit
      const wt = await engine.worktree(project, task, repo);
      await claudemd.seedWorktree(repo, wt.path, project.claudeMd);
      // Changement de moteur ou dossier différent : la session précédente n'est plus utilisable, une nouvelle s'ouvre avec les consignes complètes.
      const previous = d.sessionId && (d.engine !== name || d.cwd !== wt.path) ? { engine: d.engine, reason: d.engine !== name ? 'changement de moteur' : 'dossier de travail différent' } : null;
      if (previous) delete d.sessionId;
      const fresh = !d.sessionId;
      const handoff = fresh && directRuns(task).length ? previous || { engine: d.engine, reason: 'session précédente introuvable' } : null;
      Object.assign(d, { engine: name, cwd: wt.path, branch: wt.branch, baseSha: d.baseSha || wt.baseSha || '' });
      task.direct = d; task.engine ||= name; // le moteur d'une tâche engagée ne change plus avec le projet
      const { run, attachmentIds } = prepareRun({ task, project, s, name, kind, mode, note, fresh, handoff, launchKey, budgetUsd });
      task.question = '';
      if (['done', 'deployed'].includes(task.status)) { task.status = 'todo'; delete task.acceptedAt; task.movedAt = now(); }
      save();
      followDirect(task, run, s, attachmentIds).catch(error => { log(label + ' : ' + error.message); for (const r of directRuns(task)) if (OPEN_RUN.includes(r.status)) fail(task, r, 'failed', 'Erreur interne de Cockpit : ' + text(error.message, 300)); });
      return { task, run };
    } catch (error) { throw asHttp(error); }
    finally { launching.delete(task.id); starting.delete(task.id); }
  }
  // Demande envoyée au moteur : la tâche seulement (le projet est dans CLAUDE.md). Messages suivants : la nouveauté seulement.
  function directBrief({ task, name, kind, mode, note, fresh, handoff, attachments, rules }) {
    const out = [], c = task.direct, last = directRuns(task).at(-1);
    const files = attachments.length ? ['', fresh ? '## Pièces jointes (à lire avec Read)' : '## Nouvelles pièces jointes', ...attachments.map(a => `- ${a.name} (${a.type}, ${a.kb} Ko) : ${a.path}`)] : [];
    if (fresh) {
      if (rules) out.push('## Consignes du projet', rules, '(Codex : le dépôt Git est hors de ton bac à sable. Ne fais pas de commit, laisse tes modifications dans ce dossier ; ne pousse rien.)', '');
      out.push(`Tâche ${task.code} — « ${task.title} »`, '', task.instructions);
      if (task.expected) out.push('', '## Résultat attendu', task.expected);
      if (task.criteria) out.push('', '## Critères de réussite', task.criteria);
      if (task.resources || task.links?.length) out.push('', '## Ressources', task.resources, ...(task.links || []).map(l => '- ' + (l.label ? l.label + ' : ' : '') + l.url));
      out.push(...files);
      if (handoff) out.push('', '## Reprise', `Cette tâche a déjà été travaillée${handoff.engine ? ' avec ' + (LABEL[handoff.engine] || handoff.engine) : ''} (${handoff.reason}). Tu ouvres une nouvelle session : des modifications peuvent déjà être dans ce dossier (branche ${c.branch}) — regarde \`git status\` et \`git diff --stat\` avant de continuer.${last?.result ? '\nDernier résultat connu :\n' + clip500(last.result) : ''}`);
      if (note) out.push('', '## Précisions', note);
    } else {
      out.push(`Suite (${task.code}) :`, note || (kind === 'execute' ? '' : 'Reprends où tu en étais.'), ...files);
    }
    if (mode === 'plan') out.push('', '## Phase : plan', 'Ne modifie rien. Lis seulement ce qui est utile, puis donne un plan court : fichiers à modifier, étapes, tests, risques.');
    else if (kind === 'execute') out.push('', 'Le plan est accepté : exécute-le (ma remarque éventuelle ci-dessus prévaut).');
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 40000);
  }
  const clip500 = value => String(value).slice(0, 500);
  function prepareRun({ task, project, s, name, kind, mode, note, fresh, handoff = null, launchKey, budgetUsd, fallback = null }) {
    const d = task.direct, sent = new Set(fresh ? [] : d.sent || []);
    const attachments = (task.attachments || []).filter(a => !sent.has(a.id)).map(a => ({ id: a.id, name: a.name, type: a.type.split(';')[0], kb: Math.max(1, Math.round(a.size / 1024)), path: files.localPath(task.id, a) }));
    // Claude reçoit l'identifiant de session choisi par Cockpit ; Codex donne le sien au démarrage (thread.started).
    const sessionId = fresh ? (name === 'claude' ? id() : '') : d.sessionId;
    // Codex ne lit pas CLAUDE.md : le contenu est joint à la première demande.
    const rules = name === 'codex' && fresh ? (() => { try { return fs.readFileSync(path.join(d.cwd, claudemd.FILE), 'utf8').slice(0, 6000); } catch { return ''; } })() : '';
    const run = { id: id(), engine: name, launchKey, kind, mode, note, agent: { name: LABEL[name] }, sessionId, fresh, budgetUsd, model: modelFor(name, task, s, !!fallback), status: 'pending', createdAt: now(), events: [],
      ...(handoff ? { handoff } : {}), ...(fallback ? { fallback } : {}) };
    run.prompt = directBrief({ task, name, kind, mode, note, fresh, handoff, attachments, rules });
    event(run, 'requested', (fresh ? 'Nouvelle session ' : 'Reprise de la session ') + LABEL[name] + (mode === 'plan' ? ' · plan en lecture seule' : '') + (fallback ? ' · secours après ' + LABEL[fallback.from] : handoff ? ' · reprise (' + handoff.reason + ')' : ''));
    task.runs.push(run);
    if (task.runs.length > 30) task.runs.splice(0, task.runs.length - 30);
    if (name === 'claude') Object.assign(d, { sessionId, engine: 'claude' });
    return { run, attachmentIds: attachments.map(a => a.id) };
  }
  // Nouvelle session arrêtée avant le démarrage du moteur (préparation, redémarrage de Cockpit) : l'identifiant choisi
  // par Cockpit n'a jamais existé chez le moteur ; l'oublier, sinon « Relancer » tenterait de reprendre une session introuvable.
  function forgetUnstartedSession(task, run) {
    if (run.fresh && run.status === 'pending' && task.direct?.sessionId && task.direct.sessionId === run.sessionId) delete task.direct.sessionId;
  }
  // Avant le moteur, dans le suivi asynchrone (la réponse HTTP du lancement n'attend pas) : dépendances du worktree, puis tests de départ
  // une fois par commit de départ. Faux si l'exécution a été arrêtée entre-temps (arrêt demandé ou arrêt de Cockpit).
  async function prepareWorktree(task, run) {
    // Claude prépare et vérifie son environnement lui-même, comme en lancement direct.
    if (run.engine === 'claude') return true;
    const d = task.direct, controller = new AbortController(), signal = controller.signal;
    preparing.set(run.id, controller);
    let deps = null;
    try {
      const plan = taskEnv.plan(d.cwd);
      if (plan) {
        event(run, 'prepare', 'Préparation des dépendances… (' + plan.label + ')'); saveSoon();
        deps = await taskEnv.install(d.cwd, { signal });
        if (deps) { d.deps = { at: now(), status: deps.status, label: deps.label, summary: deps.summary }; event(run, 'prepare', taskEnvironment.describeInstall(deps)); saveSoon(); }
      }
      if (!signal.aborted && !closing && d.baseSha && d.baseline?.sha !== d.baseSha && taskEnv.testScript(d.cwd) && (await engines[run.engine].gitState(d.cwd))?.head === d.baseSha) {
        event(run, 'baseline', 'Tests de départ…'); saveSoon();
        const baseline = await taskEnv.baseline(d.cwd, d.baseSha, { signal });
        if (baseline) { d.baseline = baseline; event(run, 'baseline', taskEnvironment.describeBaseline(baseline)); saveSoon(); }
      }
    } catch (error) { log('Préparation du worktree : ' + error.message); event(run, 'prepare', 'Préparation incomplète : ' + harness.redact(text(error.message, 300))); }
    finally { preparing.delete(run.id); }
    if (closing || run.stopRequested || !OPEN_RUN.includes(run.status)) forgetUnstartedSession(task, run);
    if (closing) { if (OPEN_RUN.includes(run.status)) fail(task, run, 'interrupted', 'Cockpit s’est arrêté pendant la préparation du worktree : « Relancer » reprend.'); return false; }
    if (run.stopRequested || !OPEN_RUN.includes(run.status)) { if (OPEN_RUN.includes(run.status)) fail(task, run, 'interrupted', 'Arrêtée à votre demande avant le démarrage du moteur.'); return false; }
    // Nouvelle session : le brief dit ce qui est prêt et comment vérifier (avant la phase « plan » éventuelle).
    if (run.fresh) {
      const section = taskEnvironment.environmentBrief({ deps: deps || (d.deps?.status && d.deps.status !== 'installed' ? d.deps : null), baseline: d.baseline?.sha === d.baseSha ? d.baseline : null, testable: taskEnv.testScript(d.cwd), visual: run.engine === 'claude' ? claude.VISUAL_CHECK : '' });
      const at = run.prompt.indexOf('\n## Phase : plan');
      run.prompt = (at < 0 ? run.prompt + '\n\n' + section : run.prompt.slice(0, at) + '\n\n' + section + run.prompt.slice(at)).slice(0, 44000);
    }
    return true;
  }
  async function followDirect(task, run, s, attachmentIds, { allowFallback = true } = {}) {
    const d = task.direct, engine = engines[run.engine], label = LABEL[run.engine];
    if (!await prepareWorktree(task, run)) return;
    const folder = path.dirname(files.localPath(task.id, { id: 'x', ext: 'x' }));
    // Pièces jointes : lisibles par Claude via --add-dir ; Codex les lit sans qu'on rende leur dossier inscriptible.
    const addDirs = run.engine === 'claude' && task.attachments?.length && fs.existsSync(folder) ? [folder] : [];
    // Une session reprise annonce un coût cumulé : le plafond de cette exécution s'ajoute à ce qui est déjà dépensé.
    const costBefore = run.fresh ? 0 : Number(d.costTotal) || 0;
    const flags = run.engine === 'claude' ? await engine.flags() : null;
    const args = engine.buildArgs({ mode: run.mode, sessionId: run.sessionId, fresh: run.fresh, settings: s, model: run.model, budgetUsd: (run.budgetUsd ?? s.maxBudgetUsd) + costBefore, addDirs, flags });
    const fallbackTo = allowFallback && s.fallback && s.fallback !== run.engine ? s.fallback : '';
    const before = fallbackTo ? await engine.gitState(d.cwd) : null; // preuve qu'aucune modification n'a eu lieu avant un secours
    run.tracking = 'live';
    // Captures de scripts/visual-check.cjs : dossier propre à l'exécution, joint à la tâche puis supprimé.
    const visualDir = run.engine === 'claude' && run.mode === 'work' ? fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-visual-')) : '';
    const runEnv = visualDir ? { COCKPIT_VISUAL_DIR: visualDir, ...(process.env.COCKPIT_CHROMIUM ? { COCKPIT_CHROMIUM: process.env.COCKPIT_CHROMIUM } : {}) } : {};
    const result = await engine.run({ runId: run.id, args, cwd: d.cwd, prompt: run.prompt, timeoutMs: s.timeoutMin * 60000, env: runEnv, onEvent: (ev, collector) => {
      if (ev.kind === 'init') {
        if (run.engine === 'codex' && collector.state.sessionId) { run.sessionId = collector.state.sessionId; Object.assign(d, { sessionId: run.sessionId, engine: 'codex' }); }
        d.sent = [...new Set([...(run.fresh ? [] : d.sent || []), ...attachmentIds])];
        if (run.mode === 'work') Object.assign(d, { workStarted: true, planPending: false });
        markStarted(task, run, label + ' a démarré' + (ev.model ? ' · ' + ev.model : ''));
      }
      else if (ev.kind === 'interaction') {
        run.interactions ||= [];
        run.interactions.push({ requestId: ev.requestId, request: JSON.parse(harness.redact(JSON.stringify(ev.request))), at: now() }); save();
      }
      else if (ev.kind === 'interaction_cancel') { run.interactions = (run.interactions || []).filter(x => x.requestId !== ev.requestId); save(); }
      else if (ev.kind === 'tool') { event(run, 'tool', ev.text); saveSoon(); }
      else if (ev.kind === 'text') { run.liveText = harness.redact(collector.state.text).slice(0, 20000); saveSoon(); }
    } });
    delete run.interactions;
    if (visualDir) attachCaptures(task, run, visualDir);
    run.metrics = result.collector.metrics({ costBefore, usageBefore: run.fresh ? null : d.usage || null, durationMs: result.durationMs, model: run.model });
    run.durationMs = result.durationMs;
    if (run.engine === 'claude') { if (run.metrics.costTotal) d.costTotal = run.metrics.costTotal; if (run.metrics.usageTotal) d.usage = run.metrics.usageTotal; }
    const out = result.collector.outcome({ code: result.code, stderr: result.stderr });
    if (run.fresh && !result.collector.state.sessionId) delete d.sessionId; // session jamais créée : la prochaine demande repart de zéro
    if (closing) return fail(task, run, 'interrupted', `Cockpit s’est arrêté pendant l’exécution. La session ${label} et le worktree sont conservés : « Relancer » reprend.`);
    if (run.stopRequested) return fail(task, run, 'interrupted', `Arrêtée à votre demande. La session ${label} et le worktree sont conservés : un message ou « Relancer » reprend.`);
    if (!result.spawnError && !result.timedOut && !out.ok && out.lostSession) { delete d.sessionId; return fail(task, run, 'failed', `La session ${label} de cette tâche est introuvable sur ce PC. Relancez : une nouvelle session sera ouverte avec les consignes complètes.`); }
    if (result.spawnError || result.timedOut || !out.ok) {
      const why = result.spawnError || (result.timedOut ? `Limite Cockpit de durée atteinte (${s.timeoutMin} min hors attente de réponse) : ${label} a été arrêté. Le worktree et la session sont conservés ; « Relancer » reprend.`
        : out.budget ? `Limite Cockpit de coût estimé atteinte (${run.budgetUsd ?? s.maxBudgetUsd} $).` : out.error);
      let refused = '';
      if (fallbackTo) {
        const decision = harness.fallbackDecision({ result, activity: result.collector.state.activity, errorText: result.spawnError || out.error, before, after: await engine.gitState(d.cwd) });
        refused = !decision.ok ? decision.why : !engines[fallbackTo].enabled ? LABEL[fallbackTo] + ' direct est désactivé sur ce PC'
          : directRuns(task).length >= s.maxRuns ? `limite de ${s.maxRuns} exécutions atteinte` : fallbackTo === 'claude' && runBudget(task, s) < MIN_RUN_USD ? 'budget de la tâche épuisé' : '';
        if (!refused) return fallback(task, run, s, fallbackTo, decision, why);
        event(run, 'fallback', `Secours ${LABEL[fallbackTo]} non lancé : ${refused}`); run.fallbackRefused = refused;
      }
      const tail = refused ? `\n\nSecours ${LABEL[fallbackTo]} non lancé : ${refused}. Décision humaine requise : relancez, corrigez ou changez de moteur.` : '';
      return fail(task, run, result.timedOut ? 'interrupted' : 'failed', harness.redact(text(why, 2000)) + tail);
    }
    const reply = harness.redact(out.text);
    run.summary = await engine.summary({ cwd: d.cwd, baseSha: d.baseSha }).catch(() => null);
    const { status, body } = run.engine === 'claude' ? { status: '', body: reply } : harness.verdict(reply);
    if (run.mode === 'plan' && !status) {
      const plan = text(harness.redact(result.collector.state.plan) || body, 20000);
      Object.assign(run, { status: 'succeeded', outcome: 'plan', result: plan, endedAt: now() }); run.startedAt ||= run.endedAt; delete run.liveText; delete run.tracking;
      d.planPending = true; event(run, 'plan', 'Plan prêt · relisez-le, précisez si besoin, puis « Exécuter le plan »');
      task.status = 'review'; task.updatedAt = now(); return save();
    }
    finalize(task, run, reply);
  }
  // PNG produits pendant l'exécution (les plus récents, nombre et taille bornés) : pièces jointes de la tâche, déjà connues de la session.
  const MAX_CAPTURES = 8, MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
  function attachCaptures(task, run, dir) {
    try {
      const pngs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.png$/i.test(e.name)).map(e => ({ file: path.join(dir, e.name), stat: fs.statSync(path.join(dir, e.name)) }))
        .filter(x => x.stat.size > 0 && x.stat.size <= MAX_CAPTURE_BYTES).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, MAX_CAPTURES).reverse();
      const added = [];
      for (const { file } of pngs) {
        try { added.push(files.add(task, { name: 'capture-' + path.basename(file), data: fs.readFileSync(file), by: LABEL[run.engine] })); }
        catch (error) { if (error instanceof AttachmentError) { event(run, 'visual', 'Captures non jointes : ' + error.message); break; } throw error; }
      }
      if (added.length) { task.direct.sent = [...new Set([...(task.direct.sent || []), ...added.map(a => a.id)])]; task.updatedAt = now(); event(run, 'visual', added.length + (added.length > 1 ? ' captures jointes' : ' capture jointe') + ' à la tâche'); }
    } catch (error) { log('Captures : ' + error.message); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // Secours : l'exécution primaire est close en échec, puis l'autre moteur reçoit la même demande dans une nouvelle session,
  // dans le même worktree (resté propre). Un seul secours par demande : jamais de secours du secours.
  function fallback(task, run, s, to, decision, error) {
    const d = task.direct;
    Object.assign(run, { status: 'failed', error: harness.redact(text(error, 2000)), endedAt: now(), fallbackTo: to }); delete run.liveText; delete run.tracking;
    event(run, 'fallback', `${LABEL[run.engine]} indisponible (${decision.reason}) · secours automatique : ${LABEL[to]}, nouvelle session`);
    delete d.sessionId;
    const handoff = { engine: run.engine, reason: decision.reason };
    const next = prepareRun({ task, project: findProject(task.projectId), s, name: to, kind: run.kind, mode: run.mode, note: run.note, fresh: true, handoff,
      launchKey: run.launchKey + ':secours', budgetUsd: runBudget(task, s), fallback: { from: run.engine, runId: run.id, reason: decision.reason } });
    save();
    return followDirect(task, next.run, s, next.attachmentIds, { allowFallback: false });
  }
  // Arrêt demandé par l'utilisateur : le processus et ses enfants sont arrêtés, la session et le worktree restent.
  function respondInteraction(tid, body) {
    const task = findTask(tid), run = openRun(task);
    const item = run?.interactions?.find(x => x.requestId === body.requestId);
    if (!item || run.engine !== 'claude') throw new HttpError(409, 'Cette demande Claude n’est plus en attente.');
    if (!['allow', 'deny'].includes(body.behavior)) throw new HttpError(400, 'Choisissez autoriser ou refuser.');
    const input = item.request.input || {};
    let response = { behavior: 'deny', message: text(body.message, 8000) || 'Refusé par l’utilisateur.' };
    if (body.behavior === 'allow') {
      const updatedInput = { ...input };
      if (item.request.tool_name === 'AskUserQuestion') {
        const answers = {};
        for (const q of input.questions || []) {
          const answer = body.answers?.[q.question];
          if (typeof answer !== 'string' || !answer.trim() || answer.length > 8000) throw new HttpError(400, 'Répondez à chaque question.');
          answers[q.question] = answer;
        }
        updatedInput.answers = answers;
      }
      response = { behavior: 'allow', updatedInput };
    }
    if (!engines.claude.respond(run.id, body.requestId, response)) throw new HttpError(409, 'Le processus Claude n’attend plus cette réponse.');
    item.response = body.behavior; item.answeredAt = now();
    if (item.request.tool_name === 'AskUserQuestion' && response.behavior === 'allow') item.answers = JSON.parse(harness.redact(JSON.stringify(response.updatedInput.answers)));
    run.interactionHistory ||= []; run.interactionHistory.push(item);
    run.interactions = run.interactions.filter(x => x !== item);
    save(); return task;
  }
  function stop(tid) {
    const task = findTask(tid), run = openRun(task);
    if (!run || !isDirectRun(run)) throw new HttpError(409, 'Aucune exécution Claude Code ou Codex à arrêter sur cette tâche.');
    run.stopRequested = true;
    const child = engines[run.engine].active.get(run.id);
    preparing.get(run.id)?.abort();
    if (child) harness.killTree(child); else { forgetUnstartedSession(task, run); fail(task, run, 'interrupted', 'Arrêtée à votre demande avant le démarrage du moteur.'); }
    return task;
  }
  // Régénère le CLAUDE.md d'un projet (seulement s'il a été généré par Cockpit et jamais retouché).
  async function regenerateClaudeMd(pid) { const project = findProject(pid); await prepareClaudeMd(project, { regenerate: true }); project.updatedAt = now(); save(); return project; }

  // ----- Déploiement : service dédié (CT 113), nouveau projet --------------------------------------
  // Cockpit enregistre le projet auprès du service (PUT), déclenche un déploiement manuel à la demande et affiche l'état.
  // Le service clone lui-même depuis GitHub et sonde la branche de production quand le déploiement automatique est actif.
  // Jeton : uniquement dans la configuration du serveur Cockpit ; rien d'identifiant ne passe par l'interface ni par project.deployState.
  const ACTIVE = ['pending', 'running'];
  const sha = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  const deployState = project => project.deployState ||= {};
  const deployActive = project => ACTIVE.includes(project.deployState?.last?.status);
  const asDeployHttp = error => error instanceof DeployerError ? new HttpError(DEPLOY_HTTP[error.code] || 502, error.message) : error;
  let ticks = 0;

  // Identifiant du projet dans le service ([a-z0-9-], 40 caractères) : tiré du nom, figé à la première réussite, jamais réutilisé
  // pour un autre dépôt (un projet inconnu de ce nom est créé, un projet du même dépôt est repris, un autre dépôt fait passer au nom suivant).
  async function claimSlug(project) {
    const state = deployState(project);
    if (state.slugClaimed && state.slug) return state.slug;
    const repo = githubRepo(project.context?.repository).web;
    const taken = new Set(store.projects.filter(p => p !== project).map(p => p.deployState?.slug).filter(Boolean));
    const base = slug(project.name);
    for (let n = 1; n <= 6; n++) {
      const candidate = n === 1 ? base : base.slice(0, 38) + '-' + n;
      if (taken.has(candidate)) continue;
      const existing = await deployer.getProject(candidate);
      if (!existing || deploy.sameRepoName(existing.repo, repo)) { state.slug = candidate; state.slugClaimed = true; return candidate; }
    }
    throw new DeployerError('conflict', 'Aucun identifiant libre pour ce projet dans le service de déploiement (plusieurs projets portent un nom proche).');
  }
  // Enregistre (ou met à jour) le projet auprès du service. Ne lève jamais pour une panne du service : le résultat est dans deployState.registered.
  async function registerNow(project, { force = false } = {}) {
    const d = deploy.settingsOf(project), state = deployState(project);
    if (project.archived) return state.registered;
    if (!d.url && !d.type && !state.slug) { if (!Object.keys(state).length) delete project.deployState; return null; } // projet sans déploiement : rien à faire
    if (!d.type && deployer.configured && githubRepo(project.context?.repository)) await adoptRemoteRecipe(project);
    const lacking = deploy.missing(project);
    if (lacking.length) { state.registered = { status: 'pending', at: now(), error: 'À compléter : ' + lacking.join(', ') + '.' }; save(); return state.registered; }
    if (!deployer.configured) { state.registered = { status: 'failed', retry: false, at: now(), error: deployer.reason }; save(); return state.registered; }
    const body = deploy.payload(project), hash = sha(JSON.stringify(body));
    if (!force && state.registered?.status === 'ok' && state.registered.hash === hash) return state.registered;
    try {
      const result = await deployer.putProject(await claimSlug(project), body);
      state.registered = { status: 'ok', hash, at: now(), error: '' };
      if (d.publicDomain) state.subdomain = { name: d.publicDomain, status: result.subdomainStatus || state.subdomain?.status || '', detail: '' };
      else delete state.subdomain;
    } catch (error) {
      if (!(error instanceof DeployerError)) throw error;
      state.registered = { status: 'failed', retry: ['unreachable', 'timeout'].includes(error.code), at: now(), error: text(error.message, 400) };
    }
    save(); return state.registered;
  }
  // Le type n'est plus demandé : si le service connaît déjà ce projet (même dépôt), sa recette est reprise. Une panne du service laisse le projet « à compléter ».
  async function adoptRemoteRecipe(project) {
    try {
      const remote = await deployer.getProject(await claimSlug(project));
      if (!remote || !deploy.sameRepoName(remote.repo, githubRepo(project.context.repository).web)) return;
      const adopted = deploy.adoptRecipe(project.deployment, remote.recipe);
      if (adopted) { project.deployment = adopted; log('Recette de déploiement reprise du service : ' + project.key + ' (' + adopted.type + ')'); save(); }
    } catch (error) { if (!(error instanceof DeployerError) && !(error instanceof deploy.InputError)) throw error; }
  }
  // Une seule inscription à la fois par projet (créer puis modifier vite ne produit pas deux PUT concurrents).
  const registrations = new Map();
  function queueRegistration(project, options) {
    const next = (registrations.get(project.id) || Promise.resolve()).catch(() => {}).then(() => registerNow(project, options));
    registrations.set(project.id, next);
    next.catch(() => {}).finally(() => { if (registrations.get(project.id) === next) registrations.delete(project.id); });
    return next;
  }
  // Tâches closes et publiées : « Déployé » quand un déploiement réussi contient leur commit ; sinon l'erreur reste visible sur la tâche (Terminé).
  // Un même déploiement n'est examiné qu'une fois par tâche.
  async function syncDeployed(project, last) {
    if (!['succeeded', 'failed', 'rolled_back'].includes(last.status) || !last.commit) return;
    const dir = project.workspace?.status === 'ready' ? project.workspace.path : '';
    const contains = async commit => commit === last.commit || (!!dir && !!workspaces.git && await workspaces.git(['-C', dir, 'merge-base', '--is-ancestor', commit, last.commit]).then(() => true, () => false));
    let changed = false;
    for (const task of store.tasks.filter(t => t.projectId === project.id && t.status === 'done' && t.published?.commit && t.deployCheck !== last.id)) {
      if (!(await contains(task.published.commit))) continue;
      task.deployCheck = last.id; changed = true;
      if (last.status === 'succeeded') { Object.assign(task, { status: 'deployed', deployedAt: last.finishedAt || now(), movedAt: now(), deployment: { id: last.id, commit: last.commit } }); delete task.deployError; }
      else task.deployError = { id: last.id, at: last.finishedAt || now(), message: text(last.message || (last.status === 'rolled_back' ? 'Déploiement annulé : retour à la version précédente.' : 'Le déploiement a échoué.'), 300) };
    }
    if (changed) save();
  }
  // Relit l'état côté service (dernier déploiement, journal court, nom public). Une panne du service est notée sans effacer l'état connu.
  async function refreshDeploy(project) {
    const state = deployState(project);
    if (!state.slug || state.registered?.status !== 'ok') return project;
    try {
      const remote = await deployer.getProject(state.slug);
      if (!remote) state.registered = { status: 'failed', retry: false, at: now(), error: 'Le service de déploiement ne connaît plus ce projet : utilisez « Réenregistrer ».' };
      else {
        if (remote.latest) { state.last = remote.latest; await syncDeployed(project, remote.latest); }
        if (deploy.settingsOf(project).publicDomain) { const sub = await deployer.getSubdomain(state.slug); if (sub) state.subdomain = { name: sub.name, status: sub.status, detail: sub.detail }; }
        state.error = '';
      }
    } catch (error) { if (!(error instanceof DeployerError)) throw error; state.error = text(error.message, 300); }
    state.checkedAt = now(); save(); return project;
  }
  async function unpushedWarning(project) {
    const dir = project.workspace?.status === 'ready' ? project.workspace.path : '', branch = deploy.settingsOf(project).branch;
    if (!dir || !workspaces.git) return '';
    try {
      const count = Number((await workspaces.git(['-C', dir, 'rev-list', '--count', `origin/${branch}..${branch}`])).trim());
      return count > 0 ? `${count} commit${count > 1 ? 's' : ''} de la copie locale ${count > 1 ? 'ne sont' : 'n’est'} pas encore sur GitHub (branche ${branch}) : le service déploie la version de GitHub.` : '';
    } catch { return ''; }
  }
  // Bouton « Déployer » : déploiement manuel (aussi quand le déploiement automatique est actif).
  async function deployNow(pid) {
    const project = findProject(pid), d = deploy.settingsOf(project), state = deployState(project);
    const lacking = deploy.missingText(project);
    if (lacking) throw new HttpError(409, lacking);
    if (!deployer.configured) throw new HttpError(503, deployer.reason);
    if (deployActive(project)) throw new HttpError(409, 'Un déploiement est déjà en cours pour ce projet.');
    const registered = await queueRegistration(project);
    if (registered?.status !== 'ok') throw new HttpError(registered?.status === 'pending' ? 409 : 502, registered?.error || 'Le projet n’est pas enregistré auprès du service de déploiement.');
    const warning = await unpushedWarning(project);
    try {
      const started = await deployer.deploy(state.slug);
      state.last = { id: started.deploymentId, status: started.status, trigger: 'manual', commit: '', previousCommit: '', createdAt: now(), startedAt: '', finishedAt: '', step: '', message: '', log: [] };
      state.error = ''; save();
    } catch (error) {
      if (error instanceof DeployerError && error.service === 'deploy_in_progress') { await refreshDeploy(project); throw new HttpError(409, 'Un déploiement est déjà en cours pour ce projet.'); }
      throw asDeployHttp(error);
    }
    await refreshDeploy(project);
    log('Déploiement lancé : ' + project.key + ' (' + d.branch + ')');
    return { project, warnings: warning ? [warning] : [] };
  }
  async function reregister(pid) {
    const project = findProject(pid), lacking = deploy.missingText(project);
    if (lacking) throw new HttpError(409, lacking);
    const registered = await queueRegistration(project, { force: true });
    if (registered?.status !== 'ok') throw new HttpError(502, registered?.error || 'Enregistrement impossible.');
    return refreshDeploy(project);
  }
  // Nom public : le service n'agit qu'après l'accord de l'utilisateur sur CE nom. Cette route est la seule à appeler l'approbation.
  async function validatePublic(pid, body) {
    const project = findProject(pid), d = deploy.settingsOf(project), state = deployState(project);
    if (!d.publicDomain) throw new HttpError(409, 'Ce projet n’a pas de nom public à valider.');
    if (text(body.name, 120).toLowerCase() !== d.publicDomain) throw new HttpError(400, 'Le nom confirmé ne correspond pas au nom public du projet : rechargez la page.');
    if (state.registered?.status !== 'ok') throw new HttpError(409, 'Le projet n’est pas encore enregistré auprès du service de déploiement.');
    const sub = await deployer.getSubdomain(state.slug);
    if (!sub || sub.name !== d.publicDomain) throw new HttpError(409, 'Le service de déploiement n’a pas de demande en attente pour ' + d.publicDomain + '. Utilisez « Réenregistrer » puis réessayez.');
    if (sub.status !== 'awaiting_validation') throw new HttpError(409, 'Rien à valider : l’état du nom public est « ' + sub.status + ' ».');
    await deployer.approveSubdomain(state.slug);
    log('Mise en ligne publique validée par l’utilisateur : ' + d.publicDomain);
    await refreshDeploy(project); return project;
  }
  async function deployTick() {
    ticks++;
    for (const project of store.projects) {
      const state = project.deployState; if (project.archived || !state?.registered) continue;
      if (state.registered.status === 'failed' && state.registered.retry && Date.now() - Date.parse(state.registered.at) > 60000) { await queueRegistration(project).catch(() => {}); continue; }
      if (state.registered.status === 'pending' && !deploy.settingsOf(project).type && ticks % 4 === 1) { await queueRegistration(project).catch(() => {}); continue; } // recette préparée entre-temps dans le service
      if (state.registered.status === 'ok' && (deployActive(project) || (deploy.settingsOf(project).auto && ticks % 4 === 0))) await refreshDeploy(project).catch(() => {});
    }
  }
  // Ce que l'interface de création doit savoir : service configuré, GitHub utilisable.
  async function deployConfig() {
    const service = deployer.describe();
    if (service.configured) { try { await deployer.health(); service.reachable = true; } catch (error) { service.reachable = !['unreachable', 'timeout'].includes(error.code); if (!service.reachable) service.error = error.message; } }
    return { service, github: await github.status().catch(() => ({ available: false, reason: 'Contrôle de GitHub impossible.' })), publicSuffix: deploy.PUBLIC_SUFFIX() };
  }

  // Projet nouveau : dépôt GitHub créé, copie locale, squelette, premier push, enregistrement. Chaque étape est reprenable.
  function newRepositoryPlan(body, project) {
    const request = body.newRepository;
    if (request === undefined || request === null || request === false) return null;
    if (typeof request !== 'object' || Array.isArray(request)) throw new HttpError(400, 'Nouveau dépôt : réglages invalides.');
    if (githubRepo(project.context?.repository)) throw new HttpError(400, 'Choisissez un dépôt existant OU un nouveau dépôt, pas les deux.');
    const name = text(request.name, 100) || slug(project.name), owner = text(request.owner, 39);
    if (!NAME.test(name) || /\.git$/i.test(name)) throw new HttpError(400, 'Nom de dépôt non valide (lettres, chiffres, « . _ - », 100 caractères au plus).');
    if (owner && !OWNER.test(owner)) throw new HttpError(400, 'Compte GitHub non valide.');
    const folder = workspaces.target('https://github.com/x/' + name);
    if (folder && fs.existsSync(folder)) throw new HttpError(409, 'Le dossier ' + folder + ' existe déjà : rien n’a été créé. Choisissez un autre nom de dépôt.');
    return { name, owner, isPrivate: request.private !== false };
  }
  const bootstrapping = new Set();
  async function runBootstrap(project) {
    const b = project.bootstrap; if (!b || b.status === 'done' || bootstrapping.has(project.id)) return;
    bootstrapping.add(project.id); Object.assign(b, { status: 'running', error: '', at: now() }); save();
    const step = name => { b.step = name; b.at = now(); save(); };
    try {
      if (!githubRepo(project.context?.repository)) {
        step('repo');
        const info = await github.status();
        if (!info.available) throw new Error(info.reason);
        const owner = b.request.owner || info.account;
        if (!owner) throw new Error('Compte GitHub inconnu : indiquez le propriétaire du nouveau dépôt.');
        const created = await github.createRepo({ owner, name: b.request.name, isPrivate: b.request.isPrivate });
        project.context = { ...(project.context || {}), repository: created.web }; b.created = created.web; save();
      }
      const repo = githubRepo(project.context.repository);
      if (project.workspace?.status !== 'ready' || !sameRepo(project.workspace.repo, repo.web)) {
        step('clone');
        const cloned = await workspaces.clone(repo.web);
        project.workspace = { repo: repo.web, path: cloned.path, status: 'ready', reused: cloned.reused, error: '', at: now() }; save();
      }
      step('push');
      await bootstrap.seed({ project, dir: project.workspace.path, branch: deploy.settingsOf(project).branch, git: workspaces.git });
      step('claudemd');
      if (directEnabled) await prepareClaudeMd(project).catch(error => log('CLAUDE.md : ' + error.message));
      step('register');
      await registerNow(project);
      Object.assign(b, { status: 'done', step: '', error: '', at: now() });
    } catch (error) {
      Object.assign(b, { status: 'failed', error: text(error.message, 500), at: now() });
    } finally { bootstrapping.delete(project.id); save(); }
  }
  function retryBootstrap(project) {
    const b = project.bootstrap;
    if (!b) throw new HttpError(409, 'Ce projet n’a pas été créé avec un nouveau dépôt.');
    if (b.status === 'running' || bootstrapping.has(project.id)) throw new HttpError(409, 'La création est déjà en cours.');
    if (b.status === 'done') throw new HttpError(409, 'La création est déjà terminée.');
    runBootstrap(project); return project;
  }

  // ----- Agent dédié à un projet ---------------------------------------------------------
  // Sur clic de l'utilisateur uniquement : Cockpit demande à l'agent principal d'OpenClaw de créer l'agent du projet,
  // puis l'associe au projet dès qu'il apparaît dans le catalogue de la passerelle. Cockpit ne crée aucun agent lui-même.
  const AGENT_WAIT = 30 * 60000;
  const slug = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projet';
  function agentRequestText(project, agentId) {
    const c = project.context || {}, settings = agentSettings(project), files = workspaceFiles(agentId);
    const head = [
      `Bonjour, c'est Cockpit, à la demande de l'utilisateur (clic sur « Créer l'agent OpenClaw » du projet ${project.key}).`,
      `Crée un agent OpenClaw dédié à ce projet, avec l'identifiant exact « ${agentId} », en utilisant les commandes OpenClaw dont tu disposes (vérifie leur syntaxe avec openclaw agents --help). Donne-lui son propre espace de travail.`,
      'Configure son modèle primaire exact sur anthropic/claude-opus-5-5 et sa chaîne de secours sur [openai/gpt-5.6-sol]. Le secours doit être explicite dans la configuration propre à cet agent afin de prendre le relais en cas de limite, quota, indisponibilité ou autre erreur admissible au basculement.',
      (settings.kind === 'code'
        ? 'Réglages économes en jetons pour un agent de développement (fichiers, commandes, git et GitHub, web, navigateur, captures ; sans messagerie, automatisations, appareils, médias génératifs ni wiki).'
        : 'Réglages pour un agent généraliste (profil OpenClaw « coding » avec navigateur, toutes les compétences).')
        + ' Applique modèle, outils et compétences en une commande, puis vérifie l’entrée avec openclaw config get :',
      configCommand(agentId, settings),
      'Si le projet exige un outil ou une compétence absent de cette liste, ajoute-le explicitement à son entrée plutôt que de retirer le profil.',
      'Dans cet espace, écris dans AGENTS.md uniquement le contexte ci-dessous (il remplace le modèle générique d’OpenClaw)' + (c.repository ? ' et clone le dépôt du projet' : '') + '. Remplace aussi les modèles USER.md, IDENTITY.md et SOUL.md par les versions courtes données à la fin.',
      'Règles : aucun secret (clé, jeton, mot de passe) dans ce contexte ; ne crée pas de projet dans Cockpit (il existe déjà, Cockpit associera l’agent tout seul) ; ne crée ni ne modifie aucun dépôt.',
      '', '----- AGENTS.md -----', `## Projet ${project.key} — ${project.name}`];
    const context = [];
    if (project.description) context.push(project.description);
    if (c.objective) context.push('', 'Objectif : ' + c.objective);
    if (c.instructions) context.push('', 'Instructions générales :', c.instructions);
    if (c.repository) context.push('', 'Dépôt : ' + c.repository);
    if (c.environment) context.push('Environnement : ' + c.environment);
    if (c.resources) context.push('', 'Ressources :', c.resources);
    if (c.links?.length) context.push('', 'Liens :', ...c.links.map(l => '- ' + (l.label ? l.label + ' : ' : '') + l.url));
    const tail = ['', RULES, '----- fin d’AGENTS.md -----',
      ...Object.entries(files).flatMap(([name, body]) => ['', `----- ${name} -----`, body.trimEnd()]),
      '', 'Termine ta réponse par une ligne seule : STATUT: TERMINÉ si l’agent existe, ou STATUT: ÉCHEC avec la raison au-dessus.'].join('\n');
    const start = head.join('\n') + '\n';
    return start + context.join('\n').slice(0, Math.max(0, 30000 - start.length - tail.length - 1)) + '\n' + tail;
  }
  // Envoie un message dans une conversation Cockpit et attend la réponse complète.
  async function converse(conversationId, message) {
    const response = await feedme('agents/conversations/' + encodeURIComponent(conversationId) + '/messages', { method: 'POST', raw: true, body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(AGENT_WAIT) });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) { const body = await response.json().catch(() => ({})); throw new HttpError(502, body.error || 'Cockpit a refusé la demande.'); }
    const decoder = new TextDecoder(); let buffer = '', reply = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }); let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1]; let payload = {}; try { payload = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || '{}'); } catch { continue; }
        if (name === 'replace') reply = payload.text || ''; else if (name === 'delta') reply += payload.text || '';
        else if (name === 'error') throw new HttpError(502, payload.message || 'L’agent n’a pas pu répondre.');
      }
    }
    return reply;
  }
  async function linkRequestedAgent(project) {
    const request = project.agentRequest; if (request?.status !== 'pending') return false;
    const found = (await agents({ fresh: true })).find(a => a.connectionId === request.connectionId && a.agentId === request.agentId);
    if (!found) return false;
    project.agent = { connectionId: found.connectionId, agentId: found.agentId, name: found.name };
    Object.assign(request, { status: 'done', endedAt: now(), error: '' }); project.updatedAt = now(); save(); return true;
  }
  async function requestAgent(pid) {
    const project = findProject(pid);
    if (project.agent) throw new HttpError(409, 'Ce projet a déjà un agent : ' + project.agent.name + '.');
    if (project.agentRequest?.status === 'pending') throw new HttpError(409, 'La création de l’agent est déjà demandée : attendez la réponse d’OpenClaw.');
    const overview = await feedme('agents/');
    const connection = (overview.connections || []).find(c => c.kind === 'openclaw' && c.gateway?.state === 'connected');
    if (!connection) throw new HttpError(409, 'Aucune passerelle OpenClaw connectée : rien n’a été demandé.');
    const catalog = await feedme('agents/connections/' + encodeURIComponent(connection.id) + '/agents');
    const known = new Set((catalog.agents || []).map(a => a.id));
    const main = known.has(catalog.defaultId) ? catalog.defaultId : known.has('main') ? 'main' : catalog.agents?.[0]?.id;
    if (!main) throw new HttpError(409, 'La passerelle OpenClaw ne présente aucun agent capable de traiter la demande.');
    let agentId = slug(project.name), n = 2;
    while (known.has(agentId)) agentId = slug(project.name).slice(0, 36) + '-' + n++;
    const conversation = await feedme('agents/conversations', { method: 'POST', body: JSON.stringify({ connectionId: connection.id, agentId: main }) });
    const request = { status: 'pending', agentId, connectionId: connection.id, via: (catalog.agents.find(a => a.id === main)?.name || main), conversationId: conversation.id, at: now() };
    project.agentRequest = request; save();
    converse(conversation.id, agentRequestText(project, agentId))
      .then(async reply => {
        // Le projet a pu être modifié entre-temps : on relit la version enregistrée.
        if (await linkRequestedAgent(store.projects.find(x => x.id === project.id) || project).catch(() => false)) return;
        if (/STATUT\s*:\s*[ÉE]CHEC/i.test(reply)) Object.assign(request, { status: 'failed', endedAt: now(), error: text(reply.replace(MARKER, ''), 600) || 'OpenClaw signale un échec.' });
        else request.reply = text(reply, 600); // en attente : l'agent apparaîtra peut-être un peu plus tard
        save();
      }, error => { if (request.status === 'pending') { Object.assign(request, { status: 'failed', endedAt: now(), error: text(error.message, 400) }); save(); } });
    return project;
  }
  // Demandes en attente (y compris après un redémarrage) : association dès que l'agent apparaît, abandon après 30 min.
  async function checkAgentRequests() {
    for (const project of store.projects) {
      const request = project.agentRequest; if (request?.status !== 'pending') continue;
      if (await linkRequestedAgent(project).catch(() => false)) continue;
      if (Date.now() - Date.parse(request.at) > AGENT_WAIT) { Object.assign(request, { status: 'failed', endedAt: now(), error: request.reply || 'L’agent « ' + request.agentId + ' » n’est pas apparu sur la passerelle OpenClaw dans les 30 minutes.' }); save(); }
    }
  }

  let reconciling = false;
  const timer = setInterval(() => { if (reconciling) return; reconciling = true; Promise.all([reconcile(), checkAgentRequests(), deployTick()]).catch(() => {}).finally(() => { reconciling = false; }); }, reconcileEvery);
  timer.unref?.();
  // Au démarrage, aucune exécution n'est suivie en direct : toutes passent par la relecture.
  // Une exécution d'un moteur direct ne peut pas être relue : elle est marquée interrompue (session et worktree conservés).
  for (const task of store.tasks) for (const run of task.runs) if (OPEN_RUN.includes(run.status)) {
    if (!isDirectRun(run)) { run.tracking = 'recovering'; continue; }
    forgetUnstartedSession(task, run);
    Object.assign(run, { status: 'interrupted', error: `Cockpit a redémarré pendant l’exécution. La session ${LABEL[run.engine]} et le worktree sont conservés : « Relancer » reprend.`, endedAt: now() });
    delete run.interactions; delete run.tracking; delete run.liveText; event(run, 'interrupted', 'Exécution interrompue par un redémarrage de Cockpit'); task.status = 'blocked';
  }

  // Création interrompue par un redémarrage : reprenable (chaque étape sait ce qui est déjà fait).
  for (const project of store.projects) if (project.bootstrap?.status === 'running') Object.assign(project.bootstrap, { status: 'failed', error: 'Cockpit a redémarré pendant la création du projet. « Réessayer » reprend où elle s’était arrêtée.', at: now() });

  function snapshot() {
    const byId = new Map(store.projects.map(p => [p.id, p]));
    // engineByTask : moteur qui traitera chaque tâche (celui de la tâche, sinon celui du projet).
    return { projects: store.projects, tasks: store.tasks, deployInfo: Object.fromEntries(store.projects.map(p => [p.id, { missing: deploy.missingText(p), active: deployActive(p) }])), engineByTask: Object.fromEntries(store.tasks.map(t => [t.id, engineOf(t, byId.get(t.projectId))])),
      capabilities: { ...CAPABILITIES, deploy: { ...deployer.describe(), types: deploy.TYPES, publicSuffix: deploy.PUBLIC_SUFFIX() }, direct: directEnabled, engines: { claude: engines.claude.enabled, codex: engines.codex.enabled, ...(!openclawEnabled ? { openclaw: false } : {}) }, directDefaults: harness.directSettings({}) }, now: now() };
  }

  // ----- Accès des agents (Claude, Codex, OpenClaw…) -------------------------------------
  // Un agent peut organiser le travail : créer et modifier projets et tâches, archiver un projet.
  // Il ne peut pas lancer une exécution, valider un résultat ni supprimer : ces gestes restent ceux de l'utilisateur.
  const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const TASK_WORDS = { 'a faire': 'todo', 'en cours': 'doing', bloque: 'blocked', bloquee: 'blocked', 'a valider': 'review', termine: 'done', terminee: 'done' };
  const PROJECT_WORDS = { 'a preparer': 'prep', actif: 'active', 'en pause': 'paused', termine: 'done' };
  const PRIORITY_WORDS = { aucune: 0, 'sans priorite': 0, basse: 1, moyenne: 2, haute: 3, urgent: 4, urgente: 4 };
  const word = (value, map, list) => value === undefined ? undefined : list.includes(value) ? value : map[fold(value)] ?? value;
  function agentProject(ref) {
    const key = fold(ref); if (!key) throw new HttpError(400, 'Indiquez le projet (nom, code ou identifiant).');
    const hits = store.projects.filter(p => p.id === ref || fold(p.key) === key || fold(p.name) === key);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new HttpError(400, 'Plusieurs projets correspondent : utilisez le code ou l’identifiant (' + hits.map(p => p.key + ' = ' + p.name).join(', ') + ').');
    throw new HttpError(404, 'Projet introuvable : « ' + text(ref, 80) + ' ». Projets existants : ' + (store.projects.filter(p => !p.archived).map(p => p.key + ' (' + p.name + ')').join(', ') || 'aucun') + '.');
  }
  function agentTask(ref) {
    const key = fold(ref);
    return store.tasks.find(t => t.id === ref || fold(t.code) === key) || (() => { throw new HttpError(404, 'Tâche introuvable : « ' + text(ref, 80) + ' ». Utilisez son code (ex. ' + (store.tasks[0]?.code || 'PR-1') + ').'); })();
  }
  async function agentAssignee(value) {
    if (value === null || value === '' || fold(value) === 'manuelle' || fold(value) === 'aucun') return null;
    const key = fold(typeof value === 'object' ? value.agentId || value.name : value);
    const match = list => list.filter(a => a.agentId && (fold(a.agentId) === key || fold(a.name) === key));
    let list = await agents(), hits = match(list);
    // Agent tout juste créé sur OpenClaw : on relit le catalogue de la passerelle avant de refuser.
    if (!hits.length) { list = await agents({ fresh: true }); hits = match(list); }
    if (hits.length !== 1) throw new HttpError(400, (hits.length ? 'Plusieurs agents s’appellent ainsi' : 'Agent OpenClaw inconnu : « ' + text(key, 60) + ' »') + '. Agents disponibles : ' + list.filter(a => a.agentId).map(a => a.agentId + ' (' + a.name + ')').join(', ') + '.');
    return { connectionId: hits[0].connectionId, agentId: hits[0].agentId, name: hits[0].name };
  }
  const pick = (body, keys) => Object.fromEntries(keys.filter(k => k in body).map(k => [k, body[k]]));
  // Déploiement vu par un agent : lecture seule (url, mode, dernier état). Déployer, activer l'automatique et valider un nom public restent à l'utilisateur.
  function deployView(p) {
    const d = deploy.settingsOf(p), st = p.deployState || {};
    if (!d.url && !d.type && !st.slug) return null;
    return { url: d.url, auto: d.auto, branch: d.branch, type: d.type, registered: st.registered?.status || 'none', last: st.last ? { status: st.last.status, trigger: st.last.trigger, commit: st.last.commit, at: st.last.finishedAt || st.last.createdAt } : null, ...(d.publicDomain ? { publicDomain: d.publicDomain, publicDomainStatus: st.subdomain?.status || '' } : {}) };
  }
  function viewProject(p) {
    const tasks = store.tasks.filter(t => t.projectId === p.id), count = s => tasks.filter(t => t.status === s).length;
    return { id: p.id, key: p.key, name: p.name, status: p.status, priority: p.priority, due: p.due || '', description: p.description || '', archived: !!p.archived, context: p.context || {},
      agent: p.agent ? p.agent.agentId + ' (' + p.agent.name + ')' : null, engine: p.engine || 'openclaw',
      claudeMd: p.claudeMd ? { status: p.claudeMd.status, chars: p.claudeMd.chars } : null,
      ...(p.agentRequest && !p.agent ? { agentRequest: { status: p.agentRequest.status, agentId: p.agentRequest.agentId, ...(p.agentRequest.error ? { error: p.agentRequest.error } : {}) } } : {}),
      localFolder: p.workspace ? { status: p.workspace.status, path: p.workspace.path, ...(p.workspace.error ? { error: p.workspace.error } : {}) } : null,
      deploy: deployView(p),
      ...(p.bootstrap ? { newRepository: { status: p.bootstrap.status, step: p.bootstrap.step, ...(p.bootstrap.error ? { error: p.bootstrap.error } : {}) } } : {}),
      tasks: { total: tasks.length, todo: count('todo'), doing: count('doing'), blocked: count('blocked'), review: count('review'), done: count('done'), deployed: count('deployed') }, createdBy: p.createdBy || '' };
  }
  function viewTask(t) {
    const run = t.runs.at(-1), p = store.projects.find(x => x.id === t.projectId);
    return { id: t.id, code: t.code, project: p ? p.key + ' · ' + p.name : '', title: t.title, status: t.status, priority: t.priority, due: t.due || '', agent: t.agent ? t.agent.agentId + ' (' + t.agent.name + ')' : 'manuelle', engine: engineOf(t, p),
      instructions: t.instructions, expected: t.expected, criteria: t.criteria, resources: t.resources, links: t.links, question: t.question || '', lastRun: run ? { status: run.status, outcome: run.outcome || '', at: run.endedAt || run.createdAt } : null, createdBy: t.createdBy || '',
      attachments: (t.attachments || []).map(a => ({ id: a.id, name: a.name, type: a.type.split(';')[0], size: a.size, by: a.by || '', download: 'tasks/' + t.code + '/attachments/' + a.id, localPath: files.localPath(t.id, a) })),
      localFolder: p?.workspace?.status === 'ready' ? p.workspace.path : '' };
  }
  // Une colonne « En cours » sans exécution confirmée induirait en erreur pour une tâche confiée à OpenClaw.
  function agentStatusGuard(task, status, assignee) {
    if (status === undefined || status === task.status) return;
    if (status === 'doing' && assignee) throw new HttpError(400, 'Une tâche confiée à un agent OpenClaw passe « En cours » seulement quand l’utilisateur la lance. Laissez-la « À faire ».');
    if (status === 'done' && task.status === 'review' && task.runs.at(-1)?.outcome === 'result') throw new HttpError(403, 'Le résultat de l’agent attend la validation de l’utilisateur : seule l’interface Projets peut le valider.');
  }
  async function agentCall(method, parts, query, body, client) {
    const route = method + ' ' + parts.map((p, i) => i % 2 ? ':ref' : p).join('/');
    const ref = parts[1] ? decodeURIComponent(parts[1]) : '';
    switch (route) {
      case 'GET state': {
        const includeArchived = query.get('archived') === '1';
        const project = query.get('project') ? agentProject(query.get('project')) : null;
        return { projects: store.projects.filter(p => (includeArchived || !p.archived) && (!project || p === project)).map(viewProject),
          tasks: store.tasks.filter(t => (!project || t.projectId === project.id) && (query.get('status') ? t.status === word(query.get('status'), TASK_WORDS, TASK_STATUS) : true)).map(viewTask) };
      }
      case 'GET agents': return { agents: (await agents()).map(a => ({ agentId: a.agentId, name: a.name, available: a.available, connection: a.connectionName, ...(a.reason ? { reason: a.reason } : {}) })) };
      case 'GET tasks/:ref': return viewTask(agentTask(ref));
      case 'GET tasks/:ref/attachments/:ref': { const task = agentTask(ref); files.find(task, decodeURIComponent(parts[3])); return { file: task, attachment: decodeURIComponent(parts[3]) }; }
      case 'GET workspace': {
        // « Où suis-je ? » : retrouve le projet dont le dossier local contient ce chemin (pour Claude Code).
        const norm = value => path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
        const here = norm(query.get('path'));
        const project = store.projects.filter(p => p.workspace?.path && (here === norm(p.workspace.path) || here.startsWith(norm(p.workspace.path) + path.sep))).sort((a, b) => b.workspace.path.length - a.workspace.path.length)[0];
        if (!project) throw new HttpError(404, 'Aucun projet Cockpit n’a ce dossier. Projets avec un dossier local : ' + (store.projects.filter(p => p.workspace?.path && !p.archived).map(p => p.key + ' → ' + p.workspace.path).join(', ') || 'aucun') + '.');
        return { project: viewProject(project), tasks: store.tasks.filter(t => t.projectId === project.id && t.status !== 'done').map(viewTask) };
      }
      case 'POST projects': {
        const input = pick(body, ['name', 'description', 'status', 'priority', 'due', 'key', 'context', 'engine']);
        input.context = { ...(input.context && typeof input.context === 'object' ? input.context : {}), ...('repository' in body ? { repository: body.repository } : {}) };
        delete input.context.autoPublish; // autoriser la publication automatique reste un choix de l'utilisateur
        const repo = githubRepo(input.context.repository);
        if (!repo) throw new HttpError(400, 'Un dépôt GitHub est obligatoire pour un projet créé par un agent : context.repository = "https://github.com/<compte>/<dépôt>". Crée d’abord le dépôt s’il n’existe pas.');
        const twin = store.projects.find(p => !p.archived && sameRepo(p.context?.repository, repo.web));
        if (twin) throw new HttpError(409, 'Ce dépôt est déjà celui du projet ' + twin.key + ' (' + twin.name + ').');
        input.status = word(input.status, PROJECT_WORDS, PROJECT_STATUS) ?? 'prep'; if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
        // Un agent OpenClaw donné à la création sans moteur précisé garde le comportement d'avant : le projet reste sur OpenClaw.
        if (input.agent && !('engine' in body)) input.engine = 'openclaw';
        const project = createProject(input); project.createdBy = client; save(); return viewProject(project);
      }
      case 'PATCH projects/:ref': {
        const project = agentProject(ref), input = pick(body, ['name', 'description', 'status', 'priority', 'due', 'archived', 'context', 'engine']);
        if ('repository' in body) input.context = { ...(input.context || {}), repository: body.repository };
        if (input.context && typeof input.context === 'object') { input.context = { ...input.context }; delete input.context.autoPublish; }
        if (input.context && 'repository' in input.context && !githubRepo(input.context.repository)) throw new HttpError(400, 'Le dépôt doit rester une adresse GitHub : https://github.com/<compte>/<dépôt>.');
        if ('status' in input) input.status = word(input.status, PROJECT_WORDS, PROJECT_STATUS); if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
        const updated = updateProject(project.id, input); updated.updatedBy = client; save(); return viewProject(updated);
      }
      case 'POST projects/:ref/clone': return viewProject(retryWorkspace(agentProject(ref)));
      case 'POST tasks': {
        const project = agentProject(body.project ?? body.projectId);
        if (project.archived) throw new HttpError(409, 'Ce projet est archivé : restaurez-le avant d’y ajouter une tâche.');
        const input = pick(body, ['title', 'instructions', 'expected', 'criteria', 'resources', 'links', 'priority', 'due', 'includeContext', 'engine']);
        if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        const assignee = 'agent' in body ? await agentAssignee(body.agent) : project.agent || null;
        if (assignee && 'agent' in body && !('engine' in body)) input.engine = 'openclaw'; // agent OpenClaw choisi explicitement pour cette tâche
        const status = word(body.status, TASK_WORDS, TASK_STATUS) ?? 'todo';
        if (!TASK_STATUS.includes(status)) throw new HttpError(400, 'Colonne inconnue : utilisez À faire, Bloqué, À valider ou Terminé.');
        agentStatusGuard({ status: 'todo', runs: [] }, status, assignee);
        const task = createTask({ ...input, projectId: project.id, agent: assignee, status }); task.createdBy = client; save(); return viewTask(task);
      }
      case 'PATCH tasks/:ref': {
        const task = agentTask(ref);
        if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours sur ' + task.code + ' : attendez son résultat avant de modifier la tâche.');
        const input = pick(body, ['title', 'instructions', 'expected', 'criteria', 'resources', 'links', 'priority', 'due', 'includeContext', 'engine']);
        if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
        if (input.agent && !('engine' in body) && !task.runs.length) input.engine = 'openclaw';
        if ('status' in body) { input.status = word(body.status, TASK_WORDS, TASK_STATUS); agentStatusGuard(task, input.status, 'agent' in input ? input.agent : task.agent); }
        if (body.project ?? body.projectId) { const project = agentProject(body.project ?? body.projectId); if (project.id !== task.projectId) throw new HttpError(400, 'Déplacer une tâche vers un autre projet n’est pas possible : créez-la dans le bon projet.'); }
        const updated = updateTask(task.id, input); updated.updatedBy = client; save(); return viewTask(updated);
      }
      case 'POST tasks/:ref/attachments': {
        const task = agentTask(ref);
        if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours sur ' + task.code + ' : attendez son résultat avant d’ajouter un fichier.');
        const data = typeof body.data === 'string' && /^[A-Za-z0-9+/=\s_-]+$/.test(body.data) ? Buffer.from(body.data, 'base64') : null;
        if (!data?.length) throw new HttpError(400, 'Envoyez {"name": "capture.png", "data": "<contenu en base64>"}.');
        addAttachment(task.id, body.name, data, client); return viewTask(task);
      }
      default:
        if (/launch|accept|deploy|bootstrap/.test(route) || method === 'DELETE') throw new HttpError(403, 'Lancer une exécution, valider un résultat, déployer ou supprimer reste réservé à l’utilisateur, dans l’interface Projets.');
        throw new HttpError(404, 'Opération inconnue. Disponibles : GET state, GET agents, GET workspace?path=, GET tasks/<code>, GET tasks/<code>/attachments/<id>, POST projects, PATCH projects/<projet>, POST projects/<projet>/clone, POST tasks, PATCH tasks/<code>, POST tasks/<code>/attachments.');
    }
  }

  async function readRaw(req, max) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'Fichier trop lourd : 10 Mo au maximum.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function handle(req, res, url, json) {
    const parts = url.pathname.replace(/^\/api\/projects\/?/, '').split('/').filter(Boolean);
    // Pièces jointes : contenu brut, nom dans ?name=.
    if (parts[0] === 'tasks' && parts[2] === 'attachments') {
      try {
        if (req.method === 'POST' && parts.length === 3) { const meta = addAttachment(parts[1], url.searchParams.get('name'), await readRaw(req, 10 * 1024 * 1024 + 1)); return json(res, 200, { attachment: meta, task: findTask(parts[1]) }); }
        if (req.method === 'GET' && parts.length === 4) return files.send(res, findTask(parts[1]), parts[3]);
        if (req.method === 'DELETE' && parts.length === 4) return json(res, 200, removeAttachment(parts[1], parts[3]));
        return json(res, 405, { error: 'Opération indisponible.' });
      } catch (error) {
        const known = error instanceof HttpError || error instanceof AttachmentError;
        if (!known) log('Projets : ' + error.message);
        return json(res, error.status || 500, { error: known ? error.message : 'Une erreur est survenue.' });
      }
    }
    let body = {};
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) return json(res, 413, { error: 'Contenu trop volumineux.' }); chunks.push(chunk); }
      if (chunks.length) try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'Requête invalide.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Requête invalide.' });
    }
    try {
      const route = req.method + ' ' + parts.map((p, i) => i % 2 ? ':id' : p).join('/');
      const a = parts[1];
      switch (route) {
        case 'GET state': return json(res, 200, snapshot());
        case 'GET agents': return json(res, 200, { agents: await agents() });
        case 'GET deploy-config': return json(res, 200, await deployConfig());
        case 'GET projects/:id/deploy': return json(res, 200, await refreshDeploy(findProject(a)));
        case 'POST projects/:id/deploy': return json(res, 202, await deployNow(a));
        case 'POST projects/:id/deploy-register': return json(res, 200, await reregister(a));
        case 'POST projects/:id/deploy-public': return json(res, 200, await validatePublic(a, body));
        case 'POST projects/:id/bootstrap': return json(res, 202, retryBootstrap(findProject(a)));
        case 'POST projects': return json(res, 200, createProject(body));
        case 'PATCH projects/:id': return json(res, 200, updateProject(a, body));
        case 'POST projects/:id/clone': return json(res, 200, retryWorkspace(findProject(a)));
        case 'POST projects/:id/claude-md': return json(res, 200, await regenerateClaudeMd(a));
        case 'POST tasks/:id/respond': return json(res, 200, respondInteraction(a, body));
        case 'POST tasks/:id/stop': return json(res, 200, stop(a));
        case 'POST projects/:id/agent-request': return json(res, 202, await requestAgent(a));
        case 'POST tasks': return json(res, 200, createTask(body));
        case 'PATCH tasks/:id': return json(res, 200, updateTask(a, body));
        case 'DELETE tasks/:id': deleteTask(a); return json(res, 200, { ok: true });
        case 'POST tasks/:id/launch': { const result = await launch(a, body); return json(res, result.repeated ? 200 : 202, result); }
        case 'POST tasks/:id/accept': return json(res, 200, await accept(a, body || {}));
        default: return json(res, 405, { error: 'Opération indisponible.' });
      }
    } catch (error) {
      error = asDeployHttp(error);
      if (!(error instanceof HttpError)) log('Projets : ' + error.message);
      return json(res, error.status || 500, { error: error instanceof HttpError ? error.message : 'Une erreur est survenue.' });
    }
  }
  const allowedRoute = (method, pathname) => /^\/api\/projects\/(state|agents|deploy-config)$/.test(pathname) ? method === 'GET'
    : /^\/api\/projects\/projects\/[\w-]+\/deploy$/.test(pathname) ? ['GET', 'POST'].includes(method)
    : /^\/api\/projects\/(projects|tasks)$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/projects\/[\w-]+$/.test(pathname) ? method === 'PATCH'
    : /^\/api\/projects\/projects\/[\w-]+\/(clone|agent-request|claude-md|bootstrap|deploy-register|deploy-public)$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/tasks\/[\w-]+\/attachments$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/tasks\/[\w-]+\/attachments\/[\w-]+$/.test(pathname) ? ['GET', 'DELETE'].includes(method)
    : /^\/api\/projects\/tasks\/[\w-]+$/.test(pathname) ? ['PATCH', 'DELETE'].includes(method)
    : /^\/api\/projects\/tasks\/[\w-]+\/(launch|accept|stop)$/.test(pathname) ? method === 'POST' : false;
  function close() { closing = true; clearInterval(timer); for (const c of streams.values()) c.abort(); for (const c of preparing.values()) c.abort(); engines.claude.close(); engines.codex.close(); if (saveTimer) save(); }
  async function agentHandle(req, res, url, json, client) {
    const parts = url.pathname.replace(/^\/agent\/v1\/?/, '').split('/').filter(Boolean);
    let body = {};
    if (['POST', 'PATCH'].includes(req.method)) {
      // Une pièce jointe arrive en base64 (10 Mo de fichier ≈ 13,4 Mo de texte).
      const limit = parts[2] === 'attachments' ? 14 * 1024 * 1024 : 256 * 1024;
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > limit) return json(res, 413, { error: limit > 256 * 1024 ? 'Fichier trop lourd : 10 Mo au maximum.' : 'Contenu trop volumineux.' }); chunks.push(chunk); }
      if (chunks.length) try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'JSON invalide.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'JSON invalide : un objet est attendu.' });
    }
    try {
      const result = await agentCall(req.method, parts, url.searchParams, body, client);
      if (result?.file) return files.send(res, result.file, result.attachment);
      return json(res, req.method === 'POST' && !parts.includes('clone') ? 201 : 200, result);
    } catch (error) {
      const known = error instanceof HttpError || error instanceof AttachmentError;
      if (!known) log('Projets (agent) : ' + error.message);
      return json(res, error.status || 500, { error: known ? error.message : 'Une erreur est survenue.' });
    }
  }
  return { handle, agentHandle, allowedRoute, close, reconcile, checkAgentRequests, deployTick, snapshot, brief, finalize: (tid, rid, content) => { const t = findTask(tid); finalize(t, t.runs.find(r => r.id === rid), content); } };
}

module.exports = { createProjects, projectKey, CAPABILITIES };
