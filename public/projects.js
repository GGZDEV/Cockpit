// Onglet Projets : projets personnels, tableau Kanban et tâches confiées à Claude Code, Codex ou aux agents OpenClaw.
// L'état réel (projets, tâches, exécutions) vit sur le serveur Cockpit : /api/projects/*.
import { esc, icon, read, write, uid, safeUrl, timeoutSignal } from './core.js';
import { chatItems, composerMode, canClose, richText } from './task-chat.js';

const COLUMNS = [
  { id: 'todo', label: 'À faire', color: '#f5c542', ring: 'solid' },
  { id: 'doing', label: 'En cours', color: '#ff9f43', ring: 'half' },
  { id: 'blocked', label: 'Bloqué', color: '#ff6b6b', ring: 'solid' },
  { id: 'review', label: 'À valider', color: 'var(--accent)', ring: 'solid' },
  { id: 'done', label: 'Terminé', color: '#4c9dff', ring: 'fill' },
];
const PROJECT_STATUS = { prep: 'À préparer', active: 'Actif', paused: 'En pause', done: 'Terminé' };
const PRIORITY = { 0: ['Sans priorité', 0, '#85858a'], 1: ['Priorité basse', 1, '#9a9a9f'], 2: ['Priorité moyenne', 2, '#f5c542'], 3: ['Priorité haute', 3, '#ff9f43'], 4: ['Urgent', 3, '#ff5a5a'] };
const RUN_STATUS = { pending: 'En attente de démarrage', started: 'Démarrée', succeeded: 'Réussie', failed: 'Échouée', interrupted: 'Interrompue' };
const RUN_KIND = { initial: 'Lancement', reprise: 'Reprise', answer: 'Réponse à une question', retry: 'Relance', execute: 'Exécution du plan' };
const ENGINE = { claude: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };
const PALETTE = ['#3dd68c', '#b48cff', '#4c9dff', '#ff9f43', '#ff6b8a', '#22d3ee', '#f5c542'];
const OPEN = ['pending', 'started'];
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md,.csv,.json,.log,.html,.htm';
const MAX_FILE = 10 * 1024 * 1024;
const WORKSPACE = { cloning: 'Clonage en cours…', ready: 'Copie locale prête', failed: 'Clonage échoué' };
const DEPLOY_STATUS = { pending: ['En attente', 's-cloning'], running: ['En cours', 's-cloning'], succeeded: ['Réussi', 's-ready'], failed: ['Échoué', 's-failed'], rolled_back: ['Revenu en arrière', 's-warn'], unknown: ['État inconnu', 's-failed'] };
const DEPLOY_ACTIVE = ['pending', 'running'];
const BOOTSTRAP_STEP = { repo: 'Création du dépôt GitHub…', clone: 'Copie locale du dépôt…', push: 'Premier commit et envoi sur GitHub…', claudemd: 'Préparation du CLAUDE.md…', register: 'Enregistrement auprès du service de déploiement…', '': 'Création en cours…' };
const fmtSize = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' Ko' : (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
const isGithub = value => /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/i.test(String(value || '').trim());

const fmtDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtTime = iso => iso ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const lastRun = task => task.runs?.at(-1);
const openRun = task => task.runs?.find(r => OPEN.includes(r.status));
const linksText = links => (links || []).map(l => l.label ? l.label + ' | ' + l.url : l.url).join('\n');
const parseLinks = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [a, b] = line.split('|').map(s => s.trim()); return b ? { label: a, url: b } : { url: a }; });
const glyph = d => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const G = {
  filter: glyph('<path d="M4 5h16l-6 7.5V19l-4 1.5v-8Z"/>'),
  board: glyph('<rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="16.5" y="4" width="4" height="7" rx="1.5"/>'),
  cards: glyph('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  launch: glyph('<path d="m8 5 11 7-11 7z"/>'),
  alert: glyph('<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4m0 3h.01"/>'),
  archive: glyph('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>'),
  clip: glyph('<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>'),
  trash: glyph('<path d="M4 7h16M9 7V4.5h6V7m-8.5 0 1 13h9l1-13"/>'),
  dots: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  prompt: glyph('<path d="m5 8 4 4-4 4"/><path d="M12 16h7"/>'),
  up: glyph('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  stop: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  back: glyph('<path d="m15 6-6 6 6 6"/>'),
  chat: glyph('<path d="M5 5h14v10H9l-4 4z"/>'),
  done: glyph('<path d="m5 12 5 5 9-10"/>'),
  target: glyph('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  links: glyph('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  repo: glyph('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10a6 6 0 0 1-6 6H8"/>'),
};
// Vue « conversations » : chaque tâche est un chat, regroupé par statut dans la barre latérale.
const VIEWS = ['chat', 'board', 'grid'];
const CHAT_GROUPS = [
  { id: 'run', label: 'En cours', color: '#ff9f43', has: t => ['doing', 'blocked'].includes(t.status) || (t.status === 'todo' && !!openRun(t)) },
  { id: 'review', label: 'À valider', color: 'var(--accent)', has: t => t.status === 'review' },
  { id: 'todo', label: 'Brouillons', color: 'var(--pj-muted)', has: t => t.status === 'todo' && !openRun(t) },
  { id: 'done', label: 'Terminés', color: '#4c9dff', has: t => t.status === 'done' },
];
const TASK_PILL = { todo: ['Brouillon', 'is-draft'], doing: ['En cours', 'is-run'], blocked: ['Bloqué', 'is-block'], review: ['À valider', 'is-review'], done: ['Terminé', 'is-done'] };
const STEPS = ['Brouillon', 'En cours', 'À valider', 'Terminé'];
const STEP_OF = { todo: 0, doing: 1, blocked: 1, review: 2, done: 3 };

export function createProjectsUI({ sources, modal, showModal, toast, render, isActive }) {
  const st = { loaded: false, loading: false, error: '', projects: [], tasks: [], engines: {}, capabilities: {}, agents: null, agentsError: '',
    view: VIEWS.includes(read('mb.projects.mode', 'chat')) ? read('mb.projects.mode', 'chat') : 'chat', project: read('mb.projects.filter', 'all'), who: 'all', search: '', attention: false,
    deployInfo: {}, deployConfig: null, deployChecked: new Set(), projectStatus: 'all', archived: false, filters: false, quickAdd: null, panel: null, launching: new Set(), dragging: null,
    chat: null, drafts: {}, newFiles: [], allDone: false };
  let pollTimer;
  const pending = new WeakMap(); // formulaire -> fichiers choisis ou collés, envoyés à l'enregistrement

  async function api(route, method = 'GET', body) {
    const response = await sources.feedmeFetch('/api/projects/' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = {}; try { data = await response.json(); } catch { /* réponse vide */ }
    if (!response.ok) throw new Error(data.error || (response.status === 404 ? 'Le service des projets n’est pas disponible. Relancez Cockpit.' : 'Service des projets indisponible.'));
    return data;
  }
  const projectOf = task => st.projects.find(p => p.id === task.projectId);
  // Moteur qui traite la tâche (calculé par le serveur) ; Claude Code et Codex n'ont pas d'agent OpenClaw à choisir.
  const engineOf = task => st.engines[task.id] || 'openclaw';
  const isDirect = task => engineOf(task) !== 'openclaw';
  const assignee = task => isDirect(task) ? { name: ENGINE[engineOf(task)] } : task.agent;
  const visibleProjects = () => st.projects.filter(p => !p.archived);
  function upsert(task) { const i = st.tasks.findIndex(t => t.id === task.id); if (i >= 0) st.tasks[i] = task; else st.tasks.push(task); }

  async function refresh(quiet = true) {
    if (st.loading) return; st.loading = true;
    try { const data = await api('state'); Object.assign(st, { projects: data.projects, tasks: data.tasks, deployInfo: data.deployInfo || {}, engines: data.engineByTask || {}, capabilities: data.capabilities || {}, error: '', loaded: true }); }
    catch (e) { st.error = e.message; if (!quiet) toast(e.message); }
    finally { st.loading = false; }
    if (!st.projects.some(p => p.id === st.project)) st.project = 'all';
    renderChat(); updatePanel(); schedule();
    refreshDeploys().then(() => schedule());
  }
  async function loadAgents(force = false) {
    if (st.agents && !force) return st.agents;
    try { st.agents = (await api('agents')).agents; st.agentsError = ''; }
    catch (e) { st.agents = []; st.agentsError = e.message; }
    return st.agents;
  }
  function schedule() {
    clearTimeout(pollTimer);
    const panelOpen = modal.open && modal.querySelector('[data-pj-panel]');
    if (!isActive() && !panelOpen) return;
    const running = st.tasks.some(openRun) || st.projects.some(p => deployActive(p) || bootstrapBusy(p));
    pollTimer = setTimeout(() => { if (!document.hidden) refresh(); else schedule(); }, running ? 2500 : 20000);
  }

  // ----- Rendu de la page -----------------------------------------------------------------
  function matches(task) {
    const q = st.search.trim().toLowerCase(), p = projectOf(task);
    if (!p || p.archived) return false;
    if (st.project !== 'all' && task.projectId !== st.project) return false;
    if (st.who === 'me' && assignee(task)) return false;
    if (st.who === 'agents' && !assignee(task)) return false;
    if (st.attention && !needsMe(task)) return false;
    return !q || [task.title, task.code, task.instructions, p.name, assignee(task)?.name].some(v => String(v || '').toLowerCase().includes(q));
  }
  function needsMe(task) { const run = lastRun(task); return task.status === 'review' || task.status === 'blocked' || (run && ['failed', 'interrupted'].includes(run.status) && task.status !== 'done'); }
  function runBadge(task) {
    const run = lastRun(task); if (!run) return '';
    if (OPEN.includes(run.status)) return `<span class="pj-tag ${run.status === 'started' ? 'is-live' : 'is-wait'}"><i></i>${run.status === 'started' ? 'Agent au travail' : 'En attente de démarrage'}</span>`;
    if (task.status === 'done') return '';
    if (run.status === 'failed') return '<span class="pj-tag is-bad"><i></i>Échec</span>';
    if (run.status === 'interrupted') return '<span class="pj-tag is-bad"><i></i>Interrompue</span>';
    if (run.outcome === 'question' && task.status === 'blocked') return '<span class="pj-tag is-ask"><i></i>Question de l’agent</span>';
    if (run.outcome === 'plan' && task.status === 'review') return '<span class="pj-tag is-ok"><i></i>Plan à relire</span>';
    if (run.outcome === 'result' && task.status === 'review' && !run.accepted) return '<span class="pj-tag is-ok"><i></i>Résultat à valider</span>';
    return '';
  }
  function prioBars(priority) {
    const [label, n, color] = PRIORITY[priority] || PRIORITY[0];
    return `<span class="pj-prio" role="img" aria-label="${label}">${[5, 8, 12].map((h, i) => `<span style="height:${h}px;background:${i < n ? color : 'var(--pj-off)'}"></span>`).join('')}</span>`;
  }
  function dueChip(due, done) {
    if (!due) return '';
    const t = today(), state = done ? '' : due < t ? 'is-late' : due === t ? 'is-today' : '';
    return `<span class="pj-due ${state}">${icon('calendar')}${due === t ? 'Aujourd’hui' : fmtDay(due)}</span>`;
  }
  function avatar(task) {
    const who = assignee(task);
    if (!who) return `<span class="pj-av is-me" aria-hidden="true">M</span><span class="pj-who">Manuelle</span>`;
    const name = who.name || who.agentId;
    return `<span class="pj-av" aria-hidden="true">${esc(name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || 'A')}</span><span class="pj-who">${esc(name)}</span>`;
  }
  function card(task) {
    const p = projectOf(task), done = task.status === 'done';
    return `<article class="pj-card ${needsMe(task) && !done ? 'needs-me' : ''} ${done ? 'is-done' : ''}" draggable="true" data-pj-task="${esc(task.id)}">
      <button class="pj-card-open" data-pj="open-task" data-id="${esc(task.id)}" aria-label="Ouvrir ${esc(task.code)} ${esc(task.title)}"></button>
      <div class="pj-card-top">${prioBars(task.priority)}<span class="pj-code">${esc(task.code)}</span><span class="pj-grow"></span><span class="pj-proj"><i style="background:${esc(p?.color || '#888')}"></i>${esc(p?.name || '')}</span></div>
      <h3>${esc(task.title)}</h3>
      ${runBadge(task) ? `<div class="pj-tags">${runBadge(task)}</div>` : ''}
      <div class="pj-card-foot">${avatar(task)}<span class="pj-grow"></span>${dueChip(task.due, done)}</div>
    </article>`;
  }
  function quickAdd(colId) {
    const projects = visibleProjects();
    const choose = st.project === 'all' || !projects.some(p => p.id === st.project);
    return `<form class="pj-quick" data-pj-form="quick" data-status="${colId}">
      <label class="sr-only" for="pj-quick-title">Titre de la nouvelle tâche</label>
      <input id="pj-quick-title" name="title" maxlength="200" placeholder="Titre de la tâche…" required autocomplete="off">
      ${choose ? `<select name="projectId" aria-label="Projet">${projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` : `<input type="hidden" name="projectId" value="${esc(st.project)}">`}
      <div class="pj-quick-actions"><button class="button primary" type="submit">Ajouter</button><button class="button" type="button" data-pj="quick-cancel">Annuler</button></div>
    </form>`;
  }
  function board() {
    const list = st.tasks.filter(matches).sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    const project = st.project !== 'all' && st.projects.find(p => p.id === st.project);
    const context = project ? `<section class="pj-context" aria-label="Contexte du projet">
        <div><span class="pj-status s-${project.status}">${PROJECT_STATUS[project.status]}</span>${project.description ? `<p>${esc(project.description)}</p>` : ''}${project.context?.objective ? `<p class="muted"><b>Objectif :</b> ${esc(project.context.objective)}</p>` : '<p class="muted">Aucun objectif renseigné : ajoutez le contexte que les agents recevront.</p>'}
        ${agentLine(project)}
        ${workspaceHTML(project)}${bootstrapHTML(project)}${deployHTML(project)}</div>
        <button class="button" data-pj="edit-project" data-id="${esc(project.id)}">${icon('edit')} Projet et contexte</button></section>` : '';
    return `${context}<div class="pj-board-scroll"><div class="pj-board">${COLUMNS.map(col => {
      const tasks = list.filter(t => t.status === col.id);
      return `<section class="pj-col" data-pj-col="${col.id}" aria-label="${col.label}" style="--col:${col.color}">
        <header class="pj-col-head"><span class="pj-ring r-${col.ring}"></span><h2>${col.label}</h2><span class="pj-count">${tasks.length}</span><span class="pj-grow"></span>
          <button class="icon-button" data-pj="quick-add" data-id="${col.id}" aria-label="Ajouter une tâche dans ${col.label}" ${visibleProjects().length ? '' : 'disabled'}>${icon('plus')}</button></header>
        ${st.quickAdd === col.id ? quickAdd(col.id) : ''}
        ${tasks.map(card).join('') || `<div class="pj-empty-col">${col.id === 'blocked' ? 'Rien ne bloque' : col.id === 'review' ? 'Aucun résultat à valider' : 'Aucune tâche'}</div>`}
      </section>`;
    }).join('')}</div></div>`;
  }
  function projectCard(p) {
    const tasks = st.tasks.filter(t => t.projectId === p.id), done = tasks.filter(t => t.status === 'done').length;
    const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const count = s => tasks.filter(t => t.status === s).length;
    return `<article class="pj-pcard ${p.archived ? 'is-archived' : ''}" style="--pc:${esc(p.color || '#3dd68c')}">
      <header><span class="pj-pdot"></span><h3><button class="pj-link" data-pj="open-project" data-id="${esc(p.id)}">${esc(p.name)}</button></h3><span class="pj-status s-${p.status}">${PROJECT_STATUS[p.status]}</span></header>
      <p class="pj-pdesc">${esc(p.description || 'Pas de description')}</p>
      <div class="pj-pmeta">${p.priority ? prioBars(p.priority) + `<span>${PRIORITY[p.priority][0]}</span>` : ''}${dueChip(p.due, p.status === 'done')}<span class="muted">${esc(p.key)}</span></div>
      ${deploySummary(p)}
      <div class="pj-progress" role="progressbar" aria-label="Progression" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="pj-pstats"><span>${done}/${tasks.length} terminées · ${pct} %</span><span class="pj-grow"></span>
        <span title="En cours">${count('doing')} en cours</span><span class="${count('blocked') ? 'is-bad' : ''}">${count('blocked')} bloquée${count('blocked') > 1 ? 's' : ''}</span><span class="${count('review') ? 'is-ok' : ''}">${count('review')} à valider</span></div>
      <footer><button class="button" data-pj="open-project" data-id="${esc(p.id)}">${G.board} Tableau</button><button class="button" data-pj="edit-project" data-id="${esc(p.id)}">${icon('edit')} Modifier</button>
        <button class="button" data-pj="archive-project" data-id="${esc(p.id)}">${G.archive} ${p.archived ? 'Restaurer' : 'Archiver'}</button></footer>
    </article>`;
  }
  function grid() {
    const q = st.search.trim().toLowerCase();
    const list = st.projects.filter(p => !!p.archived === st.archived && (st.projectStatus === 'all' || p.status === st.projectStatus) &&
      (!q || [p.name, p.description, p.key].some(v => String(v || '').toLowerCase().includes(q))))
      .sort((a, b) => ['active', 'prep', 'paused', 'done'].indexOf(a.status) - ['active', 'prep', 'paused', 'done'].indexOf(b.status) || (b.priority || 0) - (a.priority || 0));
    const filters = `<div class="pj-chips" role="group" aria-label="Statut du projet">${[['all', 'Tous'], ...Object.entries(PROJECT_STATUS)].map(([id, label]) => `<button class="pj-chip" data-pj="project-status" data-id="${id}" aria-pressed="${st.projectStatus === id}">${label}</button>`).join('')}
      <button class="pj-chip" data-pj="toggle-archived" aria-pressed="${st.archived}">${G.archive} Archivés</button></div>`;
    if (!st.projects.length) return `<div class="pj-empty"><h2>Aucun projet pour l’instant</h2><p>Un projet regroupe vos tâches et le contexte que vos agents recevront : objectif, consignes, ressources, dépôt…</p><button class="button primary" data-pj="new-project">${icon('plus')} Créer un projet</button></div>`;
    return `${filters}<div class="pj-pgrid">${list.map(projectCard).join('') || `<div class="pj-empty"><p>${st.archived ? 'Aucun projet archivé.' : 'Aucun projet ne correspond à ces filtres.'}</p></div>`}</div>`;
  }
  // ----- Vue « conversations » ------------------------------------------------------------
  // Rendu qui garde le fil de la conversation ouverte collé en bas s'il l'était déjà.
  function renderChat(toEnd = false) {
    const thread = () => document.querySelector?.('.pj-chat-thread');
    const t = thread(), nearEnd = toEnd || (t && t.scrollHeight - t.scrollTop - t.clientHeight < 160);
    render();
    if (nearEnd) { const el = thread(); if (el) el.scrollTop = el.scrollHeight; }
  }
  const dotKind = t => { const run = lastRun(t); return openRun(t) ? 'run' : t.status === 'done' ? 'done' : t.status === 'review' ? 'review' : t.status === 'blocked' || ['failed', 'interrupted'].includes(run?.status) ? 'block' : t.status === 'doing' ? 'run' : 'draft'; };
  function taskMeta(task) {
    const run = lastRun(task), who = assignee(task)?.name || 'Manuelle';
    if (openRun(task)) return openRun(task).status === 'started' ? who + ' travaille…' : 'En attente de démarrage';
    if (task.status === 'done') return 'Validé';
    if (['failed', 'interrupted'].includes(run?.status)) return (run.status === 'failed' ? 'Échec' : 'Interrompue') + ' · à relancer';
    if (task.status === 'blocked') return run?.outcome === 'question' ? 'Bloqué · une question pour vous' : 'Bloqué';
    if (task.status === 'review') return run?.outcome === 'plan' ? 'Plan à relire' : 'Résultat prêt';
    return (run ? 'En pause' : 'Non lancé') + ' · ' + who;
  }
  function chatSide() {
    const list = st.tasks.filter(matches).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const visible = visibleProjects(), current = visible.find(p => p.id === st.project);
    const item = t => `<button type="button" class="pj-side-item ${st.chat === t.id ? 'is-active' : ''}" data-pj="open-task" data-id="${esc(t.id)}" ${st.chat === t.id ? 'aria-current="page"' : ''}>
      <span class="pj-dot d-${dotKind(t)}" aria-hidden="true"></span><span class="pj-side-text"><span class="pj-side-title">${esc(t.title)}</span><span class="pj-side-meta">${esc(t.code)} · ${esc(taskMeta(t))}</span></span></button>`;
    const groups = CHAT_GROUPS.map(g => {
      const items = list.filter(g.has), shown = g.id === 'done' && !st.allDone ? items.slice(0, 5) : items;
      return items.length ? `<section class="pj-side-group" aria-label="${g.label}"><h2 style="--gc:${g.color}">${g.label}<span>${items.length}</span></h2>${shown.map(item).join('')}
        ${shown.length < items.length ? '<button type="button" class="pj-side-more" data-pj="all-done">Voir toutes les tâches terminées</button>' : ''}</section>` : '';
    }).join('');
    const attention = st.tasks.filter(t => projectOf(t) && !projectOf(t).archived && needsMe(t) && t.status !== 'done').length;
    return `<nav class="pj-side" aria-label="Tâches">
      <button type="button" class="pj-side-new ${st.chat ? '' : 'is-active'}" data-pj="chat-new" ${visible.length ? '' : 'disabled'}>${icon('plus')} Nouvelle tâche</button>
      <label class="pj-side-search">${icon('search')}<span class="sr-only">Rechercher une tâche</span><input type="search" id="pj-search" placeholder="Rechercher…" value="${esc(st.search)}" autocomplete="off"></label>
      <div class="pj-side-filters"><label class="pj-side-proj">${current ? `<i style="background:${esc(current.color || '#888')}"></i>` : ''}<span class="sr-only">Projet</span><select data-pj-pick="project">${[{ id: 'all', name: 'Tous les projets' }, ...visible].map(p => `<option value="${esc(p.id)}" ${st.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        ${[['all', 'Tout'], ['me', 'Mes tâches'], ['agents', 'Agents']].map(([id, label]) => `<button type="button" class="pj-side-tab" data-pj="who" data-id="${id}" aria-pressed="${st.who === id}">${label}</button>`).join('')}
        ${attention ? `<button type="button" class="pj-side-tab pj-attn" data-pj="attention" aria-pressed="${st.attention}">${G.alert} À traiter <span>${attention}</span></button>` : ''}</div>
      <div class="pj-side-list">${groups || `<p class="pj-help">${st.tasks.length ? 'Aucune tâche ne correspond.' : 'Aucune tâche pour l’instant.'}</p>`}</div>
      <footer class="pj-side-foot"><button type="button" class="icon-button" data-pj="view-set" data-id="board" aria-label="Afficher le tableau" title="Tableau des tâches">${G.board}</button>
        <button type="button" class="icon-button" data-pj="view-set" data-id="grid" aria-label="Afficher les projets" title="Vue des projets">${G.cards}</button>
        <span class="pj-grow"></span><button type="button" class="icon-button" data-pj="new-project" aria-label="Nouveau projet" title="Nouveau projet">${icon('folder')}</button></footer></nav>`;
  }
  function projectChips(p) {
    const repo = p.context?.repository, w = p.workspace, d = deployOf(p);
    return [repo ? `<span class="pj-mini">${G.repo}${esc(isGithub(repo) ? repo.replace(/^https:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, '') : repo)}</span>` : '<span class="pj-mini">Aucun dépôt</span>',
      w ? `<span class="pj-mini ${w.status === 'ready' ? 'is-ok' : w.status === 'failed' ? 'is-bad' : ''}"><i></i>${WORKSPACE[w.status] || ''}</span>` : '',
      p.claudeMd ? '<span class="pj-mini is-ok">CLAUDE.md à jour</span>' : '',
      d.url ? `<span class="pj-mini">Déploiement ${d.auto ? 'auto' : 'manuel'} → ${esc(d.url.replace(/^https:\/\//, ''))}</span>` : ''].join('');
  }
  // Nouvelle tâche = nouveau chat : le message devient les consignes, rien ne démarre sans « Lancer ».
  function chatNew() {
    const visible = visibleProjects();
    if (!visible.length) return `<div class="pj-chat-scroll"><div class="pj-empty"><h2>Commencez par un projet</h2><p>Créez un projet (avec son dépôt GitHub), écrivez une tâche puis cliquez sur « Lancer » : Claude Code la traite sur le serveur Cockpit. Rien ne démarre sans ce clic.</p><button class="button primary" data-pj="new-project">${icon('plus')} Créer un projet</button></div></div>`;
    const p = visible.find(x => x.id === st.project) || visible[0], engine = ENGINE[p.engine || 'claude'], caps = st.capabilities.engines || {};
    const drafts = st.tasks.filter(t => t.projectId === p.id && t.status === 'todo' && !t.runs?.length).slice(0, 4);
    return `<header class="pj-chat-head"><div class="pj-crumbs"><span>${esc(p.name)}</span><span aria-hidden="true">/</span><b>Nouvelle tâche</b><span class="pj-pill is-draft"><i></i>Brouillon</span></div>
        <button class="button" data-pj="edit-project" data-id="${esc(p.id)}">${icon('edit')} Projet et contexte</button></header>
      <div class="pj-chat-scroll"><div class="pj-new">
        <div class="pj-new-hero"><span class="pj-new-mark" aria-hidden="true">${G.prompt}</span><h1>Que doit faire ${esc(engine)} sur ${esc(p.name)} ?</h1>
          <p>Écrivez la tâche comme un message. Elle reste en brouillon tant que vous n’avez pas cliqué sur « Lancer ».</p></div>
        <form class="pj-compose" data-pj-form="new-chat" id="pj-new-chat">
          <div class="pj-compose-top"><label class="pj-pick-chip"><i style="background:${esc(p.color || '#888')}"></i><span class="sr-only">Projet</span><select name="projectId" data-pj-pick="project">${visible.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <label class="pj-pick-chip"><span class="sr-only">Moteur</span><select name="engine"><option value="">Moteur du projet · ${esc(engine)}</option>${Object.entries(ENGINE).map(([v, l]) => `<option value="${v}" ${caps[v] === false ? 'disabled' : ''}>${l}</option>`).join('')}</select></label></div>
          <label class="sr-only" for="pj-new-input">Message à ${esc(engine)}</label>
          <textarea id="pj-new-input" name="instructions" rows="5" maxlength="20000" data-pj-draft="new" placeholder="Décrivez ce qu’il faut faire… Le contexte du projet et son dépôt sont joints automatiquement. Collez des captures avec Ctrl+V.">${esc(st.drafts.new || '')}</textarea>
          <ul class="pj-atts pj-pending">${pendingHTML(st.newFiles)}</ul>
          <details class="pj-compose-more" data-key="new-expected" ${st.drafts['new-expected'] ? 'open' : ''}><summary>${G.target} Résultat attendu</summary><textarea name="expected" rows="2" maxlength="4000" data-pj-draft="new-expected" placeholder="Une PR, un rapport, un fichier…">${esc(st.drafts['new-expected'] || '')}</textarea></details>
          <details class="pj-compose-more" data-key="new-links" ${st.drafts['new-links'] ? 'open' : ''}><summary>${G.links} Adresses utiles</summary><textarea name="links" rows="2" data-pj-draft="new-links" placeholder="Une par ligne, « libellé | adresse » possible">${esc(st.drafts['new-links'] || '')}</textarea></details>
          <div class="pj-compose-foot"><label class="icon-button pj-attach" title="Joindre des fichiers (captures, PDF, zip, textes · 10 Mo max)">${G.clip}<span class="sr-only">Joindre des fichiers</span><input type="file" name="files" multiple accept="${ACCEPT}" class="sr-only"></label>
            <span class="pj-grow"></span><button class="button" type="submit" name="draft" value="1">Garder en brouillon</button><button class="button primary pj-launch" type="submit">Lancer ${G.up}</button></div>
        </form>
        <div class="pj-new-chips">${projectChips(p)}</div>
        ${drafts.length ? `<section class="pj-drafts" aria-label="Reprendre un brouillon"><h2>Reprendre un brouillon</h2><div>${drafts.map(t => `<button type="button" class="pj-draft-card" data-pj="open-task" data-id="${esc(t.id)}">
            <span class="pj-side-meta"><span class="pj-dot d-draft" aria-hidden="true"></span>Brouillon · ${esc(t.code)}</span><b>${esc(t.title)}</b>${t.instructions ? `<span>${esc(t.instructions.slice(0, 140))}${t.instructions.length > 140 ? '…' : ''}</span>` : ''}</button>`).join('')}</div></section>` : ''}
      </div></div>`;
  }
  function reviewBanner(task) {
    const run = lastRun(task);
    if (task.status !== 'review' || run?.status !== 'succeeded' || run.outcome !== 'result' || run.accepted) return '';
    return `<div class="pj-review"><p>${esc(assignee(task)?.name || 'L’agent')} a terminé. Validez pour passer la tâche en Terminé, ou répondez ci-dessous pour la relancer.</p>
      <button class="button primary" data-pj="close-task" data-id="${esc(task.id)}" ${canClose(task) ? '' : 'disabled'}>${G.done} Valider et terminer</button></div>`;
  }
  function contextHTML(task, p) {
    const repo = p?.context?.repository, d = p && deployOf(p), files = lastRun(task)?.summary?.files || [];
    const ext = (url, label) => `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    const row = (label, value) => value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '';
    return `<aside class="pj-chat-aside" aria-label="Contexte de la tâche"><h2>Contexte</h2><dl>
      ${row('Projet', `<span class="pj-dot" style="background:${esc(p?.color || '#888')}" aria-hidden="true"></span>${esc(p?.name || '')}`)}
      ${row('Dépôt', repo ? (isGithub(repo) ? ext(repo, repo.replace(/^https:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, '')) : esc(repo)) : '')}
      ${row('Branche', task.direct?.branch ? `<code>${esc(task.direct.branch)}</code>` : '')}
      ${row('Résultat attendu', esc(task.expected || ''))}
      ${row('Adresses utiles', (task.links || []).map(l => ext(l.url, l.label || l.url.replace(/^https?:\/\//, ''))).join('<br>'))}
      ${row('Moteur', esc(assignee(task)?.name || 'Tâche manuelle'))}</dl>
      ${task.attachments?.length ? `<section><h3>Pièces jointes</h3>${attachmentsHTML(task)}</section>` : ''}
      ${files.length ? `<section><h3>Fichiers modifiés</h3>${files.slice(0, 12).map(f => `<code class="pj-file">${esc(f)}</code>`).join('')}${files.length > 12 ? `<p class="pj-help">et ${files.length - 12} autres</p>` : ''}</section>` : ''}
      ${d && (d.url || d.auto) ? `<div class="pj-aside-card"><span>Déploiement</span><p>${d.auto ? `Automatique dès que la tâche est close (branche ${esc(d.branch)}).` : 'Manuel, avec le bouton « Déployer » du projet.'}</p>${d.url ? ext(d.url, d.url.replace(/^https:\/\//, '')) : ''}</div>` : ''}
      <button class="button" type="button" data-pj="task-details" data-id="${esc(task.id)}">${icon('edit')} Détails de la tâche</button></aside>`;
  }
  // Tâche ouverte : en-tête (statut, avancement, actions), fil de messages, zone de saisie et contexte.
  function chatTask(task) {
    const p = projectOf(task), [label, tone] = TASK_PILL[task.status] || TASK_PILL.todo, step = STEP_OF[task.status] ?? 0, banner = reviewBanner(task);
    const steps = STEPS.map((s, i) => `${i ? '<li class="pj-step-sep" aria-hidden="true"></li>' : ''}<li class="${i < step ? 'is-past' : i === step ? 'is-now' : ''}" ${i === step ? 'aria-current="step"' : ''}>${i < step ? G.done : '<i aria-hidden="true"></i>'}${s}</li>`).join('');
    const stop = openRun(task) && isDirect(task) ? `<button class="button pj-stop" type="button" data-pj="stop-run" data-id="${esc(task.id)}">${G.stop} Arrêter</button>` : '';
    return `<header class="pj-chat-head"><button type="button" class="icon-button pj-chat-back" data-pj="chat-new" aria-label="Retour aux tâches">${G.back}</button>
        <div class="pj-chat-title"><div><h1>${esc(task.title)}</h1><span class="pj-pill ${tone}"><i></i>${label}</span><span class="pj-code">${esc(task.code)}</span></div><ol class="pj-steps ${tone}" aria-label="Avancement">${steps}</ol></div>
        <div class="pj-panel-actions">${stop}${banner ? '' : closeHTML(task)}<button type="button" class="icon-button" data-pj="task-details" data-id="${esc(task.id)}" aria-label="Détails de la tâche" title="Détails de la tâche">${G.dots}</button></div></header>
      <div class="pj-chat-body"><div class="pj-chat-conv"><div class="pj-chat-thread"><div class="pj-thread" aria-live="polite">${threadHTML(task)}</div></div>
        <div class="pj-chat-composer">${banner}${composerHTML(task, true)}</div></div>${contextHTML(task, p)}</div>`;
  }
  function chatHTML(error) {
    if (st.chat && !st.tasks.some(t => t.id === st.chat)) st.chat = null;
    const task = st.chat && st.tasks.find(t => t.id === st.chat);
    return `<div class="pj-root is-chat ${task ? 'has-task' : ''}">${chatSide()}<main class="pj-chat-main">${error}${task ? chatTask(task) : chatNew()}</main></div>`;
  }
  async function taskDetails(taskId) {
    const task = st.tasks.find(t => t.id === taskId); if (!task) return;
    await loadAgents();
    showModal(task.code + ' · ' + task.title, 'Consignes, pièces jointes, moteur et priorité. Enregistrer ne lance rien.', `<div class="pj-panel-bar"><label>Statut<select data-pj-move="${esc(task.id)}">${COLUMNS.map(c => `<option value="${c.id}" ${task.status === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <span class="pj-help">Changer le statut ne lance ni n’arrête aucun agent.</span></div>
      <form class="pj-form" data-pj-form="edit-task" data-id="${esc(task.id)}">${taskFields(task)}<p class="form-status pj-help" role="status"></p>
        <div class="pj-form-actions"><button class="button primary" type="submit">Enregistrer</button><button class="button pj-danger" type="button" data-pj="delete-task" data-id="${esc(task.id)}">Supprimer</button></div></form>`, 'pj-task-edit', true);
  }

  function html() {
    if (!st.loaded && !st.error) { if (!st.loading) refresh(); return '<div class="pj-root"><p class="pj-loading" role="status">Chargement des projets…</p></div>'; }
    if (st.view === 'chat') return chatHTML(st.error ? `<div class="pj-banner is-bad" role="alert">${G.alert}<span>${esc(st.error)}</span><button class="button" data-pj="reload">Réessayer</button></div>` : '');
    const active = st.tasks.filter(t => matches(t) && t.status !== 'done');
    const attention = st.tasks.filter(t => projectOf(t) && !projectOf(t).archived && needsMe(t) && t.status !== 'done').length;
    const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const visible = visibleProjects();
    const tabs = [['all', 'Tout'], ['me', 'Mes tâches'], ['agents', 'Agents']].map(([id, label]) => `<button data-pj="who" data-id="${id}" aria-pressed="${st.who === id}">${label}</button>`).join('');
    const chips = [{ id: 'all', name: 'Tous les projets' }, ...visible].map(p => `<button class="pj-chip" data-pj="project" data-id="${esc(p.id)}" aria-pressed="${st.project === p.id}">${p.color ? `<i style="background:${esc(p.color)}"></i>` : ''}${esc(p.name)}<span>${st.tasks.filter(t => (p.id === 'all' ? projectOf(t) && !projectOf(t).archived : t.projectId === p.id)).length}</span></button>`).join('');
    const error = st.error ? `<div class="pj-banner is-bad" role="alert">${G.alert}<span>${esc(st.error)}</span><button class="button" data-pj="reload">Réessayer</button></div>` : '';
    const body = st.view === 'grid' ? grid() : !visible.length ? `<div class="pj-empty"><h2>Commencez par un projet</h2><p>Créez un projet (avec son dépôt GitHub), écrivez une tâche puis cliquez sur « Lancer » : Claude Code la traite sur le serveur Cockpit. Rien ne démarre sans ce clic.</p><button class="button primary" data-pj="new-project">${icon('plus')} Créer un projet</button></div>`
      : `<div class="pj-filters"><div class="pj-seg" role="group" aria-label="Assignation">${tabs}</div><div class="pj-chips" role="group" aria-label="Projet">${chips}</div>
        ${attention ? `<button class="pj-chip pj-attn" data-pj="attention" aria-pressed="${st.attention}">${G.alert} À traiter <span>${attention}</span></button>` : ''}</div>${board()}`;
    return `<div class="pj-root" data-scroll="page:projects">
      <header class="pj-head"><div><h1>Projets</h1><p>${esc(date.charAt(0).toUpperCase() + date.slice(1))} · ${active.length} tâche${active.length > 1 ? 's' : ''} · ${active.filter(t => t.status === 'doing').length} en cours${attention ? ` · <b class="pj-attn-text">${attention} en attente de vous</b>` : ''}</p></div>
        <div class="pj-actions"><label class="pj-search">${icon('search')}<span class="sr-only">Rechercher</span><input type="search" id="pj-search" placeholder="Rechercher…" value="${esc(st.search)}" autocomplete="off"></label>
          <button class="pj-round" data-pj="view-set" data-id="chat" aria-label="Afficher les conversations" title="Conversations">${G.chat}</button>
          <button class="pj-round" data-pj="view" aria-label="${st.view === 'grid' ? 'Afficher le tableau' : 'Afficher les projets'}" title="${st.view === 'grid' ? 'Tableau des tâches' : 'Vue des projets'}">${st.view === 'grid' ? G.board : G.cards}</button>
          ${st.view === 'grid' || !visible.length ? `<button class="pj-cta" data-pj="new-project">${icon('plus')} Nouveau projet</button>` : `<button class="pj-round" data-pj="new-project" aria-label="Nouveau projet" title="Nouveau projet">${icon('folder')}</button><button class="pj-cta" data-pj="new-task">${icon('plus')} Nouvelle tâche</button>`}</div></header>
      ${error}${body}</div>`;
  }

  function agentLine(p) {
    const r = p.agentRequest;
    if (p.agent) return `<p class="muted"><b>Agent du projet :</b> ${esc(p.agent.name)}</p>`;
    if (r?.status === 'pending') return `<p class="pj-repo"><span class="pj-ws s-cloning">Agent « ${esc(r.agentId)} » demandé à ${esc(r.via || 'OpenClaw')}…</span><span class="pj-help">Il sera associé au projet dès qu’il apparaît.</span></p>`;
    return `<p class="pj-repo">${r?.status === 'failed' ? `<span class="pj-ws s-failed">Agent non créé</span><span class="pj-help is-bad">${esc(r.error || '')}</span>` : '<span class="pj-help">Aucun agent dédié.</span>'}
      <button class="button" type="button" data-pj="request-agent" data-id="${esc(p.id)}">${icon('plus')} ${r?.status === 'failed' ? 'Redemander l’agent' : 'Créer l’agent OpenClaw'}</button></p>`;
  }
  function workspaceHTML(p) {
    const repo = p.context?.repository, w = p.workspace;
    if (!repo) return '';
    const link = isGithub(repo) ? `<a href="${esc(safeUrl(repo))}" target="_blank" rel="noopener noreferrer">${icon('link')} ${esc(repo.replace('https://github.com/', ''))}</a>` : esc(repo);
    const state = w ? `<span class="pj-ws s-${esc(w.status)}">${WORKSPACE[w.status] || ''}</span>${w.status === 'ready' ? `<code>${esc(w.path)}</code>` : ''}${w.status === 'failed' ? `<span class="pj-help is-bad">${esc(w.error || '')}</span><button class="button" data-pj="retry-clone" data-id="${esc(p.id)}">${icon('refresh')} Réessayer</button>` : ''}` : '';
    const md = p.claudeMd, mdLine = md ? `<span class="pj-ws s-ready">CLAUDE.md ${md.status === 'generated' ? 'généré par Cockpit' : 'déjà présent, laissé tel quel'} · ${md.chars} car.</span>${md.status === 'generated' ? `<button class="button" type="button" data-pj="regen-claude-md" data-id="${esc(p.id)}">${icon('refresh')} Régénérer</button>` : ''}` : '';
    return `<div class="pj-repo">${link}${state}</div>${mdLine ? `<div class="pj-repo">${mdLine}</div>` : ''}`;
  }
  // ----- Déploiement et création d'un projet neuf ---------------------------------------------
  const deployOf = p => ({ url: '', auto: false, branch: 'main', type: '', config: {}, buildCmd: '', testCmd: '', publicDomain: '', publicUpstream: '', ...(p.deployment || {}) });
  const deployActive = p => DEPLOY_ACTIVE.includes(p.deployState?.last?.status);
  const bootstrapBusy = p => ['pending', 'running'].includes(p.bootstrap?.status);
  const TRIGGER = { auto: 'automatique', manual: 'manuel', rollback: 'retour arrière' };
  function bootstrapHTML(p) {
    const b = p.bootstrap; if (!b || b.status === 'done') return '';
    if (b.status === 'failed') return `<div class="pj-repo"><span class="pj-ws s-failed">Création interrompue</span><span class="pj-help is-bad">${esc(b.error || '')}</span><button class="button" type="button" data-pj="retry-bootstrap" data-id="${esc(p.id)}">${icon('refresh')} Réessayer</button></div>`;
    return `<div class="pj-repo"><span class="pj-ws s-cloning">${esc(BOOTSTRAP_STEP[b.step] || BOOTSTRAP_STEP[''])}</span></div>`;
  }
  function deployPill(last) {
    const [label, tone] = DEPLOY_STATUS[last.status] || DEPLOY_STATUS.unknown;
    return `<span class="pj-ws ${tone}">${label}</span>`;
  }
  // Bloc « Déploiement » d'un projet : lien, mode, dernier déploiement et journal court, boutons. Le jeton n'apparaît nulle part ici.
  function deployHTML(p) {
    if (!p.context?.repository && !p.deployment) return '';
    const d = deployOf(p), s = p.deployState || {}, last = s.last, info = st.deployInfo[p.id] || {}, service = st.capabilities.deploy || {};
    const link = d.url ? `<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener noreferrer">${icon('link')} ${esc(d.url.replace(/^https:\/\//, ''))}</a>` : '<span class="muted">Aucune URL de déploiement</span>';
    const busy = deployActive(p) || bootstrapBusy(p);
    const why = bootstrapBusy(p) ? 'La création du projet est en cours.' : info.missing || (service.configured === false ? service.reason : '') || (busy ? 'Un déploiement est en cours.' : '');
    const line = last ? `<div class="pj-repo">${deployPill(last)}<span class="pj-help">Dernier déploiement${last.trigger ? ' (' + TRIGGER[last.trigger] + ')' : ''} · ${fmtTime(last.finishedAt || last.startedAt || last.createdAt)}${last.commit ? ' · ' + esc(String(last.commit).slice(0, 7)) : ''}${last.step && busy ? ' · étape : ' + esc(last.step) : ''}</span></div>${last.message ? `<p class="pj-help">${esc(last.message)}</p>` : ''}${last.log?.length ? `<details class="pj-more" data-key="deploy-log-${esc(p.id)}"><summary>Journal court (${last.log.length} ligne${last.log.length > 1 ? 's' : ''})</summary><pre class="pj-deploy-log">${esc(last.log.join('\n'))}</pre></details>` : ''}`
      : s.registered?.status === 'ok' ? '<p class="pj-help">Enregistré auprès du service de déploiement. Jamais déployé.</p>' : '';
    const reg = s.registered, problem = reg?.status === 'failed' ? `<div class="pj-repo"><span class="pj-ws s-failed">Non enregistré auprès du service</span><span class="pj-help is-bad">${esc(reg.error || '')}</span><button class="button" type="button" data-pj="deploy-register" data-id="${esc(p.id)}">${icon('refresh')} Réenregistrer</button></div>`
      : reg?.status === 'pending' && d.url ? `<p class="pj-help">${esc(reg.error || '')}</p>` : '';
    const poll = s.error ? `<p class="pj-help is-warn">Le service de déploiement ne répond pas : dernier état connu affiché. ${esc(s.error)}</p>` : '';
    const sub = s.subdomain;
    const pub = !d.publicDomain ? '' : sub?.status === 'awaiting_validation'
      ? `<div class="pj-repo"><button class="button primary" type="button" data-pj="deploy-public" data-id="${esc(p.id)}" data-name="${esc(d.publicDomain)}">Valider la mise en ligne publique de ${esc(d.publicDomain)}</button><span class="pj-help">Le service ne publie rien sur Internet sans votre accord.</span></div>`
      : sub?.status === 'published' ? `<div class="pj-repo"><span class="pj-ws s-ready">En ligne publiquement</span><code>${esc(d.publicDomain)}</code></div>`
      : sub?.status === 'failed' ? `<div class="pj-repo"><span class="pj-ws s-failed">Mise en ligne publique échouée</span><span class="pj-help is-bad">${esc(sub.detail || '')}</span></div>`
      : sub?.status === 'approved' ? `<div class="pj-repo"><span class="pj-ws s-cloning">Mise en ligne publique validée, en cours</span><code>${esc(d.publicDomain)}</code></div>`
      : `<p class="pj-help">Nom public ${esc(d.publicDomain)} : demande de validation pas encore enregistrée.</p>`;
    return `<div class="pj-deploy" data-pj-deploy="${esc(p.id)}"><div class="pj-repo"><b>Déploiement</b><span class="pj-ws ${d.auto ? 's-ready' : ''}">${d.auto ? 'Automatique' : 'Manuel'}</span>${link}</div>
      ${d.auto ? `<p class="pj-help">Le service déploie tout seul dès qu’un nouveau commit arrive sur la branche « ${esc(d.branch)} » de GitHub (vérification chaque minute).</p>` : ''}${line}${problem}${poll}${pub}
      <div class="pj-repo"><button class="button ${d.auto ? '' : 'primary'}" type="button" data-pj="deploy" data-id="${esc(p.id)}" ${why ? 'disabled' : ''} title="${esc(why || (d.auto ? 'Redéployer maintenant, sans attendre le service' : 'Déployer maintenant'))}">${G.launch} ${d.auto ? 'Redéployer' : 'Déployer'}</button>
        ${s.registered?.status === 'ok' ? `<button class="button" type="button" data-pj="deploy-refresh" data-id="${esc(p.id)}">${icon('refresh')} Actualiser</button>` : ''}
        ${why ? `<span class="pj-help ${info.missing ? 'is-warn' : ''}">${esc(why)}</span>` : ''}</div></div>`;
  }
  // Ligne courte pour la vue en cartes des projets.
  function deploySummary(p) {
    const d = deployOf(p), last = p.deployState?.last; if (!d.url && !last) return '';
    return `<div class="pj-repo">${last ? deployPill(last) : '<span class="pj-ws">Pas déployé</span>'}${d.url ? `<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener noreferrer">${icon('link')} ${esc(d.url.replace(/^https:\/\//, ''))}</a>` : ''}</div>`;
  }
  function deployFields(p) {
    const d = deployOf(p);
    return `<details class="pj-more" data-key="deploy-fields" ${d.url || !p.id ? 'open' : ''}><summary>Déploiement <span class="muted">· ${d.url ? esc(d.url.replace(/^https:\/\//, '')) : 'non configuré'}</span></summary><div class="pj-form">
      <p class="pj-help">Cockpit centralise le déploiement dans Deployer. Vous ne renseignez plus les détails techniques ici.</p>
      <label>URL de déploiement<input type="url" name="deployUrl" maxlength="300" value="${esc(d.url)}" placeholder="https://mon-site.ggz.ovh" autocomplete="off"></label>
      <label class="pj-check"><input type="checkbox" name="deployAuto" ${d.auto ? 'checked' : ''}> Déploiement automatique</label>
      <p class="pj-help">Sans cette case, utilisez le bouton « Déployer ». Avec elle, Deployer publie chaque nouveau commit de la branche de production.</p>
      <label>Branche de production<input name="deployBranch" maxlength="100" value="${esc(d.branch || 'main')}"></label>
    </div></details>`;
  }
  function newRepoFields() {
    return `<fieldset class="pj-repomode"><legend>Dépôt GitHub</legend>
      <label class="pj-check"><input type="radio" name="repoMode" value="existing" checked> À partir d’un dépôt existant (copie locale automatique)</label>
      <label class="pj-check"><input type="radio" name="repoMode" value="new"> Projet neuf : créer le dépôt GitHub, le squelette et le premier envoi</label>
      <div data-pj-newrepo hidden class="pj-form"><div class="pj-three"><label>Nom du dépôt<input name="newRepoName" maxlength="100" placeholder="Automatique, d’après le nom du projet"></label><label>Compte GitHub<input name="newRepoOwner" maxlength="39" placeholder="Compte GitHub connecté"></label>
        <label class="pj-check"><input type="checkbox" name="newRepoPublic"> Dépôt public</label></div>
        <p class="pj-help" data-pj-ghstatus>Vérification de GitHub…</p></div></fieldset>`;
  }
  async function loadDeployConfig() {
    if (st.deployConfig && Date.now() - st.deployConfig.at < 30000) return st.deployConfig;
    try { st.deployConfig = { ...(await api('deploy-config')), at: Date.now() }; } catch (e) { st.deployConfig = { error: e.message, at: Date.now() }; }
    return st.deployConfig;
  }
  function showGithubStatus() {
    loadDeployConfig().then(cfg => {
      const el = modal.querySelector('[data-pj-ghstatus]'); if (!el) return;
      const g = cfg.github;
      el.className = 'pj-help ' + (g?.available ? '' : 'is-warn');
      el.textContent = cfg.error ? cfg.error : g?.available ? `GitHub est prêt${g.account ? ' (compte ' + g.account + ')' : ''}. Le dépôt est créé privé, sauf si vous cochez « Dépôt public ».`
        : (g?.reason || 'GitHub n’est pas utilisable.') + ' Le projet sera créé quand même ; la création du dépôt se relancera avec « Réessayer ».';
    });
  }
  const setProject = saved => {
    const project = saved.project || saved, i = st.projects.findIndex(x => x.id === project.id);
    if (i >= 0) st.projects[i] = project; else st.projects.push(project);
    render();
    const box = modal.open && modal.querySelector(`[data-pj-deploy="${CSS.escape(project.id)}"]`); if (box) box.outerHTML = deployHTML(project);
    return project;
  };
  async function refreshDeploys() {
    // Déploiements en cours : relus auprès du service à chaque passage ; les autres une fois à l'ouverture de l'onglet.
    for (const p of st.projects) {
      if (p.archived || p.deployState?.registered?.status !== 'ok' || !(deployActive(p) || !st.deployChecked.has(p.id))) continue;
      st.deployChecked.add(p.id);
      try { setProject(await api('projects/' + p.id + '/deploy')); } catch { /* le dernier état connu reste affiché */ }
    }
  }

  function attachmentsHTML(task) {
    const list = task.attachments || [];
    return list.length ? `<ul class="pj-atts">${list.map(a => `<li><button type="button" class="pj-att" data-pj="open-attachment" data-id="${esc(task.id)}" data-att="${esc(a.id)}" data-name="${esc(a.name)}">${G.clip}<span>${esc(a.name)}</span><small>${fmtSize(a.size)}${a.by ? ' · ' + esc(a.by) : ''}</small></button>
      <button type="button" class="icon-button" data-pj="delete-attachment" data-id="${esc(task.id)}" data-att="${esc(a.id)}" aria-label="Retirer ${esc(a.name)}">${G.trash}</button></li>`).join('')}</ul>` : '';
  }
  const filesOf = form => form.dataset.pjForm === 'new-chat' ? st.newFiles : (pending.get(form) || []);
  function pendingHTML(list) {
    return list.map((f, i) => `<li><span class="pj-att is-new">${G.clip}<span>${esc(f.name)}</span><small>${fmtSize(f.size)} · à envoyer</small></span><button type="button" class="icon-button" data-pj="drop-file" data-id="${i}" aria-label="Ne pas joindre ${esc(f.name)}">${G.trash}</button></li>`).join('');
  }
  function addFiles(form, files) {
    const list = filesOf(form);
    for (const file of files) {
      if (file.size > MAX_FILE) { toast(file.name + ' dépasse 10 Mo.'); continue; }
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!ACCEPT.split(',').includes('.' + ext)) { toast(file.name + ' : type refusé (captures, PDF, zip, textes).'); continue; }
      list.push(file);
    }
    if (form.dataset.pjForm === 'new-chat') return render();
    pending.set(form, list);
    const box = form.querySelector('.pj-pending'); if (box) box.innerHTML = pendingHTML(list);
  }
  async function uploadPending(form, taskId) {
    const list = filesOf(form); let task = null;
    while (list.length) {
      const file = list[0];
      const response = await sources.feedmeFetch('/api/projects/tasks/' + taskId + '/attachments?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, signal: timeoutSignal(180000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(file.name + ' : ' + (data.error || 'envoi impossible.'));
      task = data.task; list.shift();
      const box = form.querySelector('.pj-pending'); if (box) box.innerHTML = pendingHTML(list);
    }
    return task;
  }
  async function openAttachment(taskId, attId, name) {
    const response = await sources.feedmeFetch('/api/projects/tasks/' + taskId + '/attachments/' + attId, { signal: timeoutSignal(120000) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Pièce jointe indisponible.'); }
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function refreshAttachments(task) {
    const box = modal.querySelector(`[data-pj-atts="${CSS.escape(task.id)}"]`); if (box) box.innerHTML = attachmentsHTML(task);
  }

  // ----- Formulaires --------------------------------------------------------------------
  function agentOptions(selected) {
    const list = st.agents || [];
    const key = a => a.connectionId + '|' + a.agentId;
    const known = selected && !list.some(a => key(a) === key(selected));
    return `<option value="">Aucun : tâche manuelle</option>${list.filter(a => a.agentId).map(a => `<option value="${esc(key(a))}" data-name="${esc(a.name)}" ${selected && key(a) === key(selected) ? 'selected' : ''}>${esc(a.name)}${a.available ? '' : ' · indisponible'}${list.some(b => b !== a && b.connectionId !== a.connectionId) ? ' (' + esc(a.connectionName) + ')' : ''}</option>`).join('')}
      ${known ? `<option value="${esc(key(selected))}" data-name="${esc(selected.name)}" selected>${esc(selected.name)} · introuvable</option>` : ''}`;
  }
  const agentHelp = () => st.agentsError ? `<p class="pj-help is-bad">${esc(st.agentsError)}</p>` : !(st.agents || []).some(a => a.agentId) ? '<p class="pj-help">Aucun agent OpenClaw trouvé. Les connexions se règlent dans les réglages des agents Cockpit.</p>' : '';
  const prioritySelect = value => `<select name="priority">${Object.entries(PRIORITY).map(([v, [label]]) => `<option value="${v}" ${Number(value) === Number(v) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  function taskFields(task = {}, { withProject = false } = {}) {
    return `${withProject ? `<label>Projet<select name="projectId" required>${visibleProjects().map(p => `<option value="${esc(p.id)}" ${p.id === (task.projectId || (st.project !== 'all' ? st.project : '')) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      <label>Titre<input name="title" maxlength="200" required value="${esc(task.title || '')}"></label>
      <label>Description de la tâche<textarea name="instructions" rows="5" maxlength="20000" placeholder="Ce qu’il faut faire. Le contexte du projet et son dépôt sont joints automatiquement.">${esc(task.instructions || '')}</textarea></label>
      <label>Résultat attendu<textarea name="expected" rows="2" maxlength="4000" placeholder="Une PR, un rapport, un fichier…">${esc(task.expected || '')}</textarea></label>
      <div class="pj-files"><span class="pj-files-head">${G.clip} Pièces jointes <small>captures (collez-les avec Ctrl+V), PDF, zip, textes · 10 Mo max</small></span>
        <div data-pj-atts="${esc(task.id || '')}">${task.id ? attachmentsHTML(task) : ''}</div><ul class="pj-atts pj-pending"></ul>
        <label class="button pj-pick">${icon('plus')} Ajouter des fichiers<input type="file" name="files" multiple accept="${ACCEPT}" class="sr-only"></label></div>
      <label>Adresses utiles (une par ligne, « libellé | adresse » possible)<textarea name="links" rows="2" placeholder="https://…">${esc(linksText(task.links))}</textarea></label>
      <details class="pj-more"><summary>Plus d’options <span class="muted">· ${esc(task.id && isDirect(task) ? ENGINE[engineOf(task)] : task.agent ? 'agent : ' + task.agent.name : 'moteur du projet')}</span></summary><div class="pj-form">
        <div class="pj-three"><label>Moteur<select name="engine"><option value="">Celui du projet</option>${Object.entries(ENGINE).map(([v, l]) => `<option value="${v}" ${task.engine === v ? 'selected' : ''}${st.capabilities.engines?.[v] === false ? ' disabled' : ''}>${l}${st.capabilities.engines?.[v] === false ? ' (indisponible sur ce serveur)' : ''}</option>`).join('')}</select></label>
          <label>Modèle<input name="model" maxlength="80" value="${esc(task.model || '')}" placeholder="Celui du projet"></label>
          <label class="pj-check"><input type="checkbox" name="planFirst" ${task.planFirst ? 'checked' : ''}> Plan d’abord (lecture seule)</label></div>
        <p class="pj-help">Claude Code et Codex travaillent sur le serveur Cockpit, dans un dossier à part pour cette tâche. Le plan préalable est facultatif : sans lui, le travail démarre tout de suite.</p>
        <div class="pj-three">${st.capabilities.engines?.openclaw !== false ? `<label>Agent OpenClaw<select name="agent">${agentOptions(task.agent)}</select></label>` : ''}<label>Priorité${prioritySelect(task.priority || 0)}</label><label>Échéance<input type="date" name="due" value="${esc(task.due || '')}"></label></div>
        ${st.capabilities.engines?.openclaw !== false ? agentHelp() : ''}
        <label>Critères de réussite<textarea name="criteria" rows="2" maxlength="4000" placeholder="Comment vérifier que c’est réussi">${esc(task.criteria || '')}</textarea></label>
        <label>Ressources de la tâche<textarea name="resources" rows="2" maxlength="12000" placeholder="Chemins, extraits utiles…">${esc(task.resources || '')}</textarea></label>
        ${st.capabilities.engines?.openclaw !== false ? `<label class="pj-check"><input type="checkbox" name="includeContext" ${task.includeContext === false ? '' : 'checked'}> Transmettre le contexte du projet à l’agent OpenClaw (Claude Code et Codex le lisent dans CLAUDE.md)</label>` : ''}</div></details>`;
  }
  function readTask(form) {
    const fd = new FormData(form), value = String(fd.get('agent') || '');
    const option = form.elements.agent?.selectedOptions?.[0];
    const [connectionId, agentId] = value.split('|');
    return { title: fd.get('title'), instructions: fd.get('instructions'), expected: fd.get('expected'), criteria: fd.get('criteria'), resources: fd.get('resources'), links: parseLinks(fd.get('links')),
      priority: Number(fd.get('priority')), due: fd.get('due') || '', includeContext: fd.has('includeContext'), engine: fd.get('engine') || '', model: String(fd.get('model') || '').trim(), planFirst: fd.has('planFirst'), agent: value ? { connectionId, agentId, name: option?.dataset.name || agentId } : null,
      ...(fd.has('projectId') ? { projectId: fd.get('projectId') } : {}) };
  }
  async function projectForm(p = {}) {
    await loadAgents();
    if (!p.id) showGithubStatus();
    const c = p.context || {};
    showModal(p.id ? 'Modifier le projet' : 'Nouveau projet', 'Le contexte est transmis aux agents lorsqu’une tâche le demande. Les secrets n’ont rien à faire ici.', `<form class="pj-form" data-pj-form="project" data-id="${esc(p.id || '')}">
      <label>Nom<input name="name" required maxlength="120" value="${esc(p.name || '')}"></label>
      <label>Courte description<input name="description" maxlength="600" value="${esc(p.description || '')}"></label>
      <label>Statut<select name="status">${Object.entries(PROJECT_STATUS).map(([v, l]) => `<option value="${v}" ${(p.status || 'prep') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <fieldset class="pj-colors"><legend>Couleur</legend>${PALETTE.map((col, i) => `<label><input type="radio" name="color" value="${col}" ${(p.color || PALETTE[st.projects.length % PALETTE.length]) === col ? 'checked' : ''}><span style="background:${col}" aria-label="Couleur ${i + 1}"></span></label>`).join('')}</fieldset>
      <h3>Contexte pour les agents</h3>
      <label>Instructions générales<textarea name="instructions" rows="4" maxlength="12000" placeholder="Conventions, ton, outils à utiliser ou à éviter…">${esc(c.instructions || '')}</textarea></label>
      <label>Liens (un par ligne, « libellé | adresse » possible)<textarea name="links" rows="3">${esc(linksText(c.links))}</textarea></label>
      ${p.id ? '' : newRepoFields()}
      <div class="pj-two"><label>Dépôt GitHub<input name="repository" maxlength="600" value="${esc(c.repository || '')}" placeholder="https://github.com/compte/depot"></label>${st.capabilities.engines?.openclaw !== false ? `<label>Agent du projet<select name="agent">${agentOptions(p.agent)}</select></label>` : ''}</div>
      <p class="pj-help">Une adresse GitHub est clonée dans l’espace de travail du serveur Cockpit : Claude Code peut y travailler tout de suite. Un dossier existant n’est jamais écrasé.</p>
      ${p.id ? (st.capabilities.engines?.openclaw !== false ? agentLine(p) : '') + workspaceHTML(p) + bootstrapHTML(p) : ''}
      <div class="pj-three"><label>Moteur des tâches<select name="engine">${Object.entries(ENGINE).map(([v, l]) => `<option value="${v}" ${(p.engine || 'claude') === v ? 'selected' : ''}${st.capabilities.engines?.[v] === false ? ' disabled' : ''}>${l}${st.capabilities.engines?.[v] === false ? ' (indisponible sur ce serveur)' : ''}${v === 'claude' ? ' · recommandé' : ''}</option>`).join('')}</select></label>
        <label>Modèle Claude Code<select name="model">${[['claude-sonnet-5-5','Sonnet 5.5 · recommandé'],['claude-opus-5-5','Opus 5.5'],['claude-haiku-5-5','Haiku 5.5']].map(([v,l]) => `<option value="${v}" ${(p.direct?.model || st.capabilities.directDefaults?.model || 'claude-sonnet-5-5') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Secours automatique<select name="fallback"><option value="">Aucun</option>${['claude', 'codex'].map(v => `<option value="${v}" ${p.direct?.fallback === v ? 'selected' : ''}>${ENGINE[v]}</option>`).join('')}</select></label></div>
      <p class="pj-help">Claude Code (ou Codex) reçoit chaque tâche directement, dans une seule session reprise à chaque message. ${st.capabilities.engines?.openclaw === false ? 'Le moteur OpenClaw desktop est désactivé dans ce mode serveur.' : 'OpenClaw reste possible : il garde son agent et sa conversation.'} Le secours ne se déclenche que si le moteur échoue avant d’avoir touché au dossier.</p>
      ${deployFields(p)}${p.id ? deployHTML(p) : ''}
      <p class="form-status pj-help" role="status"></p>
      <div class="pj-form-actions"><button class="button primary" type="submit">${p.id ? 'Enregistrer' : 'Créer le projet'}</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`, 'pj-project', true);
  }
  async function taskForm() {
    await loadAgents();
    const project = st.projects.find(p => p.id === st.project) || visibleProjects()[0];
    showModal('Nouvelle tâche', 'Créer ou assigner une tâche ne lance rien : l’agent démarre uniquement avec le bouton « Lancer ».', `<form class="pj-form" data-pj-form="task">${taskFields({ projectId: project?.id, agent: project?.agent || null }, { withProject: true })}
      <p class="form-status pj-help" role="status"></p><div class="pj-form-actions"><button class="button primary" type="submit">Créer la tâche</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`, 'pj-task-new', true);
  }

  // ----- Panneau de tâche : une conversation avec l'agent -----------------------------------
  function eventsHTML(run) {
    return `<ol class="pj-events">${run.events.map(e => `<li class="ev-${esc(e.type)}"><time>${fmtTime(e.at)}</time><span>${esc(e.text)}</span></li>`).join('')}</ol>`;
  }
  const initial = name => esc(String(name || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || 'A');
  function messageHTML(item, task) {
    const time = item.at ? `<time>${fmtTime(item.at)}</time>` : '';
    if (item.role === 'system') return `<p class="pj-sys"><span>${esc(item.text)}</span>${time}</p>`;
    if (item.role === 'user') {
      const label = { brief: 'Consignes', answer: 'Vous · réponse à sa question', retry: 'Vous · précisions pour la relance', execute: 'Vous · exécution du plan' }[item.type] || 'Vous';
      const files = item.attachments?.length ? `<div class="pj-msg-files">${item.attachments.map(a => `<button type="button" class="pj-att" data-pj="open-attachment" data-id="${esc(task.id)}" data-att="${esc(a.id)}" data-name="${esc(a.name)}">${G.clip}<span>${esc(a.name)}</span><small>${fmtSize(a.size)}</small></button>`).join('')}</div>` : '';
      return `<div class="pj-msg is-user"><div class="pj-msg-meta"><span>${label}</span>${time}</div>
        <div class="pj-bubble">${item.text ? richText(item.text) : '<p class="pj-help">Pas encore de consignes : écrivez-les ci-dessous.</p>'}${files}</div></div>`;
    }
    const run = item.run, name = run.agent?.name || assignee(task)?.name || 'Agent';
    const head = extra => `<div class="pj-msg-meta"><span class="pj-av" aria-hidden="true">${initial(name)}</span><b>${esc(name)}</b>${extra}</div>`;
    const more = `<details class="pj-msg-more" data-key="run-${esc(run.id)}"><summary>Détails de l’exécution · ${RUN_KIND[run.kind] || ''}</summary>${eventsHTML(run)}${runFacts(run, task)}
      <details class="pj-prompt" data-key="prompt-${esc(run.id)}"><summary>Consignes envoyées</summary><div class="pj-result">${esc(run.prompt || '')}</div></details></details>`;
    if (item.type === 'live') {
      return `<div class="pj-msg is-agent is-live">${head(`<span class="pj-msg-tag">${RUN_STATUS[run.status]}</span>`)}
        <div class="pj-bubble">${item.text ? `<div class="pj-draft" title="Réponse en cours de rédaction (non définitive)">${richText(item.text)}</div>` : ''}
          <p class="pj-typing" role="status"><span class="pj-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(run.events.at(-1)?.text || RUN_STATUS[run.status])}</p>
          ${run.tracking === 'recovering' ? `<p class="pj-help">Suivi direct indisponible : l’état est relu dans l’historique OpenClaw${run.trackingError ? ' (' + esc(run.trackingError) + ')' : ''}. Rien n’est renvoyé à l’agent.</p>` : ''}
          ${task.updatedAt && task.updatedAt > run.createdAt ? '<p class="pj-help is-warn">La tâche a été modifiée après ce lancement : l’agent travaille sur la version envoyée. Les modifications serviront au prochain message.</p>' : ''}</div>${more}</div>`;
    }
    const tone = { question: 'is-ask', error: 'is-bad', result: 'is-ok', plan: 'is-ok' }[item.type];
    const tag = item.type === 'question' ? 'attend votre réponse' : item.type === 'plan' ? 'plan, rien n’a été modifié' : item.type === 'error' ? (run.status === 'failed' ? 'Échec' : 'Interrompue') : '';
    return `<div class="pj-msg is-agent ${tone}">${head(`${tag ? `<span class="pj-msg-tag">${tag}</span>` : ''}${time}`)}
      <div class="pj-bubble">${item.text ? richText(item.text) : `<p class="pj-help">${item.type === 'error' ? 'Aucune explication.' : 'Réponse vide.'}</p>`}${runSummary(run)}</div>${more}</div>`;
  }
  // Moteurs directs : ce que Cockpit a relevé dans le dossier de la tâche (aucun jeton), en une ligne sous la réponse.
  function runSummary(run) {
    const s = run.summary; if (!s || run.mode === 'plan') return '';
    const n = (count, one, many) => count + ' ' + (count > 1 ? many : one);
    return `<p class="pj-help pj-run-summary">Branche <code>${esc(s.branch)}</code> · ${n(s.files.length, 'fichier modifié', 'fichiers modifiés')} · ${n(s.commits.length, 'commit', 'commits')}${s.uncommitted.length ? ' · <b>' + n(s.uncommitted.length, 'changement non commité', 'changements non commités') + '</b>' : ''}</p>`;
  }
  const fmtTokens = n => n >= 1000 ? Math.round(n / 100) / 10 + ' k' : String(n);
  function runFacts(run, task) {
    if (!run.engine) return '';
    const m = run.metrics, d = task.direct || {};
    const used = m ? [m.model, m.totalTokens != null ? fmtTokens(m.totalTokens) + ' jetons' : '', m.calls ? m.calls + ' appels' : '', run.durationMs ? Math.round(run.durationMs / 1000) + ' s' : ''].filter(Boolean).join(' · ') : '';
    const resume = d.engine === 'claude' && d.sessionId && d.cwd ? `<p class="pj-help">Reprendre à la main : dans <code>${esc(d.cwd)}</code>, lancer <code>claude --resume ${esc(d.sessionId)}</code></p>` : '';
    return `${used ? `<p class="pj-help">${esc(used)}</p>` : ''}${resume}`;
  }
  const threadHTML = task => chatItems(task).map(item => messageHTML(item, task)).join('');
  // inline : zone de saisie de la vue « conversations » (Clore et Arrêter sont dans l'en-tête, le brouillon survit aux rafraîchissements).
  function composerHTML(task, inline = false) {
    const direct = isDirect(task), m = composerMode(task, { busy: st.launching.has(task.id), direct }), agent = esc(assignee(task)?.name || 'l’agent');
    // « Clore la tâche » reste sous la zone de saisie : visible quelle que soit la longueur du fil.
    const foot = (left = '') => `<div class="pj-chatbox-foot">${left}<span class="pj-grow"></span>${inline ? '' : `<div class="pj-panel-actions">${closeHTML(task)}</div>`}</div>`;
    if (m.mode === 'manual') return foot('<p class="pj-help">Tâche manuelle : aucun agent ne répond ici. Choisissez un agent dans « Détails de la tâche » pour lui confier le travail.</p>');
    const busy = m.mode === 'busy';
    if (!busy && m.kind === 'initial' && !m.needsText) return `<form class="pj-chatbox is-launch" data-pj-form="chat" data-id="${esc(task.id)}" data-kind="initial">
      <p class="pj-help">${direct ? `${agent} reçoit les consignes de la tâche${task.planFirst ? ' et commence par un plan en lecture seule' : ''} ; les consignes du projet sont dans le CLAUDE.md du dossier.` : `${agent} recevra les consignes, les critères et ${task.includeContext === false ? 'aucun contexte de projet' : 'le contexte du projet'}.`} Rien ne démarre sans ce clic.</p>
      <button class="button primary pj-send" type="submit">${G.launch} Lancer</button></form>${foot()}`;
    return `<form class="pj-chatbox" data-pj-form="chat" data-id="${esc(task.id)}" data-kind="${esc(m.kind || '')}" ${m.setsInstructions ? 'data-sets="1"' : ''}>
      <label class="sr-only" for="pj-chat-input">Message à ${agent}</label>
      <textarea id="pj-chat-input" name="note" rows="${inline ? 1 : 2}" maxlength="8000" data-keep="chat" ${inline ? `data-pj-draft="${esc(task.id)}"` : ''} placeholder="${busy ? `${agent} travaille : vous pourrez envoyer dès sa réponse…` : esc(m.placeholder)}" ${m.needsText ? 'required' : ''}>${inline ? esc(st.drafts[task.id] || '') : ''}</textarea>
      <button class="button primary pj-send" type="submit" ${busy ? 'disabled' : ''}>${inline ? G.up : G.launch} ${busy ? (st.launching.has(task.id) ? 'Envoi…' : 'En cours') : m.label}</button>
      ${m.alt ? `<button class="button pj-send" type="submit" name="alt" value="${esc(m.alt.kind)}">${m.alt.label}</button>` : ''}</form>
      ${foot(`${m.quick ? `<button class="pj-chip" type="button" data-pj="quick-continue" data-id="${esc(task.id)}">${G.launch} Oui, continue</button>` : ''}
        ${busy && direct && openRun(task) && !inline ? `<button class="button" type="button" data-pj="stop-run" data-id="${esc(task.id)}">Arrêter</button>` : ''}<span class="pj-help">${busy ? (direct ? `${agent} travaille : la session et le dossier sont conservés si vous l’arrêtez.` : esc(st.capabilities.interruptReason || 'L’arrêt n’est pas disponible avec cette connexion.')) : `Ctrl+Entrée pour envoyer · ${agent} garde le fil de la tâche${task.status === 'done' ? ' · la tâche sera rouverte' : ''}`}</span>`)}`;
  }
  function closeHTML(task) {
    if (task.status === 'done') return `<span class="pj-closed">${icon('check')} Tâche close</span><button class="button" data-pj="reopen" data-id="${esc(task.id)}">Rouvrir</button>`;
    const run = lastRun(task), pendingResult = run?.status === 'succeeded' && run.outcome === 'result' && !run.accepted;
    return `<button class="button pj-close" data-pj="close-task" data-id="${esc(task.id)}" ${canClose(task) ? '' : 'disabled'}
      title="${!canClose(task) ? 'Attendez la réponse de l’agent' : pendingResult ? 'Accepter le résultat de l’agent et passer la tâche en Terminé' : 'Passer la tâche en Terminé'}">${icon('check')} Clore la tâche</button>`;
  }
  async function openPanel(taskId) {
    const task = st.tasks.find(t => t.id === taskId); if (!task) return;
    st.panel = taskId; loadAgents().then(() => { const sel = modal.querySelector('[data-pj-panel] select[name=agent]'); if (sel && !sel.matches(':focus')) sel.innerHTML = agentOptions(st.tasks.find(t => t.id === taskId)?.agent); });
    const p = projectOf(task), parts = { thread: threadHTML(task), composer: composerHTML(task) };
    showModal(task.code + ' · ' + task.title, (p?.name || '') + ' · ' + (COLUMNS.find(c => c.id === task.status)?.label || '') + (task.createdBy ? ' · créée par ' + task.createdBy : ''),`<div class="pj-panel" data-pj-panel="${esc(task.id)}">
      <div class="pj-panel-bar"><label>Colonne<select data-pj-move="${esc(task.id)}">${COLUMNS.map(c => `<option value="${c.id}" ${task.status === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <span class="pj-help">Déplacer la carte ne lance ni n’arrête aucun agent.</span></div>
      <details class="pj-details" ${task.agent ? '' : 'open'}><summary>Détails de la tâche <span class="muted">· consignes, pièces jointes, agent, priorité</span></summary>
        <form class="pj-form" data-pj-form="edit-task" data-id="${esc(task.id)}">${taskFields(task)}
        <div class="pj-form-actions"><button class="button primary" type="submit">Enregistrer</button><button class="button pj-danger" type="button" data-pj="delete-task" data-id="${esc(task.id)}">Supprimer</button></div></form></details>
      <div class="pj-thread" data-pj-part="thread" aria-live="polite">${parts.thread}</div>
      <div class="pj-composer" data-pj-part="composer">${parts.composer}</div></div>`, 'pj-task', true);
    modal.classList.add('pj-drawer');
    for (const [name, html] of Object.entries(parts)) { const el = modal.querySelector(`[data-pj-part="${name}"]`); if (el) el.dataset.html = html; }
    requestAnimationFrame(() => { modal.scrollTop = modal.scrollHeight; });
    schedule();
  }
  // Remplace une partie du panneau sans perdre la saisie en cours, le focus ni les détails ouverts.
  function patch(el, next) {
    if (!el || el.dataset.html === next) return false;
    const kept = {}; el.querySelectorAll('[data-keep]').forEach(x => { kept[x.dataset.keep] = x.value; });
    const open = new Set([...el.querySelectorAll('details[open]')].map(d => d.dataset.key || ''));
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset?.keep : undefined;
    el.innerHTML = next; el.dataset.html = next;
    el.querySelectorAll('[data-keep]').forEach(x => { if (kept[x.dataset.keep]) x.value = kept[x.dataset.keep]; if (focused && focused === x.dataset.keep) x.focus(); });
    el.querySelectorAll('details').forEach(d => { if (open.has(d.dataset.key || '')) d.open = true; });
    return true;
  }
  function updatePanel() {
    const panel = modal.open && modal.querySelector('[data-pj-panel]'); if (!panel) return;
    const task = st.tasks.find(t => t.id === panel.dataset.pjPanel); if (!task) return;
    const part = name => panel.querySelector(`[data-pj-part="${name}"]`);
    const nearEnd = modal.scrollHeight - modal.scrollTop - modal.clientHeight < 160;
    const grew = patch(part('thread'), threadHTML(task));
    patch(part('composer'), composerHTML(task));
    if (grew && nearEnd) modal.scrollTop = modal.scrollHeight;
    const select = panel.querySelector('[data-pj-move]'); if (select && document.activeElement !== select) select.value = task.status;
    const subtitle = modal.querySelector('.dialog-heading p'); if (subtitle) subtitle.textContent = (projectOf(task)?.name || '') + ' · ' + (COLUMNS.find(c => c.id === task.status)?.label || '');
  }

  // ----- Actions ------------------------------------------------------------------------
  async function launch(taskId, kind, note, button) {
    if (st.launching.has(taskId)) return; // un double clic ne crée qu'un lancement
    const task = st.tasks.find(t => t.id === taskId); if (!task) return;
    const key = uid(); st.launching.add(taskId); if (button) button.disabled = true; updatePanel();
    let sent = false;
    try {
      // La même clé est renvoyée en cas de nouvelle tentative réseau : le serveur ne crée pas de doublon.
      let result, attempt = 0;
      for (;;) {
        try { result = await api('tasks/' + taskId + '/launch', 'POST', { launchKey: key, kind, note }); break; }
        catch (e) { if (!/fetch|network|réseau|timeout|abort/i.test(e.message) || ++attempt > 1) throw e; }
      }
      upsert(result.task); sent = true; toast(result.repeated ? 'Ce lancement était déjà enregistré.' : 'Message transmis. La tâche passera en cours dès que l’agent confirme son démarrage.');
    } catch (e) { toast(e.message); }
    finally { st.launching.delete(taskId); render(); updatePanel(); refresh(); }
    return sent;
  }
  async function move(taskId, status) {
    const task = st.tasks.find(t => t.id === taskId); if (!task || task.status === status) return;
    const previous = task.status; task.status = status; render(); updatePanel();
    try { upsert(await api('tasks/' + taskId, 'PATCH', { status })); if (openRun(task)) toast('Carte déplacée. L’agent continue son exécution : son résultat replacera la tâche.'); }
    catch (e) { task.status = previous; toast(e.message); }
    render(); updatePanel();
  }

  document.addEventListener('click', async event => {
    const el = event.target.closest('[data-pj]'); if (!el || el.disabled) return;
    event.preventDefault();
    const idv = el.dataset.id;
    try {
      switch (el.dataset.pj) {
        case 'who': st.who = idv; render(); break;
        case 'project': st.project = idv; write('mb.projects.filter', idv); st.quickAdd = null; render(); break;
        case 'attention': st.attention = !st.attention; render(); break;
        case 'view': st.view = st.view === 'grid' ? 'board' : 'grid'; write('mb.projects.mode', st.view); render(); break;
        case 'view-set': st.view = VIEWS.includes(idv) ? idv : 'chat'; write('mb.projects.mode', st.view); renderChat(true); break;
        case 'chat-new': st.chat = null; render(); globalThis.requestAnimationFrame?.(() => document.querySelector('#pj-new-input')?.focus()); break;
        case 'all-done': st.allDone = true; render(); break;
        case 'task-details': await taskDetails(idv); break;
        case 'project-status': st.projectStatus = idv; render(); break;
        case 'toggle-archived': st.archived = !st.archived; render(); break;
        case 'reload': st.error = ''; await refresh(false); break;
        case 'open-project': st.project = idv; st.view = 'board'; write('mb.projects.filter', idv); write('mb.projects.mode', 'board'); render(); break;
        case 'new-project': await projectForm(); break;
        case 'edit-project': await projectForm(st.projects.find(p => p.id === idv)); break;
        case 'archive-project': { const p = st.projects.find(p => p.id === idv); if (!p) break; const saved = await api('projects/' + p.id, 'PATCH', { archived: !p.archived }); Object.assign(p, saved); if (st.project === p.id) st.project = 'all'; toast(saved.archived ? 'Projet archivé. Retrouvez-le avec le filtre « Archivés ».' : 'Projet restauré.'); render(); break; }
        case 'new-task': await taskForm(); break;
        case 'quick-add': st.quickAdd = idv; render(); requestAnimationFrame(() => document.querySelector('#pj-quick-title')?.focus()); break;
        case 'quick-cancel': st.quickAdd = null; render(); break;
        case 'open-task': if (st.view === 'chat') { st.chat = idv; renderChat(true); } else await openPanel(idv); break;
        // Clore : accepte le résultat en attente s'il y en a un, puis passe la tâche en Terminé.
        // Une tâche avec une branche de travail est fusionnée dans la branche de production et poussée sur GitHub par Cockpit (sans agent).
        case 'close-task': {
          const t = st.tasks.find(x => x.id === idv), p = t && st.projects.find(x => x.id === t.projectId), dp = p ? deployOf(p) : { branch: 'main' };
          if (t?.direct?.branch && !confirm(`Clore « ${t.title} » ?\n\nSon travail (branche ${t.direct.branch}) sera fusionné dans ${dp.branch} et envoyé sur GitHub.${dp.auto ? `\nLe déploiement automatique publiera ensuite ${dp.url}.` : ''}`)) break;
          const before = t?.published?.commit; el.disabled = true;
          const saved = await api('tasks/' + idv + '/accept', 'POST', {}); upsert(saved);
          const pushed = saved.published?.commit && saved.published.commit !== before;
          toast(pushed ? `Tâche close et envoyée sur GitHub (${saved.published.branch} · ${saved.published.commit.slice(0, 7)}).${dp.auto ? ' Déploiement automatique d’ici une minute.' : dp.url ? ' Utilisez « Déployer » pour publier.' : ''}` : 'Tâche close.');
          render(); updatePanel(); break;
        }
        case 'reopen': await move(idv, 'todo'); break;
        case 'stop-run': { el.disabled = true; upsert(await api('tasks/' + idv + '/stop', 'POST', {})); toast('Arrêt demandé : la session et le dossier de travail sont conservés.'); updatePanel(); break; }
        case 'regen-claude-md': { const saved = await api('projects/' + idv + '/claude-md', 'POST', {}); const i = st.projects.findIndex(x => x.id === saved.id); if (i >= 0) st.projects[i] = saved; toast('CLAUDE.md régénéré.'); render(); break; }
        case 'retry-clone': { const saved = await api('projects/' + idv + '/clone', 'POST', {}); const i = st.projects.findIndex(p => p.id === saved.id); if (i >= 0) st.projects[i] = saved; toast('Nouveau clonage lancé.'); render(); setTimeout(refresh, 4000); break; }
        case 'deploy': {
          const p = st.projects.find(x => x.id === idv); if (!p) break;
          if (!confirm(`Déployer « ${p.name} » en production sur ${deployOf(p).url} ?\n\nLe service de déploiement prend la version qui est sur GitHub (branche ${deployOf(p).branch}).`)) break;
          el.disabled = true;
          const result = await api('projects/' + idv + '/deploy', 'POST', {}); setProject(result);
          toast(result.warnings?.length ? 'Déploiement lancé. Attention : ' + result.warnings[0] : 'Déploiement lancé : le suivi s’affiche dans le projet.'); refresh(); break;
        }
        case 'deploy-refresh': setProject(await api('projects/' + idv + '/deploy')); break;
        case 'deploy-register': el.disabled = true; setProject(await api('projects/' + idv + '/deploy-register', 'POST', {})); toast('Projet réenregistré auprès du service de déploiement.'); break;
        case 'deploy-public': {
          const name = el.dataset.name;
          if (!confirm(`Valider la mise en ligne publique de ${name} ?\n\nLe service de déploiement publiera ce site sur Internet à cette adresse. Sans votre accord, rien n’est publié.`)) break;
          el.disabled = true; setProject(await api('projects/' + idv + '/deploy-public', 'POST', { name })); toast('Accord enregistré pour ' + name + '. Le service s’occupe de la mise en ligne.'); break;
        }
        case 'retry-bootstrap': { setProject(await api('projects/' + idv + '/bootstrap', 'POST', {})); toast('Création relancée.'); setTimeout(refresh, 2000); break; }
        case 'quick-continue': await launch(idv, 'reprise', 'Oui, continue.', el); break;
        case 'request-agent': {
          const p = st.projects.find(x => x.id === idv); if (!p) break;
          if (!confirm(`Demander à OpenClaw de créer un agent dédié à « ${p.name} » ?

Son agent principal recevra le contexte du projet (objectif, consignes, dépôt) et créera l’agent avec son propre espace de travail. Cockpit l’associera au projet dès qu’il apparaît.`)) break;
          el.disabled = true;
          const saved = await api('projects/' + idv + '/agent-request', 'POST', {}); const i = st.projects.findIndex(x => x.id === saved.id); if (i >= 0) st.projects[i] = saved;
          toast('Demande envoyée à OpenClaw. L’agent sera associé au projet dès qu’il apparaît.'); render(); if (modal.open && modal.querySelector('[data-pj-form=project]')) modal.close(); break;
        }
        case 'open-attachment': await openAttachment(idv, el.dataset.att, el.dataset.name); break;
        case 'delete-attachment': { const t = st.tasks.find(t => t.id === idv), a = t?.attachments?.find(a => a.id === el.dataset.att); if (!a || !confirm(`Retirer « ${a.name} » de la tâche ?`)) break; const saved = await api('tasks/' + idv + '/attachments/' + a.id, 'DELETE'); upsert(saved); refreshAttachments(saved); break; }
        case 'drop-file': { const form = el.closest('form'); filesOf(form).splice(Number(idv), 1); if (form.dataset.pjForm === 'new-chat') render(); else form.querySelector('.pj-pending').innerHTML = pendingHTML(filesOf(form)); break; }
        case 'delete-task': { const t = st.tasks.find(t => t.id === idv); if (!t || !confirm(`Supprimer définitivement « ${t.title} » et son historique ?`)) break; await api('tasks/' + idv, 'DELETE'); st.tasks = st.tasks.filter(x => x.id !== idv); if (st.chat === idv) st.chat = null; modal.close(); render(); break; }
      }
    } catch (e) { toast(e.message); }
  });
  // Ctrl+Entrée (ou Cmd+Entrée) envoie le message ; Entrée seule passe à la ligne.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    const form = event.target.closest?.('[data-pj-form=chat],[data-pj-form=new-chat]'); if (!form) return;
    event.preventDefault(); const button = form.querySelector('.primary[type=submit]') || form.querySelector('[type=submit]'); if (button && !button.disabled) form.requestSubmit(button);
  });
  document.addEventListener('input', event => {
    // Saisie en cours de la vue « conversations » : gardée en mémoire pour survivre aux rafraîchissements.
    if (event.target.dataset?.pjDraft) { st.drafts[event.target.dataset.pjDraft] = event.target.value; return; }
    if (event.target.id !== 'pj-search') return;
    st.search = event.target.value; render();
  });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-pj-move]')) move(el.dataset.pjMove, el.value);
    if (el.matches('[data-pj-pick=project]')) { st.project = el.value; write('mb.projects.filter', el.value); render(); }
    if (el.matches('[data-pj-form] input[type=file][name=files]')) { addFiles(el.form, el.files); el.value = ''; }
    if (el.matches('select[name=deployType]')) { const box = el.form.querySelector('[data-pj-typefields]'); if (box) box.innerHTML = typeFields(el.value, {}); }
    if (el.matches('input[name=repoMode]')) { const fresh = el.form.elements.repoMode.value === 'new'; el.form.querySelector('[data-pj-newrepo]').hidden = !fresh; el.form.elements.repository.disabled = fresh; }
    // Nouvelle tâche : changer de projet reprend l'agent de ce projet.
    if (el.matches('[data-pj-form=task] select[name=projectId]')) { const p = st.projects.find(x => x.id === el.value); const sel = el.form.elements.agent; if (sel) sel.innerHTML = agentOptions(p?.agent || null); }
  });
  // Coller une capture d'écran dans une tâche l'ajoute aux pièces jointes.
  document.addEventListener('paste', event => {
    const form = event.target.closest?.('[data-pj-form=task],[data-pj-form=edit-task],[data-pj-form=new-chat]'); if (!form) return;
    const images = [...(event.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (!images.length) return;
    event.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    addFiles(form, images.map((f, i) => new File([f], `capture-${stamp}${images.length > 1 ? '-' + (i + 1) : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
    toast('Capture ajoutée : elle sera envoyée à l’enregistrement.');
  });
  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-pj-form]'); if (!form) return;
    event.preventDefault();
    const fd = new FormData(form), kind = form.dataset.pjForm, submit = form.querySelector('[type=submit]');
    const status = form.querySelector('.form-status');
    if (submit) submit.disabled = true;
    try {
      if (kind === 'quick') {
        const projectId = String(fd.get('projectId') || ''); if (!projectId) throw new Error('Créez d’abord un projet.');
        upsert(await api('tasks', 'POST', { projectId, title: fd.get('title'), status: form.dataset.status })); st.quickAdd = null; render();
      } else if (kind === 'task') {
        const task = await api('tasks', 'POST', readTask(form)); upsert(task);
        try { const withFiles = await uploadPending(form, task.id); if (withFiles) upsert(withFiles); }
        catch (e) { toast('Tâche créée, mais ' + e.message); }
        render(); await openPanel(task.id);
      } else if (kind === 'new-chat') {
        // Le message devient les consignes ; sa première ligne sert de titre.
        const instructions = String(fd.get('instructions') || '').trim(); if (!instructions) throw new Error('Écrivez d’abord ce qu’il faut faire.');
        const projectId = String(fd.get('projectId') || ''), project = st.projects.find(p => p.id === projectId); if (!project) throw new Error('Créez d’abord un projet.');
        const line = instructions.split('\n').find(l => l.trim()).trim().replace(/^#+\s*/, ''), title = line.length > 80 ? line.slice(0, 79).trimEnd() + '…' : line;
        const task = await api('tasks', 'POST', { projectId, title, instructions, expected: String(fd.get('expected') || ''), links: parseLinks(fd.get('links')), engine: fd.get('engine') || '', agent: project.agent || null }); upsert(task);
        try { const withFiles = await uploadPending(form, task.id); if (withFiles) upsert(withFiles); }
        catch (e) { toast('Tâche créée, mais ' + e.message); }
        for (const key of ['new', 'new-expected', 'new-links']) delete st.drafts[key];
        st.chat = task.id; renderChat(true);
        if (event.submitter?.name === 'draft') toast('Brouillon enregistré. Rien n’a été lancé.');
        else await launch(task.id, 'initial', '');
      } else if (kind === 'edit-task') {
        let saved = await api('tasks/' + form.dataset.id, 'PATCH', readTask(form)); upsert(saved);
        const withFiles = await uploadPending(form, saved.id); if (withFiles) upsert(saved = withFiles);
        refreshAttachments(saved); toast('Tâche enregistrée. Rien n’a été lancé.'); render(); updatePanel();
      } else if (kind === 'project') {
        const agentValue = String(fd.get('agent') || ''), [agentConnection, agentId] = agentValue.split('|');
        const body = { name: fd.get('name'), description: fd.get('description'), status: fd.get('status'), color: fd.get('color'),
          agent: agentValue ? { connectionId: agentConnection, agentId, name: form.elements.agent.selectedOptions[0]?.dataset.name || agentId } : null,
          engine: fd.get('engine'), direct: { model: String(fd.get('model') || '').trim(), fallback: fd.get('fallback') || '' },
          context: { instructions: fd.get('instructions'), links: parseLinks(fd.get('links')), repository: fd.get('repository') },
          deployment: { url: String(fd.get('deployUrl') || '').trim(), auto: fd.has('deployAuto'), branch: String(fd.get('deployBranch') || '').trim() } };
        if (!form.dataset.id && fd.get('repoMode') === 'new') { delete body.context.repository; body.newRepository = { name: String(fd.get('newRepoName') || '').trim(), owner: String(fd.get('newRepoOwner') || '').trim(), private: !fd.has('newRepoPublic') }; }
        const saved = form.dataset.id ? await api('projects/' + form.dataset.id, 'PATCH', body) : await api('projects', 'POST', body);
        if (body.newRepository) toast('Projet créé. Le dépôt GitHub, la copie locale et le premier envoi se préparent : suivez l’avancement dans le projet.');
        const i = st.projects.findIndex(p => p.id === saved.id); if (i >= 0) st.projects[i] = saved; else { st.projects.push(saved); st.project = saved.id; write('mb.projects.filter', saved.id); }
        modal.close(); render();
      } else if (kind === 'chat') {
        const taskId = form.dataset.id, note = String(fd.get('note') || '').trim(), sets = !!form.dataset.sets;
        if (sets) {
          // Première demande d'une tâche sans consignes : le message devient ses consignes.
          if (!note) throw new Error('Écrivez d’abord ce que l’agent doit faire.');
          const saved = await api('tasks/' + taskId, 'PATCH', { instructions: note }); upsert(saved);
          const field = modal.querySelector('[data-pj-form=edit-task] [name=instructions]'); if (field && !field.value.trim()) field.value = saved.instructions;
        }
        // Le message quitte la zone de saisie dès l'envoi ; il y revient si l'envoi échoue.
        const box = () => (modal.open && modal.querySelector('[data-pj-form=chat] [name=note]')) || document.querySelector?.('.pj-chat-composer [name=note]');
        if (box()) box().value = ''; delete st.drafts[taskId];
        // Deuxième bouton (ex. « Réviser le plan ») : son type de lancement remplace celui du formulaire, le message est alors obligatoire.
        const kind = event.submitter?.name === 'alt' ? event.submitter.value : form.dataset.kind;
        if (event.submitter?.name === 'alt' && !note) throw new Error('Écrivez ce qu’il faut changer.');
        if (!await launch(taskId, kind, sets ? '' : note, submit) && !sets && box() && !box().value) { box().value = note; st.drafts[taskId] = note; }
      }
    } catch (e) { if (status) status.textContent = e.message; toast(e.message); }
    finally { if (submit?.isConnected) submit.disabled = false; }
  });

  // Glisser-déposer : change uniquement la colonne.
  document.addEventListener('dragstart', event => { const cardEl = event.target.closest?.('[data-pj-task]'); if (!cardEl) return; st.dragging = cardEl.dataset.pjTask; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', st.dragging); cardEl.classList.add('is-dragging'); });
  document.addEventListener('dragover', event => { if (!st.dragging) return; const col = event.target.closest?.('[data-pj-col]'); if (!col) return; event.preventDefault(); document.querySelectorAll('.pj-col.is-over').forEach(c => c !== col && c.classList.remove('is-over')); col.classList.add('is-over'); });
  document.addEventListener('drop', event => { if (!st.dragging) return; const col = event.target.closest?.('[data-pj-col]'); event.preventDefault(); const taskId = st.dragging; st.dragging = null; document.querySelectorAll('.pj-col.is-over,.is-dragging').forEach(c => c.classList.remove('is-over', 'is-dragging')); if (col) move(taskId, col.dataset.pjCol); });
  document.addEventListener('dragend', () => { st.dragging = null; document.querySelectorAll('.pj-col.is-over,.is-dragging').forEach(c => c.classList.remove('is-over', 'is-dragging')); });
  modal.addEventListener('close', () => { if (modal.open) return; modal.classList.remove('pj-drawer'); st.panel = null; schedule(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isActive()) refresh(); });

  return { html, enter: () => { refresh(); loadAgents(true); }, leave: () => clearTimeout(pollTimer) };
}
