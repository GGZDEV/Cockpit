// Onglet Projets : projets personnels, tableau Kanban et tâches confiées aux agents OpenClaw.
// L'état réel (projets, tâches, exécutions) vit sur le serveur du PC : /api/projects/*.
import { esc, icon, read, write, uid, safeUrl, timeoutSignal } from './core.js';

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
const RUN_KIND = { initial: 'Lancement', reprise: 'Reprise', answer: 'Réponse à une question', retry: 'Relance' };
const PALETTE = ['#3dd68c', '#b48cff', '#4c9dff', '#ff9f43', '#ff6b8a', '#22d3ee', '#f5c542'];
const OPEN = ['pending', 'started'];
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.txt,.md,.csv,.json,.log';
const MAX_FILE = 10 * 1024 * 1024;
const WORKSPACE = { cloning: 'Clonage en cours…', ready: 'Copie locale prête', failed: 'Clonage échoué' };
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
};

export function createProjectsUI({ sources, modal, showModal, toast, render, isActive }) {
  const st = { loaded: false, loading: false, error: '', projects: [], tasks: [], capabilities: {}, agents: null, agentsError: '',
    view: read('mb.projects.view', 'board') === 'grid' ? 'grid' : 'board', project: read('mb.projects.filter', 'all'), who: 'all', search: '', attention: false,
    projectStatus: 'all', archived: false, filters: false, quickAdd: null, panel: null, launching: new Set(), dragging: null };
  let pollTimer;
  const pending = new WeakMap(); // formulaire -> fichiers choisis ou collés, envoyés à l'enregistrement

  async function api(route, method = 'GET', body) {
    const response = await sources.feedmeFetch('/api/projects/' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = {}; try { data = await response.json(); } catch { /* réponse vide */ }
    if (!response.ok) throw new Error(data.error || (response.status === 404 ? 'Le service des projets n’est pas disponible sur ce PC. Relancez Cockpit.' : 'Service des projets indisponible.'));
    return data;
  }
  const projectOf = task => st.projects.find(p => p.id === task.projectId);
  const visibleProjects = () => st.projects.filter(p => !p.archived);
  function upsert(task) { const i = st.tasks.findIndex(t => t.id === task.id); if (i >= 0) st.tasks[i] = task; else st.tasks.push(task); }

  async function refresh(quiet = true) {
    if (st.loading) return; st.loading = true;
    try { const data = await api('state'); Object.assign(st, { projects: data.projects, tasks: data.tasks, capabilities: data.capabilities || {}, error: '', loaded: true }); }
    catch (e) { st.error = e.message; if (!quiet) toast(e.message); }
    finally { st.loading = false; }
    if (!st.projects.some(p => p.id === st.project)) st.project = 'all';
    render(); updatePanel(); schedule();
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
    const running = st.tasks.some(openRun);
    pollTimer = setTimeout(() => { if (!document.hidden) refresh(); else schedule(); }, running ? 2500 : 20000);
  }

  // ----- Rendu de la page -----------------------------------------------------------------
  function matches(task) {
    const q = st.search.trim().toLowerCase(), p = projectOf(task);
    if (!p || p.archived) return false;
    if (st.project !== 'all' && task.projectId !== st.project) return false;
    if (st.who === 'me' && task.agent) return false;
    if (st.who === 'agents' && !task.agent) return false;
    if (st.attention && !needsMe(task)) return false;
    return !q || [task.title, task.code, task.instructions, p.name, task.agent?.name].some(v => String(v || '').toLowerCase().includes(q));
  }
  function needsMe(task) { const run = lastRun(task); return task.status === 'review' || task.status === 'blocked' || (run && ['failed', 'interrupted'].includes(run.status) && task.status !== 'done'); }
  function runBadge(task) {
    const run = lastRun(task); if (!run) return '';
    if (OPEN.includes(run.status)) return `<span class="pj-tag ${run.status === 'started' ? 'is-live' : 'is-wait'}"><i></i>${run.status === 'started' ? 'Agent au travail' : 'En attente de démarrage'}</span>`;
    if (task.status === 'done') return '';
    if (run.status === 'failed') return '<span class="pj-tag is-bad"><i></i>Échec</span>';
    if (run.status === 'interrupted') return '<span class="pj-tag is-bad"><i></i>Interrompue</span>';
    if (run.outcome === 'question' && task.status === 'blocked') return '<span class="pj-tag is-ask"><i></i>Question de l’agent</span>';
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
    if (!task.agent) return `<span class="pj-av is-me" aria-hidden="true">M</span><span class="pj-who">Manuelle</span>`;
    const name = task.agent.name || task.agent.agentId;
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
        ${workspaceHTML(project)}</div>
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
    if (!st.projects.length) return `<div class="pj-empty"><h2>Aucun projet pour l’instant</h2><p>Un projet regroupe vos tâches et le contexte que vos agents OpenClaw recevront : objectif, consignes, ressources, dépôt…</p><button class="button primary" data-pj="new-project">${icon('plus')} Créer un projet</button></div>`;
    return `${filters}<div class="pj-pgrid">${list.map(projectCard).join('') || `<div class="pj-empty"><p>${st.archived ? 'Aucun projet archivé.' : 'Aucun projet ne correspond à ces filtres.'}</p></div>`}</div>`;
  }
  function html() {
    if (!st.loaded && !st.error) { if (!st.loading) refresh(); return '<div class="pj-root"><p class="pj-loading" role="status">Chargement des projets…</p></div>'; }
    const active = st.tasks.filter(t => matches(t) && t.status !== 'done');
    const attention = st.tasks.filter(t => projectOf(t) && !projectOf(t).archived && needsMe(t) && t.status !== 'done').length;
    const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const visible = visibleProjects();
    const tabs = [['all', 'Tout'], ['me', 'Mes tâches'], ['agents', 'Agents']].map(([id, label]) => `<button data-pj="who" data-id="${id}" aria-pressed="${st.who === id}">${label}</button>`).join('');
    const chips = [{ id: 'all', name: 'Tous les projets' }, ...visible].map(p => `<button class="pj-chip" data-pj="project" data-id="${esc(p.id)}" aria-pressed="${st.project === p.id}">${p.color ? `<i style="background:${esc(p.color)}"></i>` : ''}${esc(p.name)}<span>${st.tasks.filter(t => (p.id === 'all' ? projectOf(t) && !projectOf(t).archived : t.projectId === p.id)).length}</span></button>`).join('');
    const error = st.error ? `<div class="pj-banner is-bad" role="alert">${G.alert}<span>${esc(st.error)}</span><button class="button" data-pj="reload">Réessayer</button></div>` : '';
    const body = st.view === 'grid' ? grid() : !visible.length ? `<div class="pj-empty"><h2>Commencez par un projet</h2><p>Créez un projet, écrivez une tâche, choisissez un agent puis cliquez sur « Lancer ». Rien ne démarre sans ce clic.</p><button class="button primary" data-pj="new-project">${icon('plus')} Créer un projet</button></div>`
      : `<div class="pj-filters"><div class="pj-seg" role="group" aria-label="Assignation">${tabs}</div><div class="pj-chips" role="group" aria-label="Projet">${chips}</div>
        ${attention ? `<button class="pj-chip pj-attn" data-pj="attention" aria-pressed="${st.attention}">${G.alert} À traiter <span>${attention}</span></button>` : ''}</div>${board()}`;
    return `<div class="pj-root" data-scroll="page:projects">
      <header class="pj-head"><div><h1>Projets</h1><p>${esc(date.charAt(0).toUpperCase() + date.slice(1))} · ${active.length} tâche${active.length > 1 ? 's' : ''} · ${active.filter(t => t.status === 'doing').length} en cours${attention ? ` · <b class="pj-attn-text">${attention} en attente de vous</b>` : ''}</p></div>
        <div class="pj-actions"><label class="pj-search">${icon('search')}<span class="sr-only">Rechercher</span><input type="search" id="pj-search" placeholder="Rechercher…" value="${esc(st.search)}" autocomplete="off"></label>
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
    return `<div class="pj-repo">${link}${state}</div>`;
  }
  function attachmentsHTML(task) {
    const list = task.attachments || [];
    return list.length ? `<ul class="pj-atts">${list.map(a => `<li><button type="button" class="pj-att" data-pj="open-attachment" data-id="${esc(task.id)}" data-att="${esc(a.id)}" data-name="${esc(a.name)}">${G.clip}<span>${esc(a.name)}</span><small>${fmtSize(a.size)}${a.by ? ' · ' + esc(a.by) : ''}</small></button>
      <button type="button" class="icon-button" data-pj="delete-attachment" data-id="${esc(task.id)}" data-att="${esc(a.id)}" aria-label="Retirer ${esc(a.name)}">${G.trash}</button></li>`).join('')}</ul>` : '';
  }
  function pendingHTML(form) {
    const list = pending.get(form) || [];
    return list.map((f, i) => `<li><span class="pj-att is-new">${G.clip}<span>${esc(f.name)}</span><small>${fmtSize(f.size)} · à envoyer</small></span><button type="button" class="icon-button" data-pj="drop-file" data-id="${i}" aria-label="Ne pas joindre ${esc(f.name)}">${G.trash}</button></li>`).join('');
  }
  function addFiles(form, files) {
    const list = pending.get(form) || [];
    for (const file of files) {
      if (file.size > MAX_FILE) { toast(file.name + ' dépasse 10 Mo.'); continue; }
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!ACCEPT.split(',').includes('.' + ext)) { toast(file.name + ' : type refusé (captures, PDF, zip, textes).'); continue; }
      list.push(file);
    }
    pending.set(form, list);
    const box = form.querySelector('.pj-pending'); if (box) box.innerHTML = pendingHTML(form);
  }
  async function uploadPending(form, taskId) {
    const list = pending.get(form) || []; let task = null;
    while (list.length) {
      const file = list[0];
      const response = await sources.feedmeFetch('/api/projects/tasks/' + taskId + '/attachments?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, signal: timeoutSignal(180000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(file.name + ' : ' + (data.error || 'envoi impossible.'));
      task = data.task; list.shift();
      const box = form.querySelector('.pj-pending'); if (box) box.innerHTML = pendingHTML(form);
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
      <details class="pj-more"><summary>Plus d’options <span class="muted">· ${esc(task.agent ? 'agent : ' + task.agent.name : 'tâche manuelle')}</span></summary><div class="pj-form">
        <div class="pj-three"><label>Agent OpenClaw<select name="agent">${agentOptions(task.agent)}</select></label><label>Priorité${prioritySelect(task.priority || 0)}</label><label>Échéance<input type="date" name="due" value="${esc(task.due || '')}"></label></div>
        ${agentHelp()}
        <label>Critères de réussite<textarea name="criteria" rows="2" maxlength="4000" placeholder="Comment vérifier que c’est réussi">${esc(task.criteria || '')}</textarea></label>
        <label>Ressources de la tâche<textarea name="resources" rows="2" maxlength="12000" placeholder="Chemins, extraits utiles…">${esc(task.resources || '')}</textarea></label>
        <label class="pj-check"><input type="checkbox" name="includeContext" ${task.includeContext === false ? '' : 'checked'}> Transmettre le contexte du projet à l’agent</label></div></details>`;
  }
  function readTask(form) {
    const fd = new FormData(form), value = String(fd.get('agent') || '');
    const option = form.elements.agent?.selectedOptions?.[0];
    const [connectionId, agentId] = value.split('|');
    return { title: fd.get('title'), instructions: fd.get('instructions'), expected: fd.get('expected'), criteria: fd.get('criteria'), resources: fd.get('resources'), links: parseLinks(fd.get('links')),
      priority: Number(fd.get('priority')), due: fd.get('due') || '', includeContext: fd.has('includeContext'), agent: value ? { connectionId, agentId, name: option?.dataset.name || agentId } : null,
      ...(fd.has('projectId') ? { projectId: fd.get('projectId') } : {}) };
  }
  async function projectForm(p = {}) {
    await loadAgents();
    const c = p.context || {};
    showModal(p.id ? 'Modifier le projet' : 'Nouveau projet', 'Le contexte est transmis aux agents lorsqu’une tâche le demande. Les secrets n’ont rien à faire ici.', `<form class="pj-form" data-pj-form="project" data-id="${esc(p.id || '')}">
      <div class="pj-two"><label>Nom<input name="name" required maxlength="120" value="${esc(p.name || '')}"></label><label>Préfixe des tâches<input name="key" maxlength="6" value="${esc(p.key || '')}" placeholder="Automatique"></label></div>
      <label>Courte description<input name="description" maxlength="600" value="${esc(p.description || '')}"></label>
      <div class="pj-three"><label>Statut<select name="status">${Object.entries(PROJECT_STATUS).map(([v, l]) => `<option value="${v}" ${(p.status || 'prep') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Priorité${prioritySelect(p.priority || 0)}</label><label>Échéance<input type="date" name="due" value="${esc(p.due || '')}"></label></div>
      <fieldset class="pj-colors"><legend>Couleur</legend>${PALETTE.map((col, i) => `<label><input type="radio" name="color" value="${col}" ${(p.color || PALETTE[st.projects.length % PALETTE.length]) === col ? 'checked' : ''}><span style="background:${col}" aria-label="Couleur ${i + 1}"></span></label>`).join('')}</fieldset>
      <h3>Contexte pour les agents</h3>
      <label>Objectif<textarea name="objective" rows="2" maxlength="4000">${esc(c.objective || '')}</textarea></label>
      <label>Instructions générales<textarea name="instructions" rows="4" maxlength="12000" placeholder="Conventions, ton, outils à utiliser ou à éviter…">${esc(c.instructions || '')}</textarea></label>
      <label>Ressources et documents<textarea name="resources" rows="3" maxlength="12000">${esc(c.resources || '')}</textarea></label>
      <label>Liens (un par ligne, « libellé | adresse » possible)<textarea name="links" rows="3">${esc(linksText(c.links))}</textarea></label>
      <div class="pj-two"><label>Dépôt GitHub<input name="repository" maxlength="600" value="${esc(c.repository || '')}" placeholder="https://github.com/compte/depot"></label><label>Agent du projet<select name="agent">${agentOptions(p.agent)}</select></label></div>
      <p class="pj-help">Une adresse GitHub est clonée sur ce PC, à côté de vos autres projets : Claude Code peut y travailler tout de suite. Un dossier existant n’est jamais écrasé. Les nouvelles tâches sont confiées à l’agent du projet.</p>
      ${p.id ? agentLine(p) + workspaceHTML(p) : ''}
      <label>Environnement de travail<input name="environment" maxlength="2000" value="${esc(c.environment || '')}" placeholder="Serveur, dossier, outil…"></label>
      <label>Publication<textarea name="publishing" rows="3" maxlength="4000" placeholder="Comment publier ce projet : branche et dépôt où pousser, commande de déploiement, vérification à faire…">${esc(c.publishing || '')}</textarea></label>
      <label class="pj-check"><input type="checkbox" name="autoPublish" ${c.autoPublish ? 'checked' : ''}> L’agent publie lui-même à la fin d’une tâche, en suivant cette procédure</label>
      <p class="pj-help">Sans cette case, il prépare tout et vous demande avant de publier. La procédure doit pouvoir s’exécuter là où l’agent travaille (le serveur OpenClaw pour un agent OpenClaw). Seul vous pouvez cocher cette case : les agents ne le peuvent pas.</p>
      <p class="form-status pj-help" role="status"></p>
      <div class="pj-form-actions"><button class="button primary" type="submit">${p.id ? 'Enregistrer' : 'Créer le projet'}</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`, 'pj-project', true);
  }
  async function taskForm() {
    await loadAgents();
    const project = st.projects.find(p => p.id === st.project) || visibleProjects()[0];
    showModal('Nouvelle tâche', 'Créer ou assigner une tâche ne lance rien : l’agent démarre uniquement avec le bouton « Lancer ».', `<form class="pj-form" data-pj-form="task">${taskFields({ projectId: project?.id, agent: project?.agent || null }, { withProject: true })}
      <p class="form-status pj-help" role="status"></p><div class="pj-form-actions"><button class="button primary" type="submit">Créer la tâche</button><button class="button" type="button" data-action="close-modal">Annuler</button></div></form>`, 'pj-task-new', true);
  }

  // ----- Panneau de tâche ---------------------------------------------------------------
  function eventsHTML(run) {
    return `<ol class="pj-events">${run.events.map(e => `<li class="ev-${esc(e.type)}"><time>${fmtTime(e.at)}</time><span>${esc(e.text)}</span></li>`).join('')}</ol>`;
  }
  function resultHTML(text, links) {
    return `<div class="pj-result">${esc(text || '')}</div>${links?.length ? `<ul class="pj-links">${links.map(l => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${icon('link')} ${esc(l.label || l.url)}</a></li>`).join('')}</ul>` : ''}`;
  }
  // Continuer la même tâche avec l'agent, dans sa conversation : pas besoin de recréer une tâche.
  function continueForm(task, enabled) {
    return `<form class="pj-form pj-continue" data-pj-form="launch" data-kind="reprise" data-id="${esc(task.id)}">
      <label>Répondre à ${esc(task.agent?.name || 'l’agent')} <span class="pj-help">(il garde le fil de la tâche)</span><textarea name="note" rows="2" data-keep="reprise" placeholder="Une correction, une suite, une précision…" required></textarea></label>
      <div class="pj-form-actions"><button class="button primary" type="button" data-pj="quick-continue" data-id="${esc(task.id)}" ${enabled ? '' : 'disabled'}>${G.launch} Oui, continue</button>
        <button class="button" type="submit" ${enabled ? '' : 'disabled'}>Envoyer la réponse</button></div></form>`;
  }
  function liveHTML(task) {
    const run = lastRun(task), running = openRun(task), busy = st.launching.has(task.id);
    const canContinue = !running && !busy && !!task.agent;
    const canLaunch = !running && !busy && task.status !== 'done';
    const missing = [!task.instructions && 'des consignes', !task.agent && 'un agent'].filter(Boolean);
    let primary = '';
    if (running) {
      primary = `<div class="pj-box is-live"><div class="pj-box-head"><span class="pj-pulse ${running.status}"></span><b>${RUN_STATUS[running.status]}</b><span class="muted">· ${esc(running.agent?.name || '')} · ${RUN_KIND[running.kind]}</span></div>
        ${running.tracking === 'recovering' ? `<p class="pj-help">Suivi direct indisponible : l’état est relu dans l’historique OpenClaw${running.trackingError ? ' (' + esc(running.trackingError) + ')' : ''}. Rien n’est renvoyé à l’agent.</p>` : ''}
        ${eventsHTML(running)}
        ${running.liveText ? `<details class="pj-partial" data-key="partial"><summary>Réponse en cours de rédaction (non définitive)</summary><div class="pj-result">${esc(running.liveText)}</div></details>` : ''}
        <p class="pj-help">${esc(st.capabilities.interruptReason || 'L’arrêt n’est pas disponible avec cette connexion.')}</p>
        ${task.updatedAt && task.updatedAt > running.createdAt ? '<p class="pj-help is-warn">La tâche a été modifiée après ce lancement : l’agent travaille sur la version envoyée. Les modifications serviront au prochain lancement.</p>' : ''}</div>`;
    } else if (run && task.status !== 'done' && run.status === 'succeeded' && run.outcome === 'question') {
      primary = `<div class="pj-box is-ask"><div class="pj-box-head">${G.alert}<b>L’agent a besoin de vous</b></div>${resultHTML(run.result)}
        <form class="pj-form" data-pj-form="launch" data-kind="answer" data-id="${esc(task.id)}"><label>Votre réponse<textarea name="note" rows="3" data-keep="answer" required></textarea></label>
        <div class="pj-form-actions"><button class="button primary" type="submit" ${canLaunch ? '' : 'disabled'}>${G.launch} Répondre et lancer</button></div></form></div>`;
    } else if (run && task.status !== 'done' && ['failed', 'interrupted'].includes(run.status)) {
      primary = `<div class="pj-box is-bad"><div class="pj-box-head">${G.alert}<b>${run.status === 'failed' ? 'L’exécution a échoué' : 'L’exécution a été interrompue'}</b><span class="muted">· ${fmtTime(run.endedAt)}</span></div><div class="pj-result">${esc(run.error || '')}</div>
        <form class="pj-form" data-pj-form="launch" data-kind="retry" data-id="${esc(task.id)}"><label>Précisions pour la relance (facultatif)<textarea name="note" rows="2" data-keep="retry"></textarea></label>
        <div class="pj-form-actions"><button class="button primary" type="submit" ${canLaunch && !missing.length ? '' : 'disabled'}>${G.launch} Relancer</button></div></form></div>`;
    } else if (run && run.status === 'succeeded' && run.outcome === 'result' && !run.accepted) {
      primary = `<div class="pj-box is-ok"><div class="pj-box-head">${icon('check')}<b>Résultat de ${esc(run.agent?.name || 'l’agent')}</b><span class="muted">· ${fmtTime(run.endedAt)}</span></div>${resultHTML(run.result, run.links)}
        ${task.status !== 'done' ? `<div class="pj-form-actions"><button class="button" data-pj="accept" data-id="${esc(task.id)}">${icon('check')} Accepter et terminer</button></div>` : ''}
        ${continueForm(task, canContinue)}</div>`;
    } else {
      primary = `<div class="pj-box"><div class="pj-box-head"><b>${task.status === 'done' ? 'Tâche terminée' : task.agent ? 'Prête à être confiée à ' + esc(task.agent.name) : 'Tâche manuelle'}</b></div>
        <p class="pj-help">${task.status === 'done' ? (task.agent && run ? 'Vous pouvez continuer avec l’agent ci-dessous : la tâche repassera « À valider » à son prochain résultat.' : 'Pour reprendre le travail, replacez la carte dans une autre colonne.') : task.agent ?(missing.length ? 'Avant de lancer, ajoutez ' + missing.join(' et ') + '.' : 'L’agent recevra les consignes, les critères et ' + (task.includeContext === false ? 'aucun contexte de projet.' : 'le contexte du projet.')) : 'Aucun agent assigné : déplacez la carte au fil de votre travail, ou choisissez un agent ci-dessous.'}</p>
        ${task.agent && task.status !== 'done' ? `<div class="pj-form-actions"><button class="button primary pj-launch" data-pj="launch" data-id="${esc(task.id)}" ${canLaunch && !missing.length ? '' : 'disabled'}>${G.launch} ${busy ? 'Vérification…' : 'Lancer'}</button></div>` : ''}
        ${run?.accepted ? `<p class="pj-help">Résultat accepté le ${fmtTime(run.accepted)}.</p>${resultHTML(run.result, run.links)}` : ''}
        ${task.status === 'done' && task.agent && run ? continueForm(task, canContinue) : ''}</div>`;
    }
    const history = task.runs.slice().reverse().filter(r => r !== running);
    return `${primary}<section class="pj-section"><h3>Historique des exécutions</h3>${history.length ? history.map(r => `<details class="pj-run" data-key="run-${esc(r.id)}"><summary><span class="pj-run-state st-${r.status}">${RUN_STATUS[r.status]}</span>${RUN_KIND[r.kind]} · ${esc(r.agent?.name || '')}<span class="pj-grow"></span><time>${fmtTime(r.createdAt)}</time></summary>
      ${r.note ? `<p class="pj-help"><b>${r.kind === 'answer' ? 'Votre réponse' : 'Précisions'} :</b> ${esc(r.note)}</p>` : ''}${eventsHTML(r)}${r.result ? resultHTML(r.result, r.links) : ''}${r.error ? `<div class="pj-result is-bad">${esc(r.error)}</div>` : ''}
      <details class="pj-prompt"><summary>Consignes envoyées</summary><div class="pj-result">${esc(r.prompt || '')}</div></details></details>`).join('') : '<p class="pj-help">Aucune exécution pour l’instant.</p>'}</section>`;
  }
  async function openPanel(taskId) {
    const task = st.tasks.find(t => t.id === taskId); if (!task) return;
    st.panel = taskId; loadAgents().then(() => { const sel = modal.querySelector('[data-pj-panel] select[name=agent]'); if (sel && !sel.matches(':focus')) sel.innerHTML = agentOptions(st.tasks.find(t => t.id === taskId)?.agent); });
    const p = projectOf(task);
    showModal(task.code + ' · ' + task.title, (p?.name || '') + ' · ' + (COLUMNS.find(c => c.id === task.status)?.label || '') + (task.createdBy ? ' · créée par ' + task.createdBy : ''),`<div class="pj-panel" data-pj-panel="${esc(task.id)}">
      <div class="pj-panel-bar"><label>Colonne<select data-pj-move="${esc(task.id)}">${COLUMNS.map(c => `<option value="${c.id}" ${task.status === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <span class="pj-help">Déplacer la carte ne lance ni n’arrête aucun agent.</span></div>
      <div class="pj-live" aria-live="polite">${liveHTML(task)}</div>
      <section class="pj-section"><h3>Détails de la tâche</h3><form class="pj-form" data-pj-form="edit-task" data-id="${esc(task.id)}">${taskFields(task)}
        <div class="pj-form-actions"><button class="button primary" type="submit">Enregistrer</button><button class="button pj-danger" type="button" data-pj="delete-task" data-id="${esc(task.id)}">Supprimer</button></div></form></section></div>`, 'pj-task', true);
    modal.classList.add('pj-drawer');
    schedule();
  }
  function updatePanel() {
    const panel = modal.open && modal.querySelector('[data-pj-panel]'); if (!panel) return;
    const task = st.tasks.find(t => t.id === panel.dataset.pjPanel); const live = panel.querySelector('.pj-live'); if (!task || !live) return;
    const next = liveHTML(task); if (live.dataset.html === next) return;
    const kept = {}; live.querySelectorAll('[data-keep]').forEach(el => { kept[el.dataset.keep] = el.value; });
    const open = new Set([...live.querySelectorAll('details[open]')].map(d => d.dataset.key || ''));
    const focused = document.activeElement?.dataset?.keep;
    live.innerHTML = next; live.dataset.html = next;
    live.querySelectorAll('[data-keep]').forEach(el => { if (kept[el.dataset.keep]) el.value = kept[el.dataset.keep]; if (focused === el.dataset.keep) el.focus(); });
    live.querySelectorAll('details').forEach(d => { if (open.has(d.dataset.key || '')) d.open = true; });
    const select = panel.querySelector('[data-pj-move]'); if (select && document.activeElement !== select) select.value = task.status;
    const subtitle = modal.querySelector('.dialog-heading p'); if (subtitle) subtitle.textContent = (projectOf(task)?.name || '') + ' · ' + (COLUMNS.find(c => c.id === task.status)?.label || '');
  }

  // ----- Actions ------------------------------------------------------------------------
  async function launch(taskId, kind, note, button) {
    if (st.launching.has(taskId)) return; // un double clic ne crée qu'un lancement
    const task = st.tasks.find(t => t.id === taskId); if (!task) return;
    const key = uid(); st.launching.add(taskId); if (button) button.disabled = true; updatePanel();
    try {
      // La même clé est renvoyée en cas de nouvelle tentative réseau : le serveur ne crée pas de doublon.
      let result, attempt = 0;
      for (;;) {
        try { result = await api('tasks/' + taskId + '/launch', 'POST', { launchKey: key, kind, note }); break; }
        catch (e) { if (!/fetch|network|réseau|timeout|abort/i.test(e.message) || ++attempt > 1) throw e; }
      }
      upsert(result.task); toast(result.repeated ? 'Ce lancement était déjà enregistré.' : 'Demande transmise. La tâche passera en cours dès que l’agent confirme son démarrage.');
    } catch (e) { toast(e.message); }
    finally { st.launching.delete(taskId); render(); updatePanel(); refresh(); }
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
        case 'view': st.view = st.view === 'grid' ? 'board' : 'grid'; write('mb.projects.view', st.view); render(); break;
        case 'project-status': st.projectStatus = idv; render(); break;
        case 'toggle-archived': st.archived = !st.archived; render(); break;
        case 'reload': st.error = ''; await refresh(false); break;
        case 'open-project': st.project = idv; st.view = 'board'; write('mb.projects.filter', idv); write('mb.projects.view', 'board'); render(); break;
        case 'new-project': await projectForm(); break;
        case 'edit-project': await projectForm(st.projects.find(p => p.id === idv)); break;
        case 'archive-project': { const p = st.projects.find(p => p.id === idv); if (!p) break; const saved = await api('projects/' + p.id, 'PATCH', { archived: !p.archived }); Object.assign(p, saved); if (st.project === p.id) st.project = 'all'; toast(saved.archived ? 'Projet archivé. Retrouvez-le avec le filtre « Archivés ».' : 'Projet restauré.'); render(); break; }
        case 'new-task': await taskForm(); break;
        case 'quick-add': st.quickAdd = idv; render(); requestAnimationFrame(() => document.querySelector('#pj-quick-title')?.focus()); break;
        case 'quick-cancel': st.quickAdd = null; render(); break;
        case 'open-task': await openPanel(idv); break;
        case 'launch': await launch(idv, undefined, '', el); break;
        case 'accept': { el.disabled = true; upsert(await api('tasks/' + idv + '/accept', 'POST', {})); toast('Résultat accepté : tâche terminée.'); render(); updatePanel(); break; }
        case 'retry-clone': { const saved = await api('projects/' + idv + '/clone', 'POST', {}); const i = st.projects.findIndex(p => p.id === saved.id); if (i >= 0) st.projects[i] = saved; toast('Nouveau clonage lancé.'); render(); setTimeout(refresh, 4000); break; }
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
        case 'drop-file': { const form = el.closest('form'); (pending.get(form) || []).splice(Number(idv), 1); form.querySelector('.pj-pending').innerHTML = pendingHTML(form); break; }
        case 'delete-task': { const t = st.tasks.find(t => t.id === idv); if (!t || !confirm(`Supprimer définitivement « ${t.title} » et son historique ?`)) break; await api('tasks/' + idv, 'DELETE'); st.tasks = st.tasks.filter(x => x.id !== idv); modal.close(); render(); break; }
      }
    } catch (e) { toast(e.message); }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'pj-search') return;
    st.search = event.target.value; render();
  });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-pj-move]')) move(el.dataset.pjMove, el.value);
    if (el.matches('.pj-form input[type=file][name=files]')) { addFiles(el.form, el.files); el.value = ''; }
    // Nouvelle tâche : changer de projet reprend l'agent de ce projet.
    if (el.matches('[data-pj-form=task] select[name=projectId]')) { const p = st.projects.find(x => x.id === el.value); const sel = el.form.elements.agent; if (sel) sel.innerHTML = agentOptions(p?.agent || null); }
  });
  // Coller une capture d'écran dans une tâche l'ajoute aux pièces jointes.
  document.addEventListener('paste', event => {
    const form = event.target.closest?.('[data-pj-form=task],[data-pj-form=edit-task]'); if (!form) return;
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
      } else if (kind === 'edit-task') {
        let saved = await api('tasks/' + form.dataset.id, 'PATCH', readTask(form)); upsert(saved);
        const withFiles = await uploadPending(form, saved.id); if (withFiles) upsert(saved = withFiles);
        refreshAttachments(saved); toast('Tâche enregistrée. Rien n’a été lancé.'); render(); updatePanel();
      } else if (kind === 'project') {
        const agentValue = String(fd.get('agent') || ''), [agentConnection, agentId] = agentValue.split('|');
        const body = { name: fd.get('name'), key: fd.get('key'), description: fd.get('description'), status: fd.get('status'), priority: Number(fd.get('priority')), due: fd.get('due') || '', color: fd.get('color'),
          agent: agentValue ? { connectionId: agentConnection, agentId, name: form.elements.agent.selectedOptions[0]?.dataset.name || agentId } : null,
          context: { objective: fd.get('objective'), instructions: fd.get('instructions'), resources: fd.get('resources'), links: parseLinks(fd.get('links')), repository: fd.get('repository'), environment: fd.get('environment'), publishing: fd.get('publishing'), autoPublish: fd.has('autoPublish') } };
        const saved = form.dataset.id ? await api('projects/' + form.dataset.id, 'PATCH', body) : await api('projects', 'POST', body);
        const i = st.projects.findIndex(p => p.id === saved.id); if (i >= 0) st.projects[i] = saved; else { st.projects.push(saved); st.project = saved.id; write('mb.projects.filter', saved.id); }
        modal.close(); render();
      } else if (kind === 'launch') {
        await launch(form.dataset.id, form.dataset.kind, String(fd.get('note') || '').trim(), submit);
        if (!openRun(st.tasks.find(t => t.id === form.dataset.id) || { runs: [] })) return;
        form.reset();
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
