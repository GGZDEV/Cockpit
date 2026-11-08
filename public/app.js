import { esc, icon, uid, read, write, safeUrl } from './core.js';
import { proxmoxModel } from './proxmox.js';
import { feedmeOverlayOpen, feedmePreferences, importFeedmePreferences } from './feedme-components.js';
import { haActions } from './ha-actions.js';
import { accountSync } from './account-sync.js';
import { Sources } from './data.js';
import { activeRoom, roomModel, roomLayoutKey, importedRoomWidgets, importedPageWidgets, defaultRoomWidgets, statesForWidget, spotifyStatesForWidget } from './rooms.js';
import { modules, presets } from './modules.js';
import { nativeContent, nativeTitle, nativeEvents } from './native-renderers.js';
import { shell } from './shell.js';
import { createProjectsUI } from './projects.js';
import { usesGrid, selectedTheme, visibleTabs, tabPreferences, setTabs, importTabs, isPhoneScreen, defaultProfile, phoneWidgets, maxHeight } from './preferences.js';
import { attachHomeEditor } from './home-editor.js';
import { headerSettingsHTML, moduleSettingsHTML, colorSettingsHTML, updateSettingControl, commitEntityChoice } from './module-settings.js';
import { homeDisplay, saveDisplay, importDisplay, spanWidth, color, homeHeader, headerTypes, addHeader, backgrounds, haloParts, haloDefaults, applyDisplay, fonts, fullscreenSupported, fullscreenElement, enterFullscreen, toggleFullscreen } from './home-display.js';

