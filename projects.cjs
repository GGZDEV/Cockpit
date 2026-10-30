'use strict';
// Projets personnels et exécutions d'agents OpenClaw.
// Les exécutions passent par la connexion OpenClaw de Cockpit (aucune seconde connexion).
// Le serveur Cockpit suit lui-même chaque exécution : un rafraîchissement de la page
// ne la coupe pas, et après un redémarrage l'état est relu dans l'historique de la passerelle
// sans jamais renvoyer la demande.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWorkspaces, githubRepo, sameRepo } = require('./workspace.cjs');
const { createAttachments, AttachmentError } = require('./attachments.cjs');

const PROJECT_STATUS = ['prep', 'active', 'paused', 'done'];
const TASK_STATUS = ['todo', 'doing', 'blocked', 'review', 'done'];
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

function createProjects({ dataDir = path.join(__dirname, 'data'), discover, fetchImpl = fetch, reconcileEvery = 15000, log = () => {}, workspaces = createWorkspaces() } = {}) {
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
    if ('key' in body && text(body.key, 6)) out.key = text(body.key, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || out.key;
    if (body.context && typeof body.context === 'object') {
      const c = { ...(out.context || {}) };
      for (const [k, max] of [['objective', 4000], ['instructions', 12000], ['resources', 12000], ['repository', 600], ['environment', 2000]]) if (k in body.context) c[k] = text(body.context[k], max);
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
    if ('status' in body) { if (!TASK_STATUS.includes(body.status)) throw new HttpError(400, 'Colonne inconnue.'); out.status = body.status; }
    if ('order' in body && Number.isFinite(Number(body.order))) out.order = Number(body.order);
    return out;
  }
  function createProject(body) {
    const project = projectInput({ status: 'prep', priority: 0, due: '', description: '', color: '#3dd68c', ...body, context: body.context || {} }, { id: id(), createdAt: now(), seq: 0, archived: false });
    project.key ||= projectKey(project.name);
    store.projects.push(project); syncWorkspace(project); save(); return project;
  }
  function updateProject(pid, body) {
    const index = store.projects.findIndex(p => p.id === pid); if (index < 0) throw new HttpError(404, 'Projet introuvable.');
    store.projects[index] = { ...projectInput(body, store.projects[index]), updatedAt: now() }; syncWorkspace(store.projects[index]); save(); return store.projects[index];
  }

  // ----- Dossier local (clone GitHub sur ce PC) ------------------------------------------
  // Le clone démarre dès qu'un projet reçoit une adresse GitHub ; un dossier existant n'est jamais écrasé.
  function syncWorkspace(project, { retry = false } = {}) {
    const repo = githubRepo(project.context?.repository), w = project.workspace;
    if (!repo) return;
    // Même dépôt déjà traité : on ne recommence que sur demande explicite (« Réessayer »).
    if (w && sameRepo(w.repo, repo.web) && (w.status === 'cloning' || !retry)) return;
    const workspace = { repo: repo.web, path: workspaces.target(repo.web), status: 'cloning', at: now() };
    project.workspace = workspace;
    workspaces.clone(repo.web).then(result => Object.assign(workspace, { status: 'ready', path: result.path, reused: result.reused, error: '', at: now() }),
      error => Object.assign(workspace, { status: 'failed', error: text(error.message, 400), at: now() }))
      .finally(() => { if (project.workspace === workspace) save(); });
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
  function accept(tid) {
    const task = findTask(tid);
    if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours : attendez son résultat.');
    const run = task.runs.findLast(r => r.status === 'succeeded' && r.outcome === 'result');
    if (run) run.accepted = now();
    Object.assign(task, { status: 'done', acceptedAt: now(), question: '', updatedAt: now() }); save(); return task;
  }

  // ----- Lancement explicite ----------------------------------------------------------------
  function brief(task, project, run) {
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
    lines.push('', '## Cadre',
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
    const kind = ['initial', 'reprise', 'answer', 'retry'].includes(body.kind) ? body.kind : task.runs.length ? 'retry' : 'initial';
    const note = text(body.note, 8000);
    if ((kind === 'reprise' || kind === 'answer') && !note) throw new HttpError(400, kind === 'answer' ? 'Écrivez votre réponse avant de relancer.' : 'Ajoutez les instructions de reprise.');
    const missing = [!task.title && 'un titre', !task.instructions && 'des consignes', !task.agent && 'un agent assigné'].filter(Boolean);
    if (missing.length) throw new HttpError(400, 'Avant de lancer, ajoutez ' + missing.join(', ') + '.');
    const project = findProject(task.projectId);
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
      task.question = ''; save();
      follow(task, run);
      return { task, run };
    } finally { launching.delete(task.id); }
  }

  function finalize(task, run, content) {
    const reply = String(content || '');
    const match = [...reply.matchAll(new RegExp(MARKER.source, 'gim'))].at(-1);
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
      if (!OPEN_RUN.includes(run.status) || streams.has(run.id)) continue;
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
  // ----- Agent dédié à un projet ---------------------------------------------------------
  // Sur clic de l'utilisateur uniquement : Cockpit demande à l'agent principal d'OpenClaw de créer l'agent du projet,
  // puis l'associe au projet dès qu'il apparaît dans le catalogue de la passerelle. Cockpit ne crée aucun agent lui-même.
  const AGENT_WAIT = 30 * 60000;
  const slug = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projet';
  function agentRequestText(project, agentId) {
    const c = project.context || {}, lines = [
      `Bonjour, c'est Cockpit, à la demande de l'utilisateur (clic sur « Créer l'agent OpenClaw » du projet ${project.key}).`,
      `Crée un agent OpenClaw dédié à ce projet, avec l'identifiant exact « ${agentId} », en utilisant les commandes OpenClaw dont tu disposes (vérifie leur syntaxe avec openclaw agents --help). Donne-lui son propre espace de travail.`,
      'Dans cet espace, écris le contexte ci-dessous dans AGENTS.md' + (c.repository ? ' et clone le dépôt du projet' : '') + '.',
      'Règles : aucun secret (clé, jeton, mot de passe) dans ce contexte ; ne crée pas de projet dans Cockpit (il existe déjà, Cockpit associera l’agent tout seul) ; ne crée ni ne modifie aucun dépôt.',
      '', `## Projet ${project.key} — ${project.name}`];
    if (project.description) lines.push(project.description);
    if (c.objective) lines.push('', 'Objectif : ' + c.objective);
    if (c.instructions) lines.push('', 'Instructions générales :', c.instructions);
    if (c.repository) lines.push('', 'Dépôt : ' + c.repository);
    if (c.environment) lines.push('Environnement : ' + c.environment);
    if (c.resources) lines.push('', 'Ressources :', c.resources);
    if (c.links?.length) lines.push('', 'Liens :', ...c.links.map(l => '- ' + (l.label ? l.label + ' : ' : '') + l.url));
    lines.push('', 'Termine ta réponse par une ligne seule : STATUT: TERMINÉ si l’agent existe, ou STATUT: ÉCHEC avec la raison au-dessus.');
    return lines.join('\n').slice(0, 30000);
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
  const timer = setInterval(() => { if (reconciling) return; reconciling = true; Promise.all([reconcile(), checkAgentRequests()]).catch(() => {}).finally(() => { reconciling = false; }); }, reconcileEvery);
  timer.unref?.();
  // Au démarrage, aucune exécution n'est suivie en direct : toutes passent par la relecture.
  for (const task of store.tasks) for (const run of task.runs) if (OPEN_RUN.includes(run.status)) run.tracking = 'recovering';

  function snapshot() { return { projects: store.projects, tasks: store.tasks, capabilities: CAPABILITIES, now: now() }; }

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
  function viewProject(p) {
    const tasks = store.tasks.filter(t => t.projectId === p.id), count = s => tasks.filter(t => t.status === s).length;
    return { id: p.id, key: p.key, name: p.name, status: p.status, priority: p.priority, due: p.due || '', description: p.description || '', archived: !!p.archived, context: p.context || {},
      agent: p.agent ? p.agent.agentId + ' (' + p.agent.name + ')' : null,
      ...(p.agentRequest && !p.agent ? { agentRequest: { status: p.agentRequest.status, agentId: p.agentRequest.agentId, ...(p.agentRequest.error ? { error: p.agentRequest.error } : {}) } } : {}),
      localFolder: p.workspace ? { status: p.workspace.status, path: p.workspace.path, ...(p.workspace.error ? { error: p.workspace.error } : {}) } : null,
      tasks: { total: tasks.length, todo: count('todo'), doing: count('doing'), blocked: count('blocked'), review: count('review'), done: count('done') }, createdBy: p.createdBy || '' };
  }
  function viewTask(t) {
    const run = t.runs.at(-1), p = store.projects.find(x => x.id === t.projectId);
    return { id: t.id, code: t.code, project: p ? p.key + ' · ' + p.name : '', title: t.title, status: t.status, priority: t.priority, due: t.due || '', agent: t.agent ? t.agent.agentId + ' (' + t.agent.name + ')' : 'manuelle',
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
        const input = pick(body, ['name', 'description', 'status', 'priority', 'due', 'key', 'context']);
        input.context = { ...(input.context && typeof input.context === 'object' ? input.context : {}), ...('repository' in body ? { repository: body.repository } : {}) };
        const repo = githubRepo(input.context.repository);
        if (!repo) throw new HttpError(400, 'Un dépôt GitHub est obligatoire pour un projet créé par un agent : context.repository = "https://github.com/<compte>/<dépôt>". Crée d’abord le dépôt s’il n’existe pas.');
        const twin = store.projects.find(p => !p.archived && sameRepo(p.context?.repository, repo.web));
        if (twin) throw new HttpError(409, 'Ce dépôt est déjà celui du projet ' + twin.key + ' (' + twin.name + ').');
        input.status = word(input.status, PROJECT_WORDS, PROJECT_STATUS) ?? 'prep'; if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
        const project = createProject(input); project.createdBy = client; save(); return viewProject(project);
      }
      case 'PATCH projects/:ref': {
        const project = agentProject(ref), input = pick(body, ['name', 'description', 'status', 'priority', 'due', 'archived', 'context']);
        if ('repository' in body) input.context = { ...(input.context || {}), repository: body.repository };
        if (input.context && 'repository' in input.context && !githubRepo(input.context.repository)) throw new HttpError(400, 'Le dépôt doit rester une adresse GitHub : https://github.com/<compte>/<dépôt>.');
        if ('status' in input) input.status = word(input.status, PROJECT_WORDS, PROJECT_STATUS); if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
        const updated = updateProject(project.id, input); updated.updatedBy = client; save(); return viewProject(updated);
      }
      case 'POST projects/:ref/clone': return viewProject(retryWorkspace(agentProject(ref)));
      case 'POST tasks': {
        const project = agentProject(body.project ?? body.projectId);
        if (project.archived) throw new HttpError(409, 'Ce projet est archivé : restaurez-le avant d’y ajouter une tâche.');
        const input = pick(body, ['title', 'instructions', 'expected', 'criteria', 'resources', 'links', 'priority', 'due', 'includeContext']);
        if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        const assignee = 'agent' in body ? await agentAssignee(body.agent) : project.agent || null;
        const status = word(body.status, TASK_WORDS, TASK_STATUS) ?? 'todo';
        if (!TASK_STATUS.includes(status)) throw new HttpError(400, 'Colonne inconnue : utilisez À faire, Bloqué, À valider ou Terminé.');
        agentStatusGuard({ status: 'todo', runs: [] }, status, assignee);
        const task = createTask({ ...input, projectId: project.id, agent: assignee, status }); task.createdBy = client; save(); return viewTask(task);
      }
      case 'PATCH tasks/:ref': {
        const task = agentTask(ref);
        if (openRun(task)) throw new HttpError(409, 'Une exécution est en cours sur ' + task.code + ' : attendez son résultat avant de modifier la tâche.');
        const input = pick(body, ['title', 'instructions', 'expected', 'criteria', 'resources', 'links', 'priority', 'due', 'includeContext']);
        if ('priority' in input) input.priority = word(input.priority, PRIORITY_WORDS, []);
        if ('agent' in body) input.agent = await agentAssignee(body.agent);
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
        if (/launch|accept/.test(route) || method === 'DELETE') throw new HttpError(403, 'Lancer une exécution, valider un résultat ou supprimer reste réservé à l’utilisateur, dans l’interface Projets.');
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
        case 'POST projects': return json(res, 200, createProject(body));
        case 'PATCH projects/:id': return json(res, 200, updateProject(a, body));
        case 'POST projects/:id/clone': return json(res, 200, retryWorkspace(findProject(a)));
        case 'POST projects/:id/agent-request': return json(res, 202, await requestAgent(a));
        case 'POST tasks': return json(res, 200, createTask(body));
        case 'PATCH tasks/:id': return json(res, 200, updateTask(a, body));
        case 'DELETE tasks/:id': deleteTask(a); return json(res, 200, { ok: true });
        case 'POST tasks/:id/launch': { const result = await launch(a, body); return json(res, result.repeated ? 200 : 202, result); }
        case 'POST tasks/:id/accept': return json(res, 200, accept(a));
        default: return json(res, 405, { error: 'Opération indisponible.' });
      }
    } catch (error) {
      if (!(error instanceof HttpError)) log('Projets : ' + error.message);
      return json(res, error.status || 500, { error: error instanceof HttpError ? error.message : 'Une erreur est survenue.' });
    }
  }
  const allowedRoute = (method, pathname) => /^\/api\/projects\/(state|agents)$/.test(pathname) ? method === 'GET'
    : /^\/api\/projects\/(projects|tasks)$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/projects\/[\w-]+$/.test(pathname) ? method === 'PATCH'
    : /^\/api\/projects\/projects\/[\w-]+\/(clone|agent-request)$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/tasks\/[\w-]+\/attachments$/.test(pathname) ? method === 'POST'
    : /^\/api\/projects\/tasks\/[\w-]+\/attachments\/[\w-]+$/.test(pathname) ? ['GET', 'DELETE'].includes(method)
    : /^\/api\/projects\/tasks\/[\w-]+$/.test(pathname) ? ['PATCH', 'DELETE'].includes(method)
    : /^\/api\/projects\/tasks\/[\w-]+\/(launch|accept)$/.test(pathname) ? method === 'POST' : false;
  function close() { clearInterval(timer); for (const c of streams.values()) c.abort(); if (saveTimer) save(); }
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
  return { handle, agentHandle, allowedRoute, close, reconcile, checkAgentRequests, snapshot, brief, finalize: (tid, rid, content) => { const t = findTask(tid); finalize(t, t.runs.find(r => r.id === rid), content); } };
}

module.exports = { createProjects, projectKey, CAPABILITIES };