for (const [type, def] of Object.entries(modules)) def.title = nativeTitle(type);
const $app = document.querySelector('#app'), modal = document.querySelector('#modal');
const sources = new Sources();
const serverMode = globalThis.COCKPIT_SERVER_MODE === true;
window.MetaBoardFeedMeFetch=(route,options)=>sources.feedmeFetch(String(route).replace(/^\/api\//,''),options); sources.roomPreferences=read('mb.rooms.v1',null);
const pages = serverMode
  ? { overview: ['Vue d’ensemble', 'Votre monde, en un coup d’œil.', 'grid'], home: ['Pièces', 'Les bonnes informations. Les bons gestes.', 'home'], news: ['Votre veille', 'De quoi nourrir votre curiosité.', 'rss'], agents: ['Vos agents', 'Un espace pour penser et faire ensemble.', 'chat'], projects: ['Projets', 'Vos projets personnels et les tâches confiées aux agents.', 'kanban'] }
  : { overview: ['Vue d’ensemble', 'Votre monde, en un coup d’œil.', 'grid'], home: ['Pièces', 'Les bonnes informations. Les bons gestes.', 'home'], news: ['Votre veille', 'De quoi nourrir votre curiosité.', 'rss'], agents: ['Vos agents', 'Un espace pour penser et faire ensemble.', 'chat'], projects: ['Projets', 'Vos projets personnels et les tâches confiées aux agents.', 'kanban'], system: ['Les coulisses', 'Un œil sur les machines qui font tourner le reste.', 'server'] };
const profiles = { desktop: ['Bureau', 'monitor'], tablet: ['Tablette', 'tablet'], phone: ['Téléphone', 'phone'], compact: ['Compact', 'panel'] };
const params = new URLSearchParams(location.search);
let profile = profiles[params.get('surface')] ? params.get('surface') : read('mb.profile', defaultProfile({ phone: isPhoneScreen(), servedByHA: HD.Auth?.servedByHA() }));
if (!profiles[profile]) profile = 'desktop';
let selectedRoomId = read('mb.room', read('hd.room',null));
let page = read('mb.page', 'overview'); if (!pages[page]) page = 'overview';
let layouts = cleanLayouts(read('mb.layouts.native.v1', {})), editing = false, query = '', dialogType = '', detailId, libraryCategory = 'Tous';
let todos = read('mb.todos.v1', []);
if (!Array.isArray(todos)) todos = [];
todos = todos.filter(t=>!['Explorer mon nouvel espace','Composer la vue de ma tablette'].includes(t?.title));
todos = todos.filter(t => typeof t?.id === 'string' && typeof t.title === 'string').slice(0, 1000);
let notes = read('mb.notes.v1', {}); if (!notes || typeof notes !== 'object' || Array.isArray(notes)) notes = {};
let readArticles = read('mb.read.v1', []), savedArticles = read('mb.saved.v1', []), hiddenSources = read('mb.hidden-sources.v1', []);
if (!Array.isArray(readArticles)) readArticles=[]; if (!Array.isArray(savedArticles)) savedArticles=[]; if (!Array.isArray(hiddenSources)) hiddenSources=[];
let favorites = read('mb.favorites.v1', []); if (!Array.isArray(favorites)) favorites = [];
const chat = { id: null, messages: [], loading: false, sending: false, error: '', controller: null, revision: 0 };
let pendingRender, dragged, lastFocus, homeEditor;
const projectsUI = createProjectsUI({ sources, modal, showModal: (...a) => showModal(...a), toast: m => toast(m), render: () => render(true), isActive: () => page === 'projects' });

const syncAccount=accountSync(sources,()=>({layouts,notes,todos,homeDisplay,feedmePreferences:feedmePreferences(),rooms:sources.roomPreferences,tabs:tabPreferences,theme:selectedTheme()}),data=>{
  if (data.feedmePreferences) importFeedmePreferences(data.feedmePreferences);
  sources.roomPreferences=data.rooms || null; write('mb.rooms.v1',sources.roomPreferences);
  layouts=cleanLayouts(data.layouts); notes={}; for (const [id,value] of Object.entries(data.notes || {})) if (/^[\w-]{1,80}$/.test(id) && typeof value==='string') notes[id]=value.slice(0,20000);
  todos=Array.isArray(data.todos) ? data.todos.filter(t=>typeof t?.id==='string' && typeof t.title==='string').slice(0,1000) : [];
  if (data.homeDisplay) importDisplay(data.homeDisplay); if (data.tabs) importTabs(data.tabs); if (['home','feedme'].includes(data.theme)) write('mb.theme',data.theme);
  write('mb.layouts.native.v1',layouts); write('mb.notes.v1',notes); write('mb.todos.v1',todos);
},message=>toast(message));
function cleanLayouts(data) {
  const result = {};
  if (!data || typeof data !== 'object') return result;
  for (const p of Object.keys(profiles)) for (const key of Object.keys(data[p] || {}).filter(key => Object.prototype.hasOwnProperty.call(presets,key) || key.startsWith('room:'))) {
    const entries = data[p]?.[key]; if (!Array.isArray(entries)) continue;
    result[p] ||= {};
    result[p][key] = entries.filter(w => w && Object.prototype.hasOwnProperty.call(modules, w.type)).slice(0, 40).map(w => ({ id: typeof w.id === 'string' && /^[\w-]{1,80}$/.test(w.id) ? w.id : uid(), type: p === 'tablet' && w.type === 'todos' && w.id === 'native-tablet-overview-todos' ? 'ha-todos' : w.type, scope: w.scope === 'all' ? 'all' : 'room', ...(Array.isArray(w.entities) ? {entities:w.entities.filter(id=>typeof id==='string' && /^[a-z_]+\.[\w-]+$/.test(id))} : {}), options:w.options && typeof w.options==='object' && !Array.isArray(w.options) ? w.options : {}, size: ['normal', 'wide', 'full'].includes(w.size) ? w.size : 'normal', ...(Number.isInteger(w.width) && w.width >= 1 && w.width <= 4 ? { width: w.width } : {}), title: typeof w.title === 'string' ? w.title.slice(0,80) : '', accent: color(w.accent), collapsed: !!w.collapsed, height: Number.isInteger(Number(w.height)) && Number(w.height) >= 1 && Number(w.height) <= maxHeight(p) ? Number(w.height) : 2, category: typeof w.category === 'string' ? w.category.slice(0, 150) : '', sort: w.sort === 'trending' ? 'trending' : 'date', showDisks: w.showDisks !== false, bigArt: !!w.bigArt, descriptions: w.descriptions !== false, ...(Array.isArray(w.metrics) ? {metrics:w.metrics.filter(k => ['cpu','ram','gpu','vram'].includes(k))} : {}), ...(typeof w.entity === 'string' && /^[a-z_]+\.[\w-]+$/.test(w.entity) ? { entity: w.entity } : {}) }));
  }
  return result;
}
function newWidget(type) { return { id: uid(), type, size: modules[type].size || 'normal', scope:page === 'home' ? 'room' : 'all' }; }
function currentRoom() { return page === 'home' ? activeRoom(sources,selectedRoomId) : null; }
function layoutKey() { const room=currentRoom(); return page === 'home' && room ? roomLayoutKey(sources,room) : page; }
function current() {
  if (page === 'projects') return [];
  layouts[profile] ||= {};
  const room=currentRoom();
  if (page === 'home') {
    if (!room) return [];
    const key=layoutKey();
    if (!layouts[profile][key]) {
      layouts[profile][key]=profile === 'phone' && layouts.tablet?.[key] ? phoneWidgets(layouts.tablet[key]) : importedRoomWidgets(sources,room,profile) || defaultRoomWidgets(sources,room,profile);
      for (const widget of layouts[profile][key]) if (widget.importedNote != null) { if (notes[widget.id] == null) notes[widget.id]=widget.importedNote; delete widget.importedNote; }
      write('mb.notes.v1',notes); write('mb.layouts.native.v1',layouts);
    }
    return layouts[profile][key];
  }
  if (!layouts[profile][page] && profile === 'phone' && layouts.tablet?.[page]) layouts[profile][page] = phoneWidgets(layouts.tablet[page]);
  if (!layouts[profile][page]) {
    const defaults = page === 'overview' ? (usesGrid(profile) ? ['weather', 'rooms', 'ha-todos', 'notes', 'calendar', 'spotify', 'transit'] : ['system', 'quotas', 'spotify', 'rss']) : page === 'home' ? ['weather', 'rooms', 'ha-todos', 'notes', 'calendar', 'spotify', 'transit'] : presets[page];
    layouts[profile][page] = defaults.map(type => ({ ...newWidget(type), id: 'native-' + profile + '-' + page + '-' + type, size: type === 'calendar' && profile === 'tablet' ? 'wide' : 'normal' }));
    const old = read('mb.layouts.v1', {})[profile]?.[page] || [];
    const previousNote = old.find(w => w.type === 'notes' && notes[w.id]);
    const newNote = layouts[profile][page].find(w => w.type === 'notes');
    if (previousNote && newNote && !notes[newNote.id]) { notes[newNote.id] = notes[previousNote.id]; write('mb.notes.v1', notes); }
  }
  return layouts[profile][page];
}
function findWidget(id) { return current().find(w => w.id === id) || homeDisplay.header.find(w => w.id === id); }
function persist() { syncAccount(); saveDisplay(); if (!write('mb.layouts.native.v1', layouts)) toast('Le navigateur ne peut pas enregistrer la disposition.'); }
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 4200); }
function sourceLabel(provider) {
  if (provider === 'local') return '<span class="source-chip">Local</span>';
  if (sources.demo) return '<span class="source-chip">Démo</span>';
  const connected = provider === 'both' ? sources.status.ha === 'connected' || sources.status.feedme === 'connected' : sources.status[provider] === 'connected';
  return `<span class="source-chip ${connected ? 'connected' : 'disconnected'}"><i></i>${provider === 'ha' ? 'Home Assistant' : provider === 'both' ? 'Calendriers' : 'Cockpit'}${connected ? '' : ' · hors ligne'}</span>`;
}
function context(widget, detail = false) { return { widget: profile === 'phone' ? { ...widget, width: 1, size: 'normal' } : widget, sources, query, todos, note: String(notes[widget.id] ?? ''), detail, home: usesGrid(profile), room:currentRoom(), favorites, readArticles, savedArticles, hiddenSources }; }
function widgetHTML(widget, detail = false) {
  const m = modules[widget.type], home = usesGrid(profile), title = widget.title || nativeTitle(widget.type);
  let content;
  try { content = nativeContent(context(widget, detail), m.render); }
  catch (e) { console.error(widget.type, e); content = '<div class="empty compact mod-empty"><p>Les données de ce module sont indisponibles.</p></div>'; }
  if (widget.title) content = content.replace(/(<h2\b[^>]*>)[\s\S]*?<\/h2>/, (_, start) => start + esc(widget.title) + '</h2>');
  if (detail) return content;
  const embedded=content.includes('data-native-feedme');
  const width = profile === 'phone' ? 1 : spanWidth(widget);
  const height = widget.height || 2;
  const clock = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }).replace('/', '.') + ' · ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const center = widget.type === 'quotas' ? (sources.data.quotas?.stale || sources.data.quotas?.sources?.some(s => s.stale || s.providers?.some(p => p.stale)) ? '<span class="usage-stale">valeurs anciennes</span>' : '') : widget.type === 'system' ? `<span class="widget-clock mono" data-system-clock>${clock}</span>` : widget.type === 'rss' ? `<div class="segmented"><button class="seg ${widget.sort !== 'trending' ? 'active' : ''}" data-action="rss-sort" data-widget-id="${esc(widget.id)}" data-id="date">Récent</button><button class="seg ${widget.sort === 'trending' ? 'active' : ''}" data-action="rss-sort" data-widget-id="${esc(widget.id)}" data-id="trending">Tendances</button></div>` : '';
  const generic = `<button class="widget-btn" data-action="configure" data-id="${esc(widget.id)}" title="Réglages du module" aria-label="Configurer ${esc(title)}">${icon('settings')}</button>`;
  const buttons = widget.type === 'rss' ? generic : widget.type === 'system' ? `${generic}<button class="widget-btn" data-action="disks" data-id="${esc(widget.id)}" aria-label="Afficher ou masquer les disques" aria-pressed="${widget.showDisks !== false}">${icon('folder')}</button>` : widget.type === 'quotas' ? `<button class="widget-btn" data-action="refresh" aria-label="Actualiser les quotas">${icon('refresh')}</button>${generic}` : widget.type === 'spotify' && sources.status.ha === 'connected' ? generic : widget.type === 'spotify' ? `<button class="widget-btn" data-action="spotify-settings" aria-label="Informations Spotify">${icon('note')}</button><button class="widget-btn" data-action="spotify-settings" aria-label="Appareils Spotify">${icon('monitor')}</button><button class="widget-btn" data-action="spotify-settings" aria-label="Historique Spotify">${icon('clock')}</button><button class="widget-btn" data-action="spotify-art" data-id="${esc(widget.id)}" aria-label="Agrandir la pochette">${icon('expand')}</button>${generic}` : generic;
  const header = home ? `<div class="native-home-tools">${buttons}</div>` : `<header class="widget-head"><span class="widget-grip">${icon('grip')}</span><h2 class="widget-name">${esc(title)}</h2><span class="widget-center">${center}</span><span class="widget-tools">${buttons}</span><button class="widget-btn widget-fold" data-action="collapse" data-id="${esc(widget.id)}" aria-label="${widget.collapsed ? 'Déplier' : 'Replier'} ${esc(title)}">${icon('down')}</button></header>`;
  const embeddedTools = `<div class="embedded-module-tools"><span>${esc(title)}</span>${generic}</div>`;
  const homeTools = editing ? `<div class="mod-tools"><button class="mod-grip" data-grip aria-label="Déplacer ${esc(title)} (flèches gauche / droite)">${icon('grip')}<span data-size>${width}×${height}</span></button><span class="mod-tools-btns"><button data-action="colors" data-id="${esc(widget.id)}" aria-label="Couleurs du module ${esc(title)}">${icon('sun')}</button><button data-action="configure" data-id="${esc(widget.id)}" aria-label="Paramétrer le module ${esc(title)}">${icon('settings')}</button><button data-action="remove" data-id="${esc(widget.id)}" aria-label="Supprimer le module ${esc(title)}">${icon('close')}</button></span></div>${(profile === 'phone' ? [['s','Hauteur']] : [['e','Largeur'],['s','Hauteur'],['se','Taille']]).map(([dir,label]) => `<button class="rz rz-${dir}" data-rz="${dir}" aria-label="${label} de ${esc(title)} : ${width} × ${height} (flèches)" title="Étirer pour redimensionner"></button>`).join('')}` : '';
  const tools = home ? homeTools : editing ? `<footer class="edit-tools"><button data-action="move-up" data-id="${esc(widget.id)}" aria-label="Déplacer avant">←</button><span>${icon('grip')}</span><button data-action="remove" data-id="${esc(widget.id)}" aria-label="Retirer le module">${icon('close')}</button><button data-action="move-down" data-id="${esc(widget.id)}" aria-label="Déplacer après">→</button></footer>` : '';
  return `<section class="widget native-widget ${embedded ? 'embedded-widget' : ''} ${feedmeOverlayOpen(widget.id) ? 'frame-overlay' : ''} type-${widget.type} ${home ? 'mod '+(page === 'home' && widget.type === 'devices' ? 'bare ' : 'card ')+'w' + width + ' h' + height : ''} ${widget.collapsed && !home && !embedded ? 'collapsed' : ''} ${editing ? 'is-editing' : ''}" data-widget="${esc(widget.id)}" ${home ? `data-mod="${esc(widget.id)}"` : ''} data-type="${widget.type}" ${home ? `style="grid-column:span ${width};grid-row:span ${height};--h:${height};${color(widget.accent) ? '--accent:' + color(widget.accent) : ''}"` : ''} ${editing && !home ? 'draggable="true"' : ''} aria-label="${esc(title)}">${home ? '' : embedded ? embeddedTools : header}<div class="widget-content ${home ? 'mod-body' : 'widget-body'}" ${home && editing ? 'inert' : ''}>${content}</div>${tools}</section>`;
}
function fitHomeGrid() {
  const grid = $app.querySelector('.mods'); if (!grid) return;
  if (matchMedia('(max-width:860px),(max-height:620px)').matches) { grid.style.removeProperty('--row'); return; }
  const cs = getComputedStyle(grid), gap = parseFloat(cs.rowGap) || 16;
  const inner = grid.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  grid.style.setProperty('--row', Math.max(72,(inner - 3*gap)/4).toFixed(2) + 'px');
}
function render(force = false) {
  if (homeEditor?.busy()) { pendingRender = true; return; }
  if (!force && document.activeElement?.matches('.note-input, [data-form="todo"] input')) { pendingRender = true; return; }
  pendingRender = false;
  if (!visibleTabs(profile).includes(page)) { page = visibleTabs(profile)[0]; write('mb.page',page); }
  const active = document.activeElement, searchFocused = active?.id === 'global-search', caret = searchFocused ? active.selectionStart : 0;
  const scroll = $app.querySelector('.dashboard')?.scrollTop || 0;
  const home = usesGrid(profile);
  applyDisplay(selectedTheme() === 'home'); document.body.dataset.theme = selectedTheme(); document.body.dataset.profile = profile; document.body.dataset.design = home ? 'home' : 'feedme';
  const link = document.querySelector('#native-design'), href = (home ? 'design/home.css' : 'design/feedme.css') + (window.MB_ASSET_VERSION ? '?v=' + window.MB_ASSET_VERSION : '');
  if (link.getAttribute('href') !== href) {
    document.body.dataset.designReady = 'false'; link.dataset.loading = href;
    link.onload = () => { delete link.dataset.loading; document.body.dataset.designReady = 'true'; fitHomeGrid(); };
    link.onerror = () => { delete link.dataset.loading; document.body.dataset.designReady = 'true'; toast('Le style n’a pas pu se charger. Rechargez la page.'); };
    link.href = href;
  } else if (!link.dataset.loading) document.body.dataset.designReady = 'true';
  HD.morph($app,shell({ serverMode, profile, page, pages, profiles, sources, unreadCount: (sources.data.articles || []).filter(a => !read('fm-read',readArticles).includes(a.id) && !hiddenSources.includes(a.source)).length, editing, room:currentRoom(), rooms:roomModel(sources).rooms, list: current(), widgetHTML: w => widgetHTML(w), pageHTML: page === 'projects' ? projectsUI.html() : '' }));
  const grid = $app.querySelector('.dashboard'); if (grid) grid.scrollTop = scroll;
  fitHomeGrid();
  if (searchFocused) { const input = document.querySelector('#global-search'); if (input) { input.focus(); input.setSelectionRange(caret, caret); } }
}
window.addEventListener('resize', fitHomeGrid);
['fullscreenchange','webkitfullscreenchange'].forEach(type => document.addEventListener(type, () => { render(true); requestAnimationFrame(fitHomeGrid); }));
document.addEventListener('pointerup', event => {
  if (usesGrid(profile) && read('mb.autofs',false) && fullscreenSupported() && !fullscreenElement() && !event.target.closest('[data-action="fullscreen"],[data-action="auto-fullscreen"]')) enterFullscreen();
}, true);
function showModal(title, subtitle, html, type, wide = false) {
  if (!modal.open) lastFocus = document.activeElement;
  dialogType = type; modal.className = wide ? 'wide-dialog' : '';
  modal.innerHTML = `<div class="dialog-heading"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button" data-action="close-modal" aria-label="Fermer">${icon('close')}</button></div><div class="dialog-body">${html}</div>`;
  modal.querySelector('.dialog-heading h2').id = 'dialog-title'; modal.setAttribute('aria-labelledby', 'dialog-title');
  if (type === 'settings' && HD.Auth?.servedByHA()) modal.querySelector('[data-form="ha"]').insertAdjacentHTML('beforebegin', '<button class="button primary ha-session-button" data-action="connect-ha-session">Utiliser ma session Home Assistant</button>');
  if (type === 'settings' && !sources.demo && sources.data.todos?.length) modal.querySelector('.settings-buttons').insertAdjacentHTML('beforeend', '<button class="button" data-action="copy-todos">Copier mes tâches Cockpit</button>');
  if (type === 'library' && usesGrid(profile)) modal.querySelector('.dialog-body').insertAdjacentHTML('afterbegin', `<section class="header-library"><h3>En-tête</h3><div class="settings-buttons">${Object.entries(headerTypes).map(([id,t]) => `<button class="button" data-action="header-add" data-id="${id}">${icon('plus')} ${esc(t)}</button>`).join('')}</div></section>`);
  if (!modal.open) modal.showModal();
}
function library() {
  const categories = ['Tous', ...new Set(Object.values(modules).map(m => m.category))];
  showModal('Modules', 'Cockpit et Home Assistant', `<div class="library-filters">${categories.map(c => `<button data-action="category" data-id="${c}" class="${libraryCategory === c ? 'active' : ''}">${c}</button>`).join('')}</div><label class="library-search">${icon('search')}<input id="library-search" aria-label="Chercher un module" placeholder="Météo, agents, éclairage…"></label><div class="library-grid">${Object.entries(modules).filter(([, m]) => libraryCategory === 'Tous' || m.category === libraryCategory).map(([id, m]) => `<article class="library-item" data-search="${esc((m.title + ' ' + m.description).toLowerCase())}"><span class="library-icon lib-${m.category.toLowerCase().replace('è', 'e')}">${icon(m.glyph)}</span><div><span class="eyebrow">${m.category}</span><h3>${esc(nativeTitle(id))}</h3><p>${esc(m.description)}</p></div><footer><span>${m.provider === 'ha' ? 'Home Assistant' : m.provider === 'local' ? 'Sur cet écran' : m.provider === 'both' ? 'Cockpit + HA' : 'Cockpit'}</span><button class="button" data-action="add" data-id="${id}">${icon('plus')} Ajouter</button></footer></article>`).join('')}</div>`, 'library', true);
}
function roomSettings() {
  const model=roomModel(sources), prefs=sources.roomPreferences || {order:sources.originalLayout?.rooms?.order || [],hidden:sources.originalLayout?.rooms?.hidden || {},names:sources.originalLayout?.names || {}};
  const rooms=[...model.index.rooms].sort((a,b)=>(prefs.order.includes(a.id) ? prefs.order.indexOf(a.id) : 1000+model.index.rooms.indexOf(a))-(prefs.order.includes(b.id) ? prefs.order.indexOf(b.id) : 1000+model.index.rooms.indexOf(b)));
  showModal('Pièces et appareils','Ordre, visibilité et noms dans Cockpit',`<form data-form="rooms" class="connection-form"><div class="room-preferences">${rooms.map(r=>`<div class="room-pref" data-room-pref="${esc(r.id)}"><label><input type="checkbox" name="visibleRoom" value="${esc(r.id)}" ${prefs.hidden[r.id] ? '' : 'checked'}>${esc(r.name)}</label><button type="button" class="button" data-action="room-order" data-id="${esc(r.id)}" data-step="-1" aria-label="Monter ${esc(r.name)}">↑</button><button type="button" class="button" data-action="room-order" data-id="${esc(r.id)}" data-step="1" aria-label="Descendre ${esc(r.name)}">↓</button></div>`).join('')}</div><details><summary>Noms des appareils</summary>${[...model.index.visible].map(id=>{const st=model.states.get(id);return `<label>${esc(st.attributes.friendly_name || id)}<input name="name:${esc(id)}" maxlength="80" value="${esc(prefs.names?.[id] || '')}" placeholder="Nom d’origine"></label>`;}).join('')}</details><button class="button primary">Enregistrer</button></form>`,'rooms',true);
}
function settings() {
  const theme = selectedTheme(), autofs = read('mb.autofs',false), bg = homeDisplay.bg, tabNames = {overview:'Mon bureau',home:'Pièces',news:'Veille',agents:'Agents',projects:'Projets',system:'Système'};
  const bgName = bg.image ? 'Photo' : bg.color ? 'Couleur' : (backgrounds.find(([id]) => id === bg.preset) || backgrounds[0])[1];
  const tag = (on, text) => `<span class="settings-status ${on ? 'is-on' : ''}">${text}</span>`;
  const device = `<section class="settings-card"><h3>Sur cet appareil</h3><div class="settings-list"><label class="settings-row"><span>Disposition</span><span class="settings-value settings-select"><select data-layout-profile aria-label="Disposition par écran">${Object.entries(profiles).map(([id,p]) => `<option value="${id}" ${profile === id ? 'selected' : ''}>${p[0]}</option>`).join('')}</select>${icon('down')}</span></label>${profile === 'phone' && !fullscreenSupported() ? '' : `<div class="settings-row"><span><span>Plein écran automatique</span><small>Le premier toucher passe en plein écran.</small></span><button class="settings-switch" role="switch" aria-checked="${autofs}" aria-label="Plein écran automatique" data-action="auto-fullscreen" ${fullscreenSupported() ? '' : 'disabled'}></button></div>`}${usesGrid(profile) ? `<button class="settings-row" data-action="background"><span>Fond d’écran</span><span class="settings-value">${esc(bgName)} ${icon('chevron')}</span></button><label class="settings-row"><span>Accent</span><span class="settings-value"><input id="home-accent" type="color" value="${esc(homeDisplay.accent)}" aria-label="Couleur d’accent par défaut"><span class="settings-dot" style="background:${esc(homeDisplay.accent)}"></span>${icon('chevron')}</span></label>` : ''}</div></section>`;
  const looks = `<section class="settings-card"><h3>Apparence</h3><p class="settings-help">Un seul look pour toute l’application. Seuls les couleurs, polices et fond changent.</p><div class="theme-options" role="group" aria-label="Thème de l’application">${[['feedme', 'Graphite', 'Cartes sombres · accent vert'], ['home', 'Verre', 'Fond à halos · réglable']].map(([id, title, description]) => `<button class="theme-option ${theme === id ? 'selected' : ''}" data-action="theme" data-id="${id}" aria-pressed="${theme === id}"><span class="theme-preview theme-preview-${id}" aria-hidden="true"><i></i><i></i><i></i></span><strong>${title}</strong><span>${description}</span>${theme === id ? `<em class="theme-check">${icon('check')}</em>` : ''}</button>`).join('')}</div>${theme === 'home' ? `<button class="button settings-pill" data-action="background">${icon('sun')} Couleurs et fond</button>` : ''}</section>`;
  const desktop = window.metaDesktop ? `<section class="settings-card"><h3>Fenêtre Windows</h3><p class="settings-help">Fermer la fenêtre la range dans la zone de notification. Les notifications des agents sont désactivées par défaut.</p><div class="settings-pills">${[['window','Fenêtre libre'],['dock-left','Panneau gauche'],['dock-right','Panneau droit'],['reserve','Ancrer / détacher du bureau'],['autohide','Masquage automatique'],['pin','Toujours au premier plan'],['notifications','Notifications des agents'],['quit','Quitter Cockpit']].map(([cmd,label])=>`<button class="button settings-pill" data-action="desktop" data-id="${cmd}">${label}</button>`).join('')}</div></section>` : '';
  const tabs = `<section class="settings-card"><h3>Onglets par écran</h3><p class="settings-help">Masquer un onglet conserve ses modules et ses données.</p><div class="tab-screen-settings"><table><thead><tr><th></th>${Object.values(profiles).map(p => `<th scope="col">${icon(p[1])}<span>${p[0]}</span></th>`).join('')}</tr></thead><tbody>${Object.keys(pages).map(id => `<tr><th scope="row">${esc(tabNames[id])}</th>${Object.entries(profiles).map(([screen,p]) => `<td><input type="checkbox" data-tab-screen="${screen}" data-tab-page="${id}" aria-label="${esc(tabNames[id])} · ${p[0]}" ${visibleTabs(screen).includes(id) ? 'checked' : ''} ${visibleTabs(screen).length === 1 && visibleTabs(screen).includes(id) ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table></div><button class="button settings-pill" data-action="edit">${icon('edit')} Personnaliser la disposition</button></section>`;
  const layout = `<section class="settings-card"><h3>Votre disposition</h3><p class="settings-help">Un agencement par écran. Dispositions, notes et tâches Cockpit sont synchronisées dans votre compte Home Assistant une fois connecté.</p><div class="settings-buttons"><button class="button settings-pill" data-action="export">${icon('download')} Exporter</button><label class="button settings-pill file-button">Importer<input type="file" id="import-layout" accept="application/json,.json" hidden></label><button class="button settings-pill" data-action="reset">Réinitialiser cette vue</button></div></section>`;
  const ha = `<section class="settings-card"><div class="settings-service"><span class="settings-service-icon">${icon('home')}</span><div><h4>Home Assistant</h4><p>Pièces, capteurs, éclairage, scènes.</p></div>${tag(sources.status.ha === 'connected', sources.demo ? 'Mode démo' : sources.status.ha === 'connected' ? 'Connecté' : 'Non connecté')}</div><form data-form="ha" class="settings-ha-form"><div class="settings-list"><label class="settings-field">Adresse<input name="url" type="url" required value="${esc(read('mb.ha.url', sources.suggestedHA || 'http://192.168.1.251:8123'))}" placeholder="http://homeassistant.local:8123"></label><label class="settings-field">Jeton d’accès longue durée<input name="token" type="password" ${read('mb.ha.token', null) ? '' : 'required'} autocomplete="off" placeholder="${read('mb.ha.token', null) ? 'Jeton enregistré sur cet appareil' : 'Collez votre jeton'}"></label><label class="settings-row"><span>Se souvenir du jeton</span><input class="settings-switch" name="remember" type="checkbox" role="switch" checked></label></div><p class="settings-help">Mémorisé, le jeton est aussi gardé par le serveur Cockpit (protégé par le mot de passe du site) : vos autres appareils se connectent sans le redemander. « Déconnecter » l’efface partout.</p><div class="settings-pills"><button type="button" class="button settings-pill" data-action="room-settings">Pièces et appareils</button><button type="button" class="button settings-pill" data-action="legacy-pages">Reprendre une page du dashboard</button></div><div class="form-status" role="status"></div><button class="button primary settings-cta" ${sources.demo ? 'disabled' : ''}>Connecter la maison ${icon('arrow')}</button>${sources.ha ? '<button type="button" class="button settings-pill" data-action="disconnect-ha">Déconnecter</button>' : ''}</form></section>`;
  const feeds = Array.isArray(sources.data.feeds) ? sources.data.feeds : null, feedError = sources.errors.feeds || sources.errors.articles || '';
  const rssCard = `<section class="settings-card"><div class="settings-service"><span class="settings-service-icon">${icon('rss')}</span><div><h4>Flux RSS</h4><p>La veille, lue directement par Cockpit.</p></div>${tag(!!feeds && !feedError, feeds ? `${feeds.length} flux` : 'Hors ligne')}</div>${feeds?.length ? `<div class="settings-list settings-feeds">${feeds.map(f => `<div class="settings-row"><span><span>${esc(f.title || f.url)}</span><small>${esc(f.error ? 'Illisible : ' + f.error : [f.category, f.count == null ? '' : f.count + ' articles'].filter(Boolean).join(' · '))}</small></span><button type="button" class="icon-button" data-action="feed-remove" data-id="${esc(f.url)}" aria-label="Retirer ${esc(f.title || f.url)}">${icon('close')}</button></div>`).join('')}</div>` : ''}<form data-form="feed-add" class="settings-feed-form"><input name="url" type="url" required placeholder="https://exemple.fr/feed" aria-label="Adresse du flux"><input name="category" maxlength="40" placeholder="Catégorie" aria-label="Catégorie"><button class="button settings-pill">${icon('plus')} Ajouter</button></form><p class="form-status" role="status">${esc(feedError)}</p></section>`;
  // Mode serveur : l'appareil reste connecté au site (cookie de 400 jours) jusqu'à ce bouton.
  const account = serverMode ? `<section class="settings-card"><h3>Accès au site</h3><p class="settings-help">Cet appareil reste connecté à Cockpit, y compris après une mise à jour.</p><form method="post" action="/logout"><button class="button settings-pill">Se déconnecter</button></form></section>` : '';
  showModal('Paramètres', 'Apparence, connexions et dispositions', `<div class="settings-grid"><div class="settings-col">${device}${looks}${desktop}${account}</div><div class="settings-col">${tabs}${rssCard}</div><div class="settings-col">${ha}${layout}</div></div>`, 'settings');
  modal.classList.add('settings-dialog');
}
function detail(widget) {
  detailId = widget.id;
  showModal(nativeTitle(widget.type), '', `<div class="detail-content tone-${modules[widget.type].tone || 'white'}">${widgetHTML(widget, true)}</div>`, 'detail', true);
}
function showModuleSettings(title, html, type) {
  showModal(title,'',html,type); modal.classList.add('module-settings-dialog');
}
function configure(widget) {
  const def = {...modules[widget.type]}, nativeDef=HD.Modules.types[{sensors:'sensor','ha-media':'media',cameras:'camera'}[widget.type] || widget.type], entities = nativeDef?.pick ? (sources.data.states || []).filter(nativeDef.pick) : (def.domains || []).flatMap(domain => sources.states(domain));
  if (widget.type === 'transit') def.directions=HD.Modules.transitDirections(entities,{states:roomModel(sources).states,index:roomModel(sources).index});
  if (widget.type === 'server') def.nodes=proxmoxModel(sources).nodes;
  showModuleSettings(widget.title || nativeTitle(widget.type), moduleSettingsHTML(widget,def,entities,usesGrid(profile),selectedTheme() === 'home' ? homeDisplay.accent : '#3dd68c',currentRoom(),roomModel(sources).rooms,{ phone: profile === 'phone' }),'module-config');
}
function backgroundSettings() {
  const bg = homeDisplay.bg;
  const halo = bg.halo || haloDefaults, pick = (id, label, value) => `<label class="halo-pick"><input type="color" id="${id}" value="${esc(value)}"><span class="halo-dot" style="background:${esc(value)}"></span><span>${label}</span></label>`;
  const colors = `<section class="settings-section halo-settings"><h3>Couleurs</h3><div class="halo-picks">${pick('home-accent','Accentuation',homeDisplay.accent)}</div><p class="settings-help">Fond « Halos » : la couleur de base et chacun des trois halos se règlent séparément.</p><div class="halo-picks">${haloParts.map(([k,label]) => pick('halo-'+k,label,halo[k] || haloDefaults[k])).join('')}</div><button class="button" data-action="halo-reset">Couleurs d’origine</button></section>`;
  showModal('Couleurs et fond', 'Personnalisez l’accent et le fond de Cockpit.', `${colors}<div class="bg-grid">${backgrounds.map(([id,title,css]) => `<button class="bg-swatch ${bg.preset === id && !bg.image && !bg.color ? 'is-on' : ''}" data-action="background-preset" data-id="${id}"><span class="bg-prev" style="background:${css}"></span><span>${title}</span></button>`).join('')}</div><form data-form="background" class="connection-form"><label>Couleur personnalisée<input type="color" name="color" value="${color(bg.color) || '#5e5049'}"></label><button class="button">Appliquer la couleur</button></form><div class="connection-form"><label>Photo personnelle<input type="file" id="background-image" accept="image/jpeg,image/png,image/webp"></label>${bg.image ? `<label>Assombrir la photo<input type="range" id="background-dim" min="0" max="80" value="${Math.round(bg.dim*100)}"></label>` : ''}</div>`, 'background');
}
function moduleColors(widget) {
  showModuleSettings('Couleurs · '+(widget.title || nativeTitle(widget.type)),colorSettingsHTML(widget,selectedTheme() === 'home' ? homeDisplay.accent : '#3dd68c'),'colors');
}
function headerSettings(item) {
  if (item.type === 'h-fullscreen') return;
  showModuleSettings(headerTypes[item.type] || item.title || nativeTitle(item.type),headerSettingsHTML(item),'header');
}
function chatView() {
  const conversations = sources.data.agents?.conversations || [];
  showModal('Agents', sources.demo ? 'Conversation de démonstration · aucun modèle n’est appelé.' : 'Conversations partagées avec Cockpit · un envoi transmet votre message à l’agent.', `<div class="chat-layout"><aside class="chat-sidebar"><span class="eyebrow">CONVERSATIONS</span>${sources.demo ? `<button class="chat-contact active"><span class="avatar av-0">A</span><span><b>Atlas</b><small>Démonstration</small></span></button>` : conversations.map(c => `<button class="chat-contact ${chat.id === c.id ? 'active' : ''}" data-action="conversation" data-id="${esc(c.id)}" ${chat.sending ? 'disabled' : ''}><span class="avatar av-0">${esc((c.title || 'A')[0])}</span><span><b>${esc(c.title || 'Conversation')}</b><small>${esc(c.preview?.slice(0, 45) || 'Ouvrir les messages')}</small></span></button>`).join('') || '<p class="settings-help">Créez votre première conversation dans Cockpit.</p>'}</aside><div class="chat-main"><div class="chat-messages" aria-live="polite">${chatMessages()}</div><form data-form="chat"><label class="sr-only" for="chat-message">Votre message</label><textarea id="chat-message" name="text" rows="2" maxlength="32000" placeholder="Une question, une idée, un coup de main…" ${chat.loading || chat.sending || (!sources.demo && !chat.id) ? 'disabled' : ''} required></textarea><button class="button primary" ${chat.loading || chat.sending || (!sources.demo && !chat.id) ? 'disabled' : ''} aria-label="Envoyer le message">${icon('arrow')}</button></form><span class="chat-hint">${sources.demo ? 'Un aperçu de l’expérience · réponses simulées' : 'Entrée pour une nouvelle ligne · bouton pour envoyer'}</span></div></div>`, 'chat', true);
}
function chatMessages() {
  return `${chat.loading ? '<p class="subtle">Lecture de la conversation…</p>' : ''}${chat.messages.length ? chat.messages.filter(m => m.content).map(m => `<div class="message ${m.role === 'user' ? 'user' : 'assistant'}"><span>${m.role === 'user' ? 'Vous' : 'Assistant'}</span><p>${esc(m.content)}</p></div>`).join('') : '<div class="chat-welcome">'+icon('chat')+'<h3>De quoi avez-vous envie aujourd’hui ?</h3><p>Ouvrez une conversation pour retrouver votre assistant.</p></div>'}${chat.error ? `<p class="chat-error" role="alert">${esc(chat.error)}</p>` : ''}${chat.sending ? '<p class="subtle">Réponse en cours…</p>' : ''}`;
}
function updateChat() { if (dialogType !== 'chat' || !modal.open) return; const el = modal.querySelector('.chat-messages'); el.innerHTML = chatMessages(); el.scrollTop = el.scrollHeight; }
async function selectConversation(id) {
  if (chat.sending) return;
  const revision = ++chat.revision; chat.id = id; chat.loading = true; chat.messages = []; chat.error = ''; chatView();
  try { const result = await sources.api('agents/conversations/' + encodeURIComponent(id)); if (revision === chat.revision) chat.messages = result.messages || []; }
  catch (e) { if (revision === chat.revision) chat.error = e.message; }
  finally { if (revision === chat.revision) { chat.loading = false; if (dialogType === 'chat' && modal.open) chatView(); } }
}
async function sendMessage(text) {
  if (chat.sending || chat.loading) return;
  chat.error = ''; chat.sending = true; chat.messages.push({ role: 'user', content: text });
  const answer = { role: 'assistant', content: '' }; chat.messages.push(answer); chatView();
  try {
      chat.controller = new AbortController();
      const response = await fetch('/api/feedme/agents/conversations/' + encodeURIComponent(chat.id) + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: chat.controller.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Envoi impossible.');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', ended = false;
      const consume = block => {
        const lines = block.split('\n'); const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (!raw) return;
        const payload = JSON.parse(raw);
        if (type === 'delta') answer.content += payload.text || '';
        if (type === 'replace') answer.content = payload.text || '';
        if (type === 'error') throw new Error(payload.error || payload.message || 'Réponse interrompue.');
        if (type === 'done') { ended = true; if (payload.status && payload.status !== 'complete') throw new Error('La réponse a été interrompue.'); }
        updateChat();
      };
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let split; while ((split = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, split)); buffer = buffer.slice(split + 2); }
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      if (!ended) throw new Error('Connexion interrompue avant la fin de la réponse.');
  } catch (e) { chat.error = e.name === 'AbortError' ? 'Réception interrompue.' : e.message; }
  finally { chat.sending = false; chat.controller = null; if (dialogType === 'chat' && modal.open) { chatView(); updateChat(); } else toast(chat.error || 'La réponse de votre agent est arrivée.'); }
}
function exportLayout() {
  const blob = new Blob([JSON.stringify({ version: 1, theme: selectedTheme(), tabs: tabPreferences, homeDisplay, feedmePreferences:feedmePreferences(), layouts, notes, todos }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'metaboard-mon-espace.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function action(button) {
  const id = button.dataset.id, widget = findWidget(id), act = button.dataset.action;
  switch (act) {
    case 'room': { if (!roomModel(sources).rooms.some(r=>r.id===id)) return; selectedRoomId=id; write('mb.room',id); page='home'; write('mb.page',page); render(true); break; }
    case 'page': editing = false; page = id; query = ''; write('mb.page', page); render(true); persist(); if (id === 'projects') projectsUI.enter(); else projectsUI.leave(); break;
    case 'profile': profile = id; write('mb.profile', profile); query = ''; render(true); persist(); toast(`Disposition ${profiles[profile][0].toLowerCase()} · enregistrée séparément`); break;
    case 'edit': if (dialogType === 'settings' && modal.open) modal.close(); editing = !editing; render(true); break;
    case 'library': library(); break;
    case 'category': libraryCategory = id; library(); break;
    case 'settings': settings(); break;
    case 'desktop': if (window.metaDesktop) { const state=await window.metaDesktop.command(id); toast('Fenêtre mise à jour · ancrage '+(state.reserved?'actif':'inactif')+' · notifications '+(state.notifications?'activées':'désactivées')); } break;
    case 'legacy-pages': {
      const keys=Object.keys(sources.originalLayout?.pages || {}).filter(key=>!key.startsWith('room:'));
      showModal('Reprendre une page Cockpit','Les pages originales restent conservées',`<form data-form="legacy-page" class="connection-form"><label>Page d’origine<select name="original">${keys.map(key=>`<option value="${esc(key)}">${esc(key)}</option>`).join('')}</select></label><label>Vue Cockpit à remplacer<select name="target">${Object.entries(pages).filter(([key])=>key!=='home').map(([key,value])=>`<option value="${key}">${esc(value[0])}</option>`).join('')}</select></label><p>Cette opération copie les modules et leurs réglages dans le profil ${profiles[profile][0]}.</p><button class="button primary" ${keys.length ? '' : 'disabled'}>Reprendre cette page</button></form>`,'legacy-pages'); break;
    }
    case 'room-settings': roomSettings(); break;
    case 'room-order': { const row=button.closest('[data-room-pref]'),before=Number(button.dataset.step)<0 ? row.previousElementSibling : row.nextElementSibling; if (before) row.parentElement.insertBefore(Number(button.dataset.step)<0 ? row : before, Number(button.dataset.step)<0 ? before : row); break; }
    case 'auto-fullscreen': write('mb.autofs',!read('mb.autofs',false)); settings(); break;
    case 'background': backgroundSettings(); break;
    case 'background-preset': if (backgrounds.some(p => p[0] === id)) { homeDisplay.bg = { preset: id, halo: homeDisplay.bg.halo }; saveDisplay(); render(true); backgroundSettings(); } break;
    case 'halo-reset': homeDisplay.accent = haloDefaults.h1; homeDisplay.bg = { preset: 'halo', halo: { ...haloDefaults } }; saveDisplay(); render(true); backgroundSettings(); break;
    case 'colors': if (widget) moduleColors(widget); break;
    case 'reset-colors': if (widget) { delete widget.accent; persist(); modal.close(); render(true); } break;
    case 'header-add': addHeader(id); render(true); toast('Élément ajouté à l’en-tête.'); break;
    case 'header-config': if (widget) headerSettings(widget); break;
    case 'header-remove': if (dialogType === 'header' && modal.open) modal.close(); homeDisplay.header = homeDisplay.header.filter(w => w.id !== id); persist(); render(true); break;
    case 'header-to-page': if (widget && !headerTypes[widget.type]) { homeDisplay.header = homeDisplay.header.filter(w => w.id !== id); delete widget.zone; current().push(widget); persist(); modal.close(); render(true); } break;
    case 'theme': if (['feedme', 'home'].includes(id)) { write('mb.theme', id); render(true); settings(); } break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'close-modal': modal.close(); break;
    case 'detail': if (widget) detail(widget); break;
    case 'configure': if (widget) configure(widget); break;
    case 'add': if (!Object.prototype.hasOwnProperty.call(modules, id)) return; if (current().length >= 40) return toast('Cette vue contient déjà 40 modules.'); current().push(newWidget(id)); persist(); render(true); button.innerHTML = icon('check') + ' Ajouté'; toast(`${modules[id].title} ajouté à votre vue ${profiles[profile][0].toLowerCase()}.`); break;
    case 'remove': if (dialogType === 'module-config' && modal.open) modal.close(); layouts[profile][layoutKey()] = current().filter(w => w.id !== id); persist(); render(true); break;
    case 'collapse': if (widget) { widget.collapsed = !widget.collapsed; persist(); render(true); } break;
    case 'height': if (widget) { widget.height = (widget.height || 2) % maxHeight(profile) + 1; persist(); render(true); } break;
    case 'rss-category': case 'rss-sort': { const w = current().find(w => w.id === button.dataset.widgetId); if (w) { if (act === 'rss-category') w.category = id; else w.sort = id; persist(); render(true); if (modal.open && dialogType === 'detail') detail(w); } break; }
    case 'favorite': favorites = favorites.includes(id) ? favorites.filter(k => k !== id) : [...favorites, id]; write('mb.favorites.v1', favorites); render(true); if (modal.open && dialogType === 'detail') { const w = current().find(w => w.id === detailId); if (w) detail(w); } break;
    case 'all-off': { const ids=roomModel(sources).index.visible, lights=sources.states('light').filter(st=>ids.has(st.entity_id) && st.state==='on'); if (lights.length) await sources.action('light','turn_off',lights.map(st=>st.entity_id)); break; }
    case 'room-lights': { const room = roomModel(sources).rooms.find(r=>r.id === id); if (!room) return; const lights = sources.states('light').filter(s => room.ids ? room.ids.includes(s.entity_id) : s.attributes.friendly_name === room.name); if (!lights.length) return toast('Aucune lumière dans cette pièce.'); await sources.action('light', room.lights ? 'turn_off' : 'turn_on', lights.map(s => s.entity_id)); break; }
    case 'disks': if (widget) { widget.showDisks = widget.showDisks === false; persist(); render(true); } break;
    case 'spotify-art': if (widget) { widget.bigArt = !widget.bigArt; persist(); render(true); } break;
    case 'spotify-settings': showModal('Spotify','Connexion gérée par Cockpit',`<p class="settings-help">${esc(sources.data.spotify?.device?.name || 'Aucun appareil actif.')} · ${sources.data.spotify?.connected ? 'Compte connecté' : 'Ouvrez Cockpit pour connecter ou reconnecter votre compte.'}</p><p class="settings-help">Les paroles, l’historique et le choix des appareils restent dans Cockpit pour cette version.</p><button class="button" data-action="open-music">Ouvrir Spotify</button>`,'spotify'); break;
    case 'spotify-toggle': case 'spotify-previous': case 'spotify-next': {
      const command = act === 'spotify-toggle' ? sources.data.spotify?.playing ? 'pause' : 'play' : act === 'spotify-next' ? 'next' : 'previous';
      await sources.api('spotify/command/'+command,{method:'POST',body:'{}'}); await sources.refresh(); break;
    }
    case 'rss-options': if (widget) showModal('Présentation des articles','Réglages propres à ce module',`<form data-form="rss-options" data-id="${esc(widget.id)}" class="connection-form"><label><input type="checkbox" name="descriptions" ${widget.descriptions !== false ? 'checked' : ''}> Afficher les descriptions</label><button class="button primary">Enregistrer</button></form><p class="settings-help">${hiddenSources.length} source(s) masquée(s) dans ce navigateur.</p><button class="button" data-action="restore-sources">Réafficher toutes les sources</button>`,'rss-options'); break;
    case 'restore-sources': hiddenSources=[]; write('mb.hidden-sources.v1',hiddenSources); modal.close(); render(true); break;
    case 'rss-saved': if (widget) { widget.category = widget.category === '__saved' ? '' : '__saved'; persist(); render(true); if (modal.open && dialogType === 'detail') detail(widget); } break;
    case 'save-article': savedArticles = savedArticles.includes(id) ? savedArticles.filter(k=>k!==id) : [...savedArticles,id]; write('mb.saved.v1',savedArticles); render(true); toast('Articles enregistrés accessibles par le bouton de grille près de la recherche.'); break;
    case 'hide-source': { const a = sources.data.articles?.find(a=>a.id===id); if (a) { hiddenSources=[...new Set([...hiddenSources,a.source])]; write('mb.hidden-sources.v1',hiddenSources); render(true); toast('Source masquée. Vous pouvez la réafficher dans les réglages du module RSS.'); } break; }
    case 'copy-article': { const a = sources.data.articles?.find(a=>a.id===id); if (!a?.link) return toast('Cet article de démonstration n’a pas de lien.'); const url=safeUrl(a.link); if (url === '#') return; if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url); else { const input=document.createElement('textarea'); input.value=url; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); } toast('Lien copié.'); break; }
    case 'open-music': { const url = safeUrl(sources.data.spotify?.track?.url || 'https://open.spotify.com/'); window.open(url, '_blank', 'noopener,noreferrer'); break; }
    case 'resize': if (widget) { widget.size = { normal: 'wide', wide: 'full', full: 'normal' }[widget.size]; persist(); render(true); } break;
    case 'move-up': case 'move-down': { const list = current(), index = list.findIndex(w => w.id === id), target = index + (act === 'move-up' ? -1 : 1); if (index >= 0 && target >= 0 && target < list.length) { [list[index], list[target]] = [list[target], list[index]]; persist(); render(true); document.querySelector(`[data-widget="${CSS.escape(id)}"] button[data-action="${act}"]`)?.focus(); } break; }
    case 'feed-remove': try { sources.data.feeds = await sources.api('feeds',{method:'DELETE',body:JSON.stringify({url:id})}); sources.data.articles = await sources.api('articles'); sources.emit(); settings(); toast('Flux retiré.'); } catch (e) { toast(e.message); } break;
    case 'refresh': await sources.refresh(); if (sources.demo) toast('Les données de démonstration sont déjà disponibles.'); break;
    case 'connect-ha-session': {
      write('mb.ha.autologin', true);
      const provider = await HD.Auth.init(true);
      if (provider) { await sources.connectHA(provider.hassUrl, provider); toast('La session Home Assistant est connectée.'); settings(); }
      else HD.Auth.login();
      break;
    }
    case 'disconnect-ha': write('mb.ha.autologin', false); write('mb.ha.token', null); haSession('DELETE'); sources.disconnectHA(); sources.data.states = []; sources.data.rooms = []; sources.data.haCalendar = []; sources.emit(); settings(); break;
    case 'toggle-light': await sources.action('light', 'toggle', id); break;
    case 'toggle-device': { const domain = id.split('.')[0]; if (!['switch', 'input_boolean', 'fan', 'automation'].includes(domain)) return; await sources.action(domain, 'toggle', id); break; }
    case 'run-script': if (id.startsWith('script.')) { await sources.action('script', 'turn_on', id); toast(sources.demo ? 'Script simulé.' : 'Script demandé à Home Assistant.'); } break;
    case 'scene': await sources.action('scene', 'turn_on', id); toast(sources.demo ? 'Ambiance simulée.' : 'Scène demandée à Home Assistant.'); break;
    case 'temp': { const s = sources.states('climate').find(s => s.entity_id === id), t = Number(s?.attributes.temperature); if (!Number.isFinite(t)) throw new Error('Consigne indisponible.'); await sources.action('climate', 'set_temperature', id, { temperature: t + Number(button.dataset.step) }); break; }
    case 'chat': if (chat.messages.length && chat.id) chatView(); else if (sources.data.agents?.conversations?.[0]) await selectConversation(sources.data.agents.conversations[0].id); else chatView(); break;
    case 'conversation': await selectConversation(id); break;
    case 'article': { const a = sources.data.articles?.find(a => a.id === id); if (!a) return; if (!readArticles.includes(id)) { readArticles.push(id); write('mb.read.v1',readArticles.slice(-5000)); render(true); } showModal(a.title, `${a.source} · ${a.category || 'Veille'}${a.demo ? ' · article fictif de démonstration' : ''}`, `<p class="article-description">${esc((a.description || '').replace(/<[^>]*>/g, ''))}</p>${a.link ? `<a class="button primary" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(a.link))}">Lire sur le site ${icon('arrow')}</a>` : '<p class="settings-help">Ce contenu illustre la présentation des articles. Connectez Cockpit pour retrouver vos vrais flux.</p>'}`, 'article'); break; }
    case 'board': { const b = sources.data.boards?.find(b => b.id === id); if (b) showModal(b.name, 'Votre collection Cockpit', `<div class="board-detail">${(b.items || []).map(a => `<article><h3>${esc(a.title)}</h3>${a.notes ? `<p>${esc(a.notes)}</p>` : ''}${a.link ? `<a class="text-button" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer">Lire l’article ${icon('arrow')}</a>` : ''}</article>`).join('') || '<p>Cette collection est vide.</p>'}</div>`, 'board'); break; }
    case 'export': exportLayout(); break;
    case 'todo-clear': todos = todos.filter(t => !t.done); write('mb.todos.v1', todos); syncAccount(); render(true); if (dialogType === 'detail' && modal.open) { const w = current().find(w => w.id === detailId); if (w) detail(w); } break;
    case 'ha-todo-clear': { if (!sources.states('todo').some(s => s.entity_id === id)) return; await sources.action('todo', 'remove_completed_items', id); const slot = sources.todoCache?.[id]; if (slot) { slot.items = await sources.ha.listTodo(id); sources.emit(); } break; }
    case 'copy-todos': {
      const incoming = sources.data.todos;
      if (!Array.isArray(incoming)) return toast('Les tâches Cockpit ne sont pas disponibles.');
      const known = new Set(todos.map(t => t.title.toLowerCase())); let added = 0;
      for (const t of incoming) if (typeof t.title === 'string' && !known.has(t.title.toLowerCase())) { todos.push({ id: uid(), title: t.title.slice(0, 200), done: !!t.done }); known.add(t.title.toLowerCase()); added++; }
      write('mb.todos.v1', todos); syncAccount(); render(true); toast(`${added} tâche(s) copiée(s) dans le prototype.`); break;
    }
    case 'reset': if (confirm('Réinitialiser uniquement cette page dans cette disposition ? Vos autres vues sont conservées.')) {
      const oldNotes = current().filter(w => w.type === 'notes' && notes[w.id]).map(w => notes[w.id]);
      delete layouts[profile][layoutKey()];
      if (oldNotes.length) {
        let noteWidgets = current().filter(w => w.type === 'notes');
        while (noteWidgets.length < oldNotes.length) { const w = newWidget('notes'); current().push(w); noteWidgets.push(w); }
        oldNotes.forEach((text, i) => notes[noteWidgets[i].id] = text); write('mb.notes.v1', notes);
      }
      persist(); render(true); modal.close();
    } break;
  }
}
document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (!button || button.disabled || button.tagName === 'INPUT') return; event.preventDefault(); action(button).catch(e => toast(e.message)); });
document.addEventListener('click', event => {
  const choice = event.target.closest('button[data-setting]');
  if (!choice || !choice.closest('.visual-settings-form')) return;
  event.preventDefault(); updateSettingControl(choice.closest('form'),choice.dataset.setting,choice.dataset.value);
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.matches('[name=entities]')) { const automatic=el.closest('form')?.querySelector('[name=automatic]'); if (automatic) automatic.checked=false; }
  if (el.dataset.settingColor && el.closest('.visual-settings-form')) updateSettingControl(el.closest('form'),el.dataset.settingColor,el.value);
  // Couleurs et fond : aperçu immédiat pendant le choix, enregistré à la validation (« change »).
  if ((el.id === 'home-accent' || el.id?.startsWith('halo-')) && color(el.value)) {
    if (el.id === 'home-accent') homeDisplay.accent = el.value;
    else { const b = homeDisplay.bg; if (b.image || b.color || b.preset !== 'halo') homeDisplay.bg = { preset: 'halo', halo: b.halo }; homeDisplay.bg.halo = { ...haloDefaults, ...homeDisplay.bg.halo, [el.id.slice(5)]: el.value }; }
    el.nextElementSibling.style.background = el.value; applyDisplay(selectedTheme() === 'home');
  }
  if (el.id === 'global-search') { query = el.value; render(true); }
  if (el.id === 'detail-search') { query = el.value; const widget = current().find(w => w.id === detailId); if (widget) { modal.querySelector('.detail-content').innerHTML = widgetHTML(widget, true); const input = modal.querySelector('#detail-search'); input?.focus(); input?.setSelectionRange(query.length, query.length); } }
  if (el.id === 'library-search') { const q = el.value.toLowerCase(); modal.querySelectorAll('.library-item').forEach(item => item.hidden = !item.dataset.search.includes(q)); }
  if (el.dataset.note) { syncAccount(); const footer=el.parentElement.querySelector('.note-foot span'); if (footer) footer.textContent=el.value.split('\n').filter(l=>l.trim()).length+' ligne(s) · '+el.value.length+' caractère(s)'; notes[el.dataset.note] = el.value; if (!write('mb.notes.v1', notes)) toast('La note ne peut pas être enregistrée.'); }
});
document.addEventListener('change', async event => {
  const el = event.target;
  if (el.matches('[name=entities]')) { const automatic=el.closest('form')?.querySelector('[name=automatic]'); if (automatic) automatic.checked=false; }
  if (el.dataset.settingColor && el.closest('.visual-settings-form')) updateSettingControl(el.closest('form'),el.dataset.settingColor,el.value);
  if (el.matches('[data-spotify-volume]')) { const volume=Math.max(0,Math.min(100,Number(el.value))); try { if (sources.demo) { sources.data.spotify.device.volume=volume; } else await sources.api('spotify/volume',{method:'POST',body:JSON.stringify({volume})}); } catch(e) { toast(e.message); } }
  if (el.dataset.haTodo) { try { await sources.action('todo','update_item',el.dataset.haTodo,{item:el.dataset.item,status:el.checked ? 'completed' : 'needs_action'}); const slot=sources.todoCache?.[el.dataset.haTodo]; if (slot) { slot.items=await sources.ha.listTodo(el.dataset.haTodo); sources.emit(); } } catch(e) { el.checked=!el.checked; toast(e.message); } }
  if (el.dataset.tabScreen) { syncAccount(); const screen = el.dataset.tabScreen, id = el.dataset.tabPage; const ids = el.checked ? [...visibleTabs(screen),id] : visibleTabs(screen).filter(p => p !== id); if (!setTabs(screen,ids)) toast('Gardez au moins un onglet visible.'); render(true); settings(); }
  if (el.matches('[data-layout-profile]') && profiles[el.value]) { profile = el.value; write('mb.profile', profile); render(true); persist(); }
  if (el.id === 'home-accent') { homeDisplay.accent = color(el.value) || haloDefaults.h1; saveDisplay(); render(true); }
  if (el.id?.startsWith('halo-') && color(el.value)) { saveDisplay(); render(true); }
  if (el.id === 'background-dim') { homeDisplay.bg.dim = Number(el.value)/100; saveDisplay(); applyDisplay(selectedTheme() === 'home'); }
  if (el.id === 'background-image' && el.files?.[0]) {
    try {
      const file = el.files[0]; if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 12000000) throw new Error('Choisissez une image JPEG, PNG ou WebP de moins de 12 Mo.');
      const image = new Image(), url = URL.createObjectURL(file);
      image.onload = () => { try { const canvas = document.createElement('canvas'), ratio = Math.min(1,1920/image.width); canvas.width = Math.round(image.width*ratio); canvas.height = Math.round(image.height*ratio); canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height); const data = canvas.toDataURL('image/jpeg',.75); if (data.length > 1500000) throw new Error('Cette photo est trop volumineuse.'); const previous = homeDisplay.bg; homeDisplay.bg = { image: data, dim: .35, halo: homeDisplay.bg.halo }; if (!saveDisplay()) { homeDisplay.bg = previous; throw new Error('Le navigateur ne peut pas conserver la photo.'); } render(true); backgroundSettings(); } catch (e) { toast(e.message); } finally { URL.revokeObjectURL(url); } };
      image.onerror = () => { URL.revokeObjectURL(url); toast('Cette photo ne peut pas être ouverte.'); }; image.src = url;
    } catch (e) { toast(e.message); }
  }
  if (el.dataset.action === 'todo-check') { const t = todos.find(t => t.id === el.dataset.id); if (t) { t.done = el.checked; write('mb.todos.v1', todos); syncAccount(); render(true); if (dialogType === 'detail' && modal.open) { const w = current().find(w => w.id === detailId); if (w) detail(w); } } }
  if (el.id === 'import-layout' && el.files?.[0]) {
    try {
      if (el.files[0].size > 2000000) throw new Error('Le fichier est trop volumineux.');
      const data = JSON.parse(await el.files[0].text()); if (data.version !== 1 || !data.layouts) throw new Error('Ce fichier n’est pas un export Cockpit.');
      const imported = cleanLayouts(data.layouts); if (!Object.keys(imported).length) throw new Error('Aucune disposition valide dans ce fichier.');
      if (!confirm('Remplacer les dispositions, notes et tâches locales par cet export ?')) return;
      layouts = imported; notes = {};
      if (data.feedmePreferences) importFeedmePreferences(data.feedmePreferences);
      if (data.homeDisplay) importDisplay(data.homeDisplay);
      if (data.tabs) importTabs(data.tabs);
      if (['feedme', 'home'].includes(data.theme)) write('mb.theme', data.theme);
      for (const [k, v] of Object.entries(data.notes || {})) if (/^[\w-]{1,80}$/.test(k) && typeof v === 'string') notes[k] = v.slice(0, 20000);
      todos = Array.isArray(data.todos) ? data.todos.filter(t => typeof t?.title === 'string').slice(0, 1000).map(t => ({ id: uid(), title: t.title.slice(0, 200), done: !!t.done })) : [];
      persist(); write('mb.notes.v1', notes); write('mb.todos.v1', todos); syncAccount(); modal.close(); render(true); toast('Votre espace a été importé.');
    } catch (e) { toast(e.message); }
  }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]'); if (!form) return; event.preventDefault(); const fd = new FormData(form);
  try {
    if (form.dataset.form === 'legacy-page') { const target=String(fd.get('target')),original=String(fd.get('original')); if (!pages[target] || target==='home') throw Error('Vue invalide.'); const widgets=importedPageWidgets(sources,original,profile); if (!widgets) throw Error('Page introuvable.'); if (!confirm('Remplacer cette vue Cockpit par la page originale choisie ?')) return; layouts[profile] ||= {}; layouts[profile][target]=widgets; for (const w of widgets) if (w.importedNote != null) {notes[w.id]=w.importedNote;delete w.importedNote;} write('mb.notes.v1',notes);page=target;write('mb.page',page);persist();modal.close();render(true); }
    if (form.dataset.form === 'ha-todo') { await sources.action('todo','add_item',form.dataset.entity,{item:String(fd.get('title')).trim()}); form.reset(); const state=sources.states('todo').find(s=>s.entity_id===form.dataset.entity); if (state && sources.todoCache?.[state.entity_id]) { const items=await sources.ha.listTodo(state.entity_id); sources.todoCache[state.entity_id].items=items; sources.emit(); } }
    if (form.dataset.form === 'rooms') { const order=[...form.querySelectorAll('[data-room-pref]')].map(e=>e.dataset.roomPref),visible=fd.getAll('visibleRoom'),hidden=Object.fromEntries(order.map(id=>[id,!visible.includes(id)])),names=Object.fromEntries([...fd].filter(([k,v])=>k.startsWith('name:') && String(v).trim()).map(([k,v])=>[k.slice(5),String(v).trim().slice(0,80)])); sources.roomPreferences={order,hidden,names}; write('mb.rooms.v1',sources.roomPreferences); syncAccount(); modal.close(); sources.emit(); }
    if (form.dataset.form === 'todo') { const title = String(fd.get('title')).trim(); if (!title) return; todos.push({ id: uid(), title: title.slice(0, 200), done: false }); write('mb.todos.v1', todos); syncAccount(); form.reset(); render(true); if (modal.open && dialogType === 'detail') { const w = current().find(w => w.id === detailId); if (w) detail(w); } }
    if (form.dataset.form === 'configure') { const w = findWidget(form.dataset.id); if (!w) return; if (w.type === 'system') w.metrics = fd.getAll('metric').filter(k=>['cpu','ram','gpu','vram'].includes(k)); if (fd.has('accent')) w.accent = color(fd.get('accent')); if (fd.has('title')) w.title = String(fd.get('title')).trim().slice(0,80); if (fd.has('width')) { w.width = Math.max(1,Math.min(4,Number(fd.get('width')) || 1)); w.size = w.width >= 4 ? 'full' : w.width >= 2 ? 'wide' : 'normal'; } if (fd.has('size')) w.size = String(fd.get('size')); commitEntityChoice(w,fd); w.options ||= {}; for (const k of ['group','view','mode','fit','direction','device','kind']) if (fd.has(k)) w.options[k]=String(fd.get(k)); for (const k of ['tLo','tHi','tHot','days']) if (fd.has(k) && Number.isFinite(Number(fd.get(k)))) w.options[k]=Number(fd.get(k)); if (form.querySelector('[name=tempColors]')) w.options.tempColors=fd.has('tempColors'); if (form.querySelector('[name=traffic]')) w.options.traffic=fd.has('traffic'); if (fd.has('roomPicker')) w.options.rooms=fd.getAll('rooms'); if (fd.has('scope')) w.scope=fd.get('scope') === 'all' ? 'all' : 'room'; if (fd.has('height')) w.height = Math.max(1,Math.min(maxHeight(profile),Math.round(Number(fd.get('height'))) || 2)); persist(); modal.close(); render(true); }
    if (form.dataset.form === 'rss-options') { const w=findWidget(form.dataset.id); if (w) { w.descriptions=fd.has('descriptions'); persist(); modal.close(); render(true); } }
    if (form.dataset.form === 'background') { homeDisplay.bg = { color: color(fd.get('color')), halo: homeDisplay.bg.halo }; saveDisplay(); render(true); backgroundSettings(); }
    if (form.dataset.form === 'colors') { const w = findWidget(form.dataset.id); if (w) { w.accent = color(fd.get('accent')); persist(); modal.close(); render(true); } }
    if (form.dataset.form === 'header') { const w = homeDisplay.header.find(m => m.id === form.dataset.id); if (w) { w.zone = String(fd.get('zone')); w.options = {...w.options,...Object.fromEntries(['fmt','hSize','hFont','hColor'].map(k => [k,String(fd.get(k) || '')]))}; importDisplay(homeDisplay); modal.close(); render(true); } }
    if (form.dataset.form === 'feed-add') { const button = form.querySelector('button'); button.disabled = true; try { sources.data.feeds = await sources.api('feeds',{method:'POST',body:JSON.stringify({url:String(fd.get('url')).trim(),category:String(fd.get('category')).trim()})}); sources.data.articles = await sources.api('articles'); delete sources.errors.feeds; sources.emit(); settings(); toast('Flux ajouté.'); } finally { if (button.isConnected) button.disabled = false; } }
    if (form.dataset.form === 'chat') { const text = String(fd.get('text')).trim(); if (text) await sendMessage(text); }
    if (form.dataset.form === 'ha') {
      const button = form.querySelector('button[type="submit"],button:not([type])'), status = form.querySelector('.form-status'); button.disabled = true; status.textContent = 'Connexion à votre maison…';
      const token = String(fd.get('token')).trim() || read('mb.ha.token', ''); try { await sources.connectHA(String(fd.get('url')), token); write('mb.ha.token', fd.get('remember') ? token : null); write('mb.ha.autologin', true); if (fd.get('remember')) haSession('PUT', { url: read('mb.ha.url', String(fd.get('url'))), token }); if (form.isConnected) { form.elements.token.value = ''; status.textContent = 'Connexion établie. Les appareils se chargent…'; } toast('Home Assistant est connecté.'); }
      catch (e) { if (form.isConnected) status.textContent = e.message; }
      finally { if (button.isConnected) button.disabled = false; }
    }
  } catch (e) { toast(e.message); }
});
$app.addEventListener('dragstart', event => { if (usesGrid(profile) || !editing || event.target.closest('input,textarea,button')) { event.preventDefault(); return; } const card = event.target.closest('[data-widget]'); if (!card) return; dragged = card.dataset.widget; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragged); card.classList.add('dragging'); });
$app.addEventListener('dragover', event => { if (!dragged) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); event.target.closest('[data-widget]')?.classList.add('drop-target'); });
$app.addEventListener('drop', event => { event.preventDefault(); const target = event.target.closest('[data-widget]')?.dataset.widget, list = current(), from = list.findIndex(w => w.id === dragged), to = list.findIndex(w => w.id === target); if (from >= 0 && to >= 0) { const [w] = list.splice(from, 1); list.splice(to, 0, w); persist(); } dragged = null; render(true); });
$app.addEventListener('dragend', () => { dragged = null; document.querySelectorAll('.dragging,.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target')); });
document.addEventListener('focusout', () => { if (pendingRender) setTimeout(() => { if (pendingRender) render(); }, 0); });
document.addEventListener('keydown', event => { if ((event.key === '/' || (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey))) && !modal.open && !event.target.matches('input,textarea,select')) { event.preventDefault(); document.querySelector('#global-search')?.focus(); } });
modal.addEventListener('click', event => { if (event.target === modal) { const r = modal.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close(); } });
modal.addEventListener('close', () => { dialogType = ''; lastFocus?.isConnected && lastFocus.focus(); });
sources.addEventListener('change', () => { render(); if (modal.open && dialogType === 'detail' && !modal.contains(document.activeElement.closest?.('input,textarea,select'))) { const w = current().find(w => w.id === detailId); if (w) modal.querySelector('.detail-content').innerHTML = widgetHTML(w, true); } });
homeEditor = attachHomeEditor({ root: $app, isEditing: () => editing, isHome: () => usesGrid(profile), maxHeight: () => maxHeight(profile), getWidgets: current, getHeaderItems: () => homeDisplay.header, persist, render, toast });
render(); window.MB_BOOT?.ready(); if (!sources.demo) sources.refresh(); if (page === 'projects') projectsUI.enter();
if (window.parent !== window && params.get('surface') === 'compact') window.parent.postMessage({ type: 'metaboard:ready' }, '*');
// Connexion Home Assistant mémorisée par le serveur Cockpit (partagée par tous les appareils) ; sans serveur (export statique), rien.
async function haSession(method, body) {
  try {
    const response = await fetch('/api/ha-session', { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return response.ok && /json/.test(response.headers.get('content-type') || '') ? await response.json() : null;
  } catch { return null; }
}
// Un téléphone resté sur une autre disposition : on indique une fois où choisir « Téléphone ».
if (isPhoneScreen() && profile !== 'phone' && !params.get('surface') && !read('mb.phone.hint', false)) { write('mb.phone.hint', true); setTimeout(() => toast('Disposition Téléphone disponible : Paramètres › Affichage sur cet appareil.'), 1500); }
if (HD.Auth?.servedByHA() && read('mb.ha.autologin', true)) HD.Auth.init(true).then(provider => provider && sources.connectHA(provider.hassUrl, provider)).catch(e => toast(e.message));
else if (!sources.demo && read('mb.ha.token', null) && read('mb.ha.autologin', true)) sources.connectHA(read('mb.ha.url', sources.suggestedHA || ''), read('mb.ha.token', '')).then(() => haSession('PUT', { url: read('mb.ha.url', ''), token: read('mb.ha.token', '') })).catch(e => toast(e.message));
// Nouvel appareil ou appli réinstallée : reprend la connexion mémorisée par le serveur Cockpit au lieu de redemander un jeton.
else if (!sources.demo && read('mb.ha.autologin', true)) haSession('GET').then(saved => { if (!saved?.token || !saved.url || sources.ha) return; write('mb.ha.token', saved.token); return sources.connectHA(saved.url, saved.token); }).catch(e => toast(e.message));
setInterval(() => { if (!document.hidden) sources.refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !sources.demo) { sources.ha?.retryNow(); sources.refresh(); } });

$app.addEventListener('dblclick', event => { const head = event.target.closest('.widget-head'); if (head && !event.target.closest('button')) { const w = current().find(w => w.id === head.closest('[data-widget]').dataset.widget); if (w) { w.collapsed = !w.collapsed; persist(); render(true); } } });
const advancedHA=haActions({sources,showModal,toast,opened:widget=>{detailId=widget.id;}});
async function originalControl(element) {
  if (editing) return;
  const widget = findWidget(element.closest('[data-widget]')?.dataset.widget || detailId);
  if (!widget) return;
  const act = element.dataset.act, arg = element.dataset.arg;
  const nativeDef=HD.Modules.types[{sensors:'sensor','ha-media':'media',spotify:'media'}[widget.type] || widget.type];
  const pick=widget.entity || Array.isArray(widget.entities) ? nativeDef?.pick : nativeDef?.auto || nativeDef?.pick;
  const pool=widget.type === 'spotify' ? spotifyStatesForWidget(sources,widget,currentRoom()) : statesForWidget(sources,widget,currentRoom()).filter(pick || (()=>true));
  const selected = domain => pool.filter(s=>s.entity_id.startsWith(domain+'.'));
  if (await advancedHA(element,widget,pool)) return;
  if (act === 'temp') {
    const state = selected('climate')[0], value = Number(state?.attributes.temperature);
    if (state && Number.isFinite(value)) await sources.action('climate', 'set_temperature', state.entity_id, { temperature: value + Number(arg) });
  } else if (act === 'mode') {
    const state = selected('climate')[0]; if (state) await sources.action('climate', 'set_hvac_mode', state.entity_id, { hvac_mode: arg });
  } else if (act === 'lights-toggle' || act === 'bri' || act === 'tone') {
    const ids = selected('light').map(s => s.entity_id); if (!ids.length) return;
    if (act === 'lights-toggle') await sources.action('light', selected('light').some(s => s.state === 'on') ? 'turn_off' : 'turn_on', ids);
    else if (act === 'bri') await sources.action('light', 'turn_on', ids, { brightness_pct: Number(element.value) });
    else { const tone = HD.Modules.TONES.find(t => t.id === arg); if (tone) await sources.action('light', 'turn_on', ids, tone.kelvin ? { color_temp_kelvin: tone.kelvin } : { rgb_color: tone.rgb }); }
  } else if (act === 'scene' || act === 'script' || act === 'auto-toggle') {
    const domain = act === 'scene' ? 'scene' : act === 'script' ? 'script' : 'automation';
    if (pool.some(s=>s.entity_id===arg) && arg?.startsWith(domain + '.')) await sources.action(domain, act === 'auto-toggle' ? 'toggle' : 'turn_on', arg);
  } else if (act === 'dev') {
    const state=pool.find(s=>s.entity_id===arg); if (!state) return;
    const command=HD.Model.describe(state,currentRoom()?.name).action;
    if (command) await sources.action(command[0],command[1],arg);
  } else if (act === 'mod-config') configure(widget);
  else if (act === 'event-open') {
    const index = Number(arg?.split('|').pop()), key=arg?.split('|')[0], ev=(sources.moduleEvents?.[key] || nativeEvents(context(widget, true)))[index];
    if (ev) showModal(ev.title, ev.start.toLocaleString('fr-FR'), `<p class="article-description">${esc(ev.description || ev.location || ev.calName || '')}</p>`, 'event');
  } else if (act === 'weather-open') detail(widget);
  else if (act === 'media-cmd' || act === 'media-vol' || act === 'media-source') {
    const state = selected('media_player')[0]; if (!state) return;
    const service = { play_pause: 'media_play_pause', prev: 'media_previous_track', next: 'media_next_track' }[arg];
    if (act === 'media-source') await sources.action('media_player','select_source',state.entity_id,{source:element.value});
    else if (act === 'media-vol') await sources.action('media_player', 'volume_set', state.entity_id, { volume_level: Number(element.value) / 100 });
    else if (arg === 'shuffle') await sources.action('media_player','shuffle_set',state.entity_id,{shuffle:!state.attributes.shuffle});
    else if (arg === 'repeat') await sources.action('media_player','repeat_set',state.entity_id,{repeat:({off:'all',all:'one',one:'off'})[state.attributes.repeat || 'off'] || 'off'});
    else if (service) await sources.action('media_player', service, state.entity_id);
    else toast('Ce réglage reste dans Cockpit.');
  }
}
document.addEventListener('click', event => { const el = event.target.closest('[data-act]:not(input):not(select):not(textarea)'); if (!el || el.disabled || el.dataset.action) return; event.preventDefault(); originalControl(el).catch(e => toast(e.message)); });
document.addEventListener('change', event => { if (event.target.matches('input[data-act],select[data-act]')) originalControl(event.target).catch(e => toast(e.message)); });
setInterval(() => { const now = new Date(); document.querySelectorAll('[data-system-clock]').forEach(el => el.textContent=now.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'}).replace('/','.')+' · '+now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})); document.querySelectorAll('[data-home-clock]').forEach(el => el.textContent = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',...(el.dataset.homeClock === 's' ? {second:'2-digit'} : {})})); document.querySelectorAll('[data-clock]').forEach(el => el.textContent = now.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})); }, 1000);

setInterval(()=>{ if (!document.hidden && current().some(w=>w.type === 'cameras' && w.options?.mode === 'still')) render(); },10000);
document.addEventListener('keydown',event=>{ if (['Enter',' '].includes(event.key) && event.target.matches('[role=button][data-act]')) { event.preventDefault(); originalControl(event.target).catch(e=>toast(e.message)); } });

window.addEventListener('storage',event=>{ if (event.key && (/^mb\.feedme\.widget:/.test(event.key) || ['fm-read','fm-favorites','fm-hidden-sources'].includes(event.key))) {syncAccount();render();} });

window.metaDesktop?.onSurface(surface=>{ if (surface==='agents') {page='agents';if (!visibleTabs(profile).includes('agents')) setTabs(profile,[...visibleTabs(profile),'agents']);} else if (profiles[surface]) {profile=surface;write('mb.profile',profile);}render(true); });

window.addEventListener('mb:display-saved',()=>syncAccount());
