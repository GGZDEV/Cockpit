// Markup and component renderers from the two original applications.
// Their stylesheets are copied unchanged into public/design/.
import { proxmoxModel } from './proxmox.js';
import { feedmeComponent } from './feedme-components.js';
import { roomModel, statesForWidget, spotifyStatesForWidget } from './rooms.js';
import { esc, icon, num, safeUrl, spark } from './core.js';

const labels = { 'ha-todos':'Courses', 'feedme-weather':'Météo par ville', temperature:'Température', 'ha-media':'Spotify / musique', system: 'Système', quotas: 'Quotas IA', spotify: 'Spotify', rss: 'Flux RSS', weather: 'Météo', rooms: 'Pièces', todos: 'Courses', notes: 'Notes', calendar: 'Agenda', agents: 'Agents', lights: 'Éclairage', climate: 'Thermostat', energy: 'Énergie', scenes: 'Scènes', sensors: 'Capteurs', server: 'Serveur Proxmox', updates: 'Mises à jour', boards: 'Boards', transit: 'Départs RER', cameras: 'Caméra', devices: 'Appareils', automations: 'Automatisations', guests: 'VM et conteneurs' };
export const nativeTitle = type => labels[type] || type;
const name = st => st.attributes.friendly_name || st.entity_id;
const duration = ms => `${Math.floor((ms || 0) / 60000)}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
const selected = (c,list) => { const ids=new Set(statesForWidget(c.sources,c.widget,c.room).map(s=>s.entity_id)); return list.filter(s=>ids.has(s.entity_id)); };
function empty(text) { return `<div class="empty compact mod-empty">${icon('link')}<p>${esc(text)}</p><button class="button btn-glass" data-action="settings">Connexions</button></div>`; }
function head(title, meta = '') { return `<div class="mod-head"><h2>${esc(title)}</h2><span class="muted small">${meta}</span></div>`; }
function rawEvents(c) {
  return [...(c.sources.data.calendar?.events || []), ...(c.sources.data.haCalendar || [])].map(e => ({
    ...e, title: e.title || e.summary, start: new Date(typeof e.start === 'object' ? e.start.dateTime || e.start.date : e.start), end: new Date(typeof e.end === 'object' ? e.end.dateTime || e.end.date : e.end), color: '#FF9F0A', calName: e.calendar || 'Calendrier'
  })).filter(e => !Number.isNaN(e.start.valueOf())).sort((a, b) => a.start - b.start);
}
export { rawEvents as nativeEvents };
function indexFor(c) {
  const states = c.sources.data.states || [], registry = c.sources.registries;
  return HD.Model.buildIndex(registry ? { ...registry, states } : { states, areas: [], devices: [], entities: [] });
}
function homeContext(c) {
  return {
    states: roomModel(c.sources).states, index: roomModel(c.sources).index, global: !c.room || c.widget.scope === 'all', roomName:c.room?.name,
    targetTemp: st => st.attributes.temperature,
    roomSummaries: () => roomModel(c.sources).rooms, roomOrder: list => list,
    mediaUrl: url => { if (!url) return ''; if (/^https?:/.test(url)) return safeUrl(url); return c.sources.ha ? c.sources.ha.baseUrl + url : ''; },
    forecast: st => c.sources.forecastFor?.(st, 'daily'),
    calendar: (list,days)=>c.sources.calendarFor?.(list,days) || {raw:{},loading:false,error:null}, rememberEvents: (id,events)=>{ c.sources.moduleEvents ||= {}; c.sources.moduleEvents[id]=events; },
    cameraUrl:(st,live)=>c.sources.cameraUrl(st,live), proxmox:()=>proxmoxModel(c.sources), updQueue:()=>c.sources.updateQueue,
  };
}
function homeWeather(c) {
    const m={id:c.widget.id,title:c.widget.title,w:c.widget.width || (c.widget.size === 'wide' ? 2 : c.widget.size === 'full' ? 4 : 1),h:c.widget.height || 2,options:c.widget.options || {}}, M=HD.Model, IC=HD.IC;
    const allStates=()=>selected(c,c.sources.data.states || []), forecastFor=(st,type)=>c.sources.forecastFor(st,type === 'main' ? 'daily' : type), hhmm=d=>d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    const icon=(path,size=20,sw=1.8)=>HD.UI.icon(path,size,sw);
    const W = HD.Modules;
    const w = c.detail ? 4 : m ? m.w : 1, h = c.detail ? 4 : m ? m.h : 4;
    const st = allStates().find((s) => M.domainOf(s.entity_id) === 'weather');
    if (!st) return `<section class="hero-weather-content hero-card hero-weather"><div class="mod-head"><h2>Météo</h2></div><p class="muted small">Aucune entité météo dans Home Assistant (intégration Météo-France par exemple).</p></section>`;
    const a = st.attributes;
    const days = W.dailyItems(forecastFor(st, 'main'));
    const todayKey = new Date().toDateString();
    const todayFc = days.find((f) => new Date(f.datetime).toDateString() === todayKey);
    const hourlyFc = forecastFor(st, 'hourly');
    // Design « Météo »: 1×1 centered · x×1 a strip · 1×n a column · 2+×2+ complete. Each size its own selection.
    const tiny = w === 1 && h === 1, strip = h === 1 && w >= 2, narrow = w === 1 && h >= 2, big = w >= 2 && h >= 2;
    const nHours = strip ? (w === 2 ? 3 : w === 3 ? 6 : 9) : narrow ? 4 : big ? (w === 2 ? 5 : w === 3 ? 7 : 9) : 0;
    const nDays = tiny || strip ? 0 : h === 2 ? 3 : h === 3 ? 5 : 7;
    const upcoming = days.filter((f) => new Date(f.datetime).toDateString() === todayKey || new Date(f.datetime) > new Date());
    // Every upcoming day is rendered: the card shows as many as fit (see .wh-days), nDays stays the guaranteed minimum.
    const next = nDays ? upcoming : [];
    const hours = nHours && hourlyFc && hourlyFc.items ? hourlyFc.items.filter((x) => Date.parse(x.datetime) > Date.now() - 30 * 60000).slice(0, nHours) : [];
    const lowOf = (f) => (f.templow != null ? f.templow : f.temperature);
    const lo = Math.min(...next.map(lowOf)), hi = Math.max(...next.map((f) => f.temperature));
    const span = hi - lo || 1;
    const t0 = todayFc || days[0];
    const n0 = (v) => esc(M.fmtNum(v, 0)) + '°';
    const range = t0 && t0.templow != null ? n0(t0.templow) + ' / ' + n0(t0.temperature) : '';
    const minMax = t0 && t0.templow != null ? 'Min ' + n0(t0.templow) + ' · Max ' + n0(t0.temperature) : '';
    const cond = esc(M.WEATHER[st.state] || st.state);
    const temp = (size) => `<span class="wh-temp" style="font-size: ${size}px">${n0(a.temperature)}</span>`;
    const hum = a.humidity != null ? esc(M.fmtNum(a.humidity, 0)) + ' %' : null;
    const wind = a.wind_speed != null ? esc(M.fmtNum(a.wind_speed, 0)) + ' ' + esc(a.wind_speed_unit || 'km/h') : null;
    const stat = (ic, color, label, v) => v == null ? '' : `<span class="wh-stat">${icon(ic, 18, 1.8).replace('stroke="currentColor"', `stroke="${color}"`)}<span class="stack"><span class="muted">${label}</span><b>${v}</b></span></span>`;
    const stats = stat(IC.drop, '#8EC5FF', 'Humidité', hum) + stat(IC.wind, 'currentColor', 'Vent', wind);
    const hoursHtml = (boxed) => hours.length ? `<span class="wh-hours${boxed ? ' is-boxed' : ''}">${hours.map((x) =>
        `<span class="wh-hr"><span class="muted">${new Date(x.datetime).getHours()}h</span>${W.wxArt(x.condition || st.state, 22)}<b>${n0(x.temperature)}</b></span>`).join('')}</span>` : '';
    const daysHtml = next.length ? `<span class="wh-days${narrow ? ' is-narrow' : ''}">${next.map((f, i) => {
        const l = lowOf(f);
        const left = ((l - lo) / span) * 100, width = Math.max(4, ((f.temperature - l) / span) * 100);
        return `<span class="wh-day${i >= nDays ? ' is-extra' : ''}"><span>${esc(W.dayLabel(f.datetime, i))}</span><span class="muted wh-num">${n0(l)}</span>
          <span class="wh-track"><i style="left: ${left.toFixed(1)}%; width: ${Math.min(100 - left, width).toFixed(1)}%"></i></span><b class="wh-num">${n0(f.temperature)}</b></span>`;
      }).join('')}</span>` : '';
    const upd = st.last_updated ? ' · maj. ' + hhmm(new Date(st.last_updated)) : '';
    const title = esc((m && m.title) || 'Météo');
    const headHtml = (meta) => `<span class="mod-head"><h2>${title}</h2><span class="muted small">${meta}</span></span>`;
    let inner;
    if (tiny) {
      inner = `<span class="wh-tiny">${W.wxArt(st.state, 48)}${temp(44)}<b class="wh-cond">${cond}</b>${range ? `<span class="muted small wh-num">${range}</span>` : ''}</span>`;
    } else if (strip) {
      inner = `<span class="wh-strip"><span class="wh-strip-now"><span class="h2">${title}</span><span class="wh-now">${W.wxArt(st.state, 44)}${temp(44)}</span>
          <span class="muted small wh-num">${cond}${range ? ' · ' + range : ''}</span></span><span class="wh-sep" aria-hidden="true"></span>${hoursHtml(false)}</span>`;
    } else if (narrow) {
      inner = headHtml(esc(M.shortName(st))) + `<span class="wh-center"><span class="wh-now">${W.wxArt(st.state, 44)}${temp(44)}</span><b class="wh-cond">${cond}</b>${range ? `<span class="muted small wh-num">${range}</span>` : ''}</span>
        ${hoursHtml(true)}
        ${h >= 3 ? `<span class="wh-list">${hum != null ? `<span><span class="muted">Humidité</span><b>${hum}</b></span>` : ''}${wind != null ? `<span><span class="muted">Vent</span><b>${wind}</b></span>` : ''}</span>` : ''}
        ${daysHtml}`;
    } else {
      const statsText = w === 2 && h === 2 && (hum != null || wind != null) ? `<span class="muted small wh-num ell">${[hum != null ? 'Hum. ' + hum : '', wind != null ? 'Vent ' + wind : ''].filter(Boolean).join(' · ')}</span>` : '';
      inner = headHtml(esc(M.shortName(st)) + upd) + `<span class="wh-big-now">${W.wxArt(st.state, 56)}${temp(56)}
          <span class="stack wh-desc"><b class="wh-cond">${cond}</b>${minMax ? `<span class="muted small wh-num">${minMax}</span>` : ''}${statsText}</span>
          ${w >= 3 ? `<span class="wh-stats is-inline">${stats}</span>` : ''}</span>
        ${w === 2 && h >= 3 ? `<span class="wh-stats">${stats}</span>` : ''}
        ${hoursHtml(true)}${daysHtml}`;
    }
    return `<div class="hero-weather-content hero-card hero-weather wxv-${tiny ? 'tiny' : strip ? 'strip' : narrow ? 'narrow' : 'big'}" role="button" tabindex="0" data-act="weather-open" data-arg="${esc(st.entity_id)}" data-key="hero:wx" aria-label="Météo, prévisions détaillées">
      ${inner}
    </div>`;
  }

function homeRooms(c) {
  const model=roomModel(c.sources), chosen=c.widget.options?.rooms;
  const rooms=model.rooms.filter(r=>(!Array.isArray(chosen) ? r.id !== '__autres' : chosen.includes(r.id)));
  const on=[...model.index.visible].filter(id=>id.startsWith('light.') && model.states.get(id)?.state === 'on').length, temps=model.rooms.filter(r=>r.id !== '__autres').map(r=>r.temp).filter(t=>t!=null);
  const average=temps.length ? 'Moy. '+num(temps.reduce((a,b)=>a+b,0)/temps.length,1)+'° · ' : '';
  const w=c.widget.width || (c.widget.size === 'full' ? 4 : c.widget.size === 'wide' ? 2 : 1), narrow=w === 1;
  const bulb=r=>`<button class="bulb ${r.lights ? 'is-on' : ''}" data-action="room-lights" data-id="${esc(r.id)}" aria-label="${r.lights ? 'Éteindre' : 'Allumer'} ${esc(r.name)}" aria-pressed="${!!r.lights}" ${r.lightTotal ? '' : 'disabled'}>${icon('bulb')}</button>`;
  const sub=r=>!r.lightTotal ? r.temp == null ? 'Aucun capteur' : 'Aucune lumière' : !r.lights ? 'Lumières éteintes' : `${r.lights}/${r.lightTotal} ${r.lights>1 ? 'allumées' : 'allumée'}`;
  return head(c.widget.title || 'Pièces',average+on+' lumière'+(on>1?'s allumées':' allumée'))+(rooms.length ? `<div class="${narrow ? 'rooms-list' : 'rooms-grid is-rows'}" style="${!narrow ? 'grid-template-columns:repeat('+ (w<=2?2:3) +',minmax(0,1fr));--rt-temp:24px' : ''}">${rooms.map(r=>`<div class="rt ${narrow ? 'is-row' : ''}${r.lights ? ' is-on' : ''}">${narrow ? '' : '<div class="rt-top">'}<button class="rt-open" data-action="room" data-id="${esc(r.id)}" aria-label="Ouvrir ${esc(r.name)}"><span class="rt-name">${esc(r.name)}</span><span class="muted small ell">${esc(sub(r))}</span>${narrow ? '<span class="rt-temp">'+(r.temp==null?'—':num(r.temp,1)+'°')+'</span>' : ''}</button>${bulb(r)}${narrow ? '' : '</div><span class="rt-bottom"><span class="rt-temp'+(r.temp==null?' is-none':'')+'">'+(r.temp==null?'—':num(r.temp,1)+'°')+'</span></span>'}</div>`).join('')}<button class="ghost-btn rt-off" data-action="all-off" data-id="${esc(c.widget.id)}">${icon('power')} Tout éteindre</button></div>` : empty('Connectez Home Assistant pour retrouver vos pièces.'));
}
function todo(c) {
  return `<div class="native-todos"><div class="todo-list">${c.todos.map(t => `<label class="todo-row ${t.done ? 'done' : ''}"><input type="checkbox" data-action="todo-check" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><span>${esc(t.title)}</span></label>`).join('')}</div><form data-form="todo" class="inline-add"><input name="title" aria-label="Nouvelle tâche" placeholder="Ajouter un article…" maxlength="200" required><button class="button primary" aria-label="Ajouter la tâche">${icon('plus')}</button></form></div>`;
}
function music(c, home) {
  const d = c.sources.data.spotify || {}, t = d.track;
  const media = selected(c, c.sources.states('media_player'))[0];
  if (home && media) return HD.Modules.types.media.render({ id: c.widget.id, w: 1, h: 2, options: {} }, [media], homeContext(c));
  if (!t && home) return head('Lecture en cours') + empty('Rien en lecture. Ouvrez Spotify pour lancer un titre.');
  const art = t?.art ? `<img src="${esc(safeUrl(t.art))}" alt="Pochette" loading="lazy">` : '';
  const button = `<button class="${home ? 'media-play' : 'player-btn play'}" style="--s:60px" data-action="${c.sources.demo ? 'demo-music' : 'open-music'}" aria-label="${d.playing ? 'Mettre en pause' : 'Lire dans Spotify'}">${icon(d.playing ? 'pause' : 'play')}</button>`;
  const progress = Math.max(0, Math.min(100, (d.progressMs || 0) / Math.max(1, t?.durationMs || 1) * 100));
  if (home) return head('Lecture en cours', esc(d.device?.name || 'Spotify')) + `<div class="native-home-media"><div class="media-art">${art || icon('music')}</div><div class="media-title">${esc(t.title)}</div><div class="muted">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div><div class="native-progress"><i style="width:${progress}%"></i></div><div class="row-between muted small"><span>${duration(d.progressMs)}</span><span>${duration(t.durationMs)}</span></div><div class="media-ctrls">${button}</div></div>`;
  const connected = d.connected || c.sources.demo;
  const control = (action,glyph,label,enabled=true) => `<button class="player-btn ${glyph === 'play' || glyph === 'pause' ? 'play' : ''}" data-action="${action}" aria-label="${label}" title="${label}" ${enabled ? '' : 'disabled'}>${icon(glyph)}</button>`;
  const reauth = c.sources.data.spotifyStatus?.missingScopes?.length ? `<div class="sp-reauth">${icon('sparkle')}<span>Nouvelles fonctions disponibles (favoris, historique). Reconnectez votre compte dans Cockpit pour autoriser ces accès.</span><button class="btn" data-action="spotify-settings">Reconnecter</button></div>` : '';
  return `<div class="sp ${c.widget.bigArt ? 'big-art' : ''}"><div class="sp-top"><div class="sp-art">${art || icon('music')}</div><div class="sp-main"><div class="sp-title">${esc(t?.title || 'Rien en lecture')}</div><div class="sp-sub">${esc(t?.artist || (connected ? 'Ouvrez Spotify pour lancer un titre.' : 'Spotify non connecté'))}</div></div><div class="sp-controls">${control('open-music','star','Ouvrir Spotify',!!t)}${control('spotify-previous','previous','Morceau précédent',connected)}${control(c.sources.demo ? 'demo-music' : 'spotify-toggle',d.playing ? 'pause' : 'play',d.playing ? 'Mettre en pause' : 'Lire',connected)}${control('spotify-next','next','Morceau suivant',connected)}</div></div><div class="sp-progress mono"><span>${duration(d.progressMs)}</span><div class="sp-seek"><div class="sp-seek-fill" style="width:${progress}%"></div></div><span>${duration(t?.durationMs)}</span></div><div class="sp-row"><span class="sp-vol-icon" title="${esc(d.device?.name || 'Appareil actif')}">${icon('monitor')}</span><input class="player-volume" type="range" min="0" max="100" value="${Number(d.device?.volume) || 0}" data-spotify-volume aria-label="Volume Spotify" ${connected ? '' : 'disabled'}><button class="player-btn open" data-action="open-music" aria-label="Ouvrir Spotify">${icon('expand')}</button></div></div>${reauth}${!connected ? '<p class="settings-help">Connectez Spotify depuis Cockpit.</p>' : ''}`;
}
function rss(c) {
  const raw = c.sources.data.articles; if (!Array.isArray(raw)) return empty('Votre veille se connecte à Cockpit.');
  const all = raw.filter(a => !c.hiddenSources.includes(a.source)), category = c.widget.category || '';
  const unread = all.filter(a => !c.readArticles.includes(a.id)).length;
  const cats = [...new Set(all.map(a => a.category).filter(Boolean))], palette = ['#f472b6','#4f8cff','#c084fc','#f5b83d','#3dd68c'];
  let list = all.filter(a => (!category || (category === '__favorites' ? c.favorites.includes(a.id) : category === '__unread' ? !c.readArticles.includes(a.id) : category === '__saved' ? c.savedArticles.includes(a.id) : a.category === category)) && (!c.query || (a.title + a.source).toLowerCase().includes(c.query.toLowerCase())));
  if (c.widget.sort === 'trending') list = [...list].sort((a,b) => (b.popularity || 0)-(a.popularity || 0));
  const categoryColor = cat => palette[Math.max(0,cats.indexOf(cat)) % palette.length];
  const filter = (id,text,extra='') => `<button class="chip ${category === id ? 'active' : ''}" data-action="rss-category" data-widget-id="${esc(c.widget.id)}" data-id="${esc(id)}" ${extra}>${text}</button>`;
  const controls = `<div class="rss-controls"><label class="rss-search">${icon('search')}<input id="${c.detail ? 'detail-search' : 'global-search'}" placeholder="Rechercher" aria-label="Rechercher dans les articles" value="${esc(c.query)}"><span class="kbd">Ctrl K</span></label><div class="rss-tools"><button class="widget-btn" data-action="rss-options" data-id="${esc(c.widget.id)}" aria-label="Options des articles">${icon('sparkle')}</button><button class="widget-btn" data-action="rss-saved" data-id="${esc(c.widget.id)}" aria-label="Articles enregistrés">${icon('grid')}</button><button class="widget-btn" data-action="rss-options" data-id="${esc(c.widget.id)}" aria-label="Filtres et présentation">${icon('settings')}</button><button class="widget-btn" data-action="detail" data-id="${esc(c.widget.id)}" aria-label="Agrandir les articles">${icon('panel')}</button><button class="widget-btn" data-action="refresh" aria-label="Actualiser les flux">${icon('refresh')}</button></div></div><div class="filters">${filter('','Tout')}${filter('__unread','Non lus <span class="chip-count">'+unread+'</span>')}${filter('__favorites',icon('star')+' Favoris','style="--chip:#fbbf24"')}<span class="filters-sep"></span>${cats.map(cat => filter(cat,`<span class="chip-dot"></span>${esc(cat)} <span class="chip-count">${all.filter(a => a.category === cat && !c.readArticles.includes(a.id)).length}</span>`,`style="--chip:${categoryColor(cat)}"`)).join('')}</div>`;
  const age = date => { const minutes = Math.max(0,Math.floor((Date.now()-new Date(date))/60000)); return Number.isFinite(minutes) ? minutes < 60 ? minutes+' min' : minutes < 1440 ? Math.floor(minutes/60)+' h' : Math.floor(minutes/1440)+' j' : ''; };
  return controls + `<div class="articles-grid">${list.slice(0,c.detail ? 150 : 50).map(a => `<article class="article ${c.readArticles.includes(a.id) ? 'read' : ''}"><button class="article-link" data-action="article" data-id="${esc(a.id)}"><div class="article-meta">${c.readArticles.includes(a.id) ? '' : '<span class="unread-dot"></span>'}<span class="source-mark" aria-hidden="true">${esc((a.source || 'F')[0])}</span><span class="source">${esc(a.source)}</span><span class="time">${age(a.pubDate)}</span></div><h3 class="article-title">${esc(a.title)}</h3>${a.description && c.widget.descriptions !== false ? `<p class="article-desc">${esc(a.description.replace(/<[^>]*>/g,''))}</p>` : ''}</button><footer class="article-foot"><span class="cat-pill" style="--pill:${categoryColor(a.category)}">${esc(a.category || 'Veille')}</span><span class="spacer"></span><button class="action-btn ${c.favorites.includes(a.id) ? 'fav' : ''}" data-action="favorite" data-id="${esc(a.id)}" aria-label="${c.favorites.includes(a.id) ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${icon('star')}</button><button class="action-btn ${c.savedArticles.includes(a.id) ? 'saved' : ''}" data-action="save-article" data-id="${esc(a.id)}" aria-label="Enregistrer pour plus tard" aria-pressed="${c.savedArticles.includes(a.id)}">${icon('bookmark')}</button><button class="action-btn" data-action="copy-article" data-id="${esc(a.id)}" aria-label="Copier le lien">${icon('link')}</button><button class="action-btn" data-action="hide-source" data-id="${esc(a.id)}" aria-label="Masquer ${esc(a.source)}">${icon('eyeOff')}</button></footer></article>`).join('') || '<p class="empty">Aucun article correspondant.</p>'}</div>`;
}
function metrics(c) {
  const m = c.sources.data.metrics; if (!m) return empty('Le PC n’est pas connecté.');
  const data = [['cpu','CPU',m.cpu?.usagePercent,m.cpu?.cores ? m.cpu.cores+' cœurs' : m.cpu?.speedGhz ? num(m.cpu.speedGhz,1)+' GHz' : ''],['ram','RAM',m.memory?.usedPercent,m.memory?.total ? num(m.memory.used/1073741824)+' Go / '+num(m.memory.total/1073741824)+' Go' : ''],['gpu','GPU',m.gpu?.loadPercent ?? m.gpu?.usagePercent,String(m.gpu?.model || '').replace(/^(AMD|NVIDIA|Intel)\s+/i,'').replace(/^Radeon\s+/i,'')],['vram','VRAM',m.gpu?.vramPercent,m.gpu?.vramTotal ? num(m.gpu.vramUsed/1073741824,1)+' Go / '+num(m.gpu.vramTotal/1073741824)+' Go' : '']];
  const enabled = c.widget.metrics || ['cpu','ram','gpu','vram'];
  const cards = data.filter(([id]) => enabled.includes(id)).map(([id,label,value,sub],i) => {
    const tint = value >= 85 ? 'var(--danger)' : value >= 70 ? 'var(--warn)' : 'var(--accent)';
    const history = c.sources.demo ? [18+i,22,19,30+i*4,16,25,21,29,Number(value)||0] : c.sources.metricHistory?.[id] || [];
    return `<div class="mon-card"><span class="mon-label">${label}</span><span class="mon-value" style="color:${tint}">${num(value)}<span class="mon-unit">%</span></span>${spark(history,'currentColor',false).replace('class="spark"',`class="spark mon-spark" style="color:${tint}"`)}<div class="mon-meta" title="${esc(sub)}">${esc(sub || (value == null ? 'Non disponible' : ''))}</div></div>`;
  }).join('');
  const disks = c.widget.showDisks !== false ? `<div class="metric-list">${(m.disks || []).map(d => `<div class="metric-row"><strong>${esc(d.name || 'Disque')}</strong><div class="meter"><div class="meter-fill" style="width:${Math.max(0,Math.min(100,Number(d.usedPercent)||0))}%;background:var(--accent)"></div></div><span>${num(d.usedPercent)}%</span></div>`).join('')}</div>` : '';
  return `<div class="mon-grid">${cards}</div>${disks}`;
}
function quotas(c) {
  const data = c.sources.data.quotas, providers = (data?.sources || []).flatMap(s => s.providers || []);
  if (!providers.length) return empty('Aucun quota disponible. Configurez vos abonnements dans Cockpit.');
  const reset = value => { const d = new Date(value); if (!Number.isFinite(d.valueOf())) return ''; const time = d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString('fr-FR',{weekday:'short'}).replace('.','')+' '+time; };
  const accounts = providers.map(p => `<article class="usage-account"><strong class="usage-name">${esc(p.name.split(' / ')[0])}</strong><div class="usage-windows">${(p.windows || []).map(w => {
    const left = Math.max(0,Math.min(100,w.remainingPercent ?? 100-w.usedPercent)), used = Math.max(0,Math.min(100,w.usedPercent ?? 100-left));
    return `<div class="usage-window usage-${left>66 ? 'ok' : left>33 ? 'mid' : 'low'}" title="${esc(w.label || '')}"><div class="usage-window-head mono"><strong>${num(left)}%</strong><span>${esc(w.resetAt ? reset(w.resetAt) : w.label || '')}</span></div><div class="usage-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><span class="usage-meter-fill" style="width:${used}%"></span></div></div>`;
  }).join('')}</div>${p.error ? `<p class="usage-account-note">${esc(p.error)}</p>` : ''}</article>`).join('');
  const warnings = [...new Set([data?.error,...(data?.sources || []).map(s => s.error)].filter(Boolean))];
  return accounts + warnings.map(w => `<p class="usage-warning">${esc(w)}</p>`).join('');
}
function calendar(c, home) {
  const events = rawEvents(c);
  if (home) {
    const days = HD.Modules.calDays(events, { id: c.widget.id, w: c.widget.size === 'wide' ? 2 : 1, h: 2, days: 7, pages: 1 });
    return head('Agenda', esc(days.meta)) + days.html;
  }
  return `<div class="native-agenda">${events.map(e => `<div><span class="mono">${e.start.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })} · ${e.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span><strong>${esc(e.title)}</strong></div>`).join('') || '<p class="empty">Rien de prévu.</p>'}</div>`;
}
export function nativeContent(c, fallback) {
  const home = c.home, type = c.widget.type, title = nativeTitle(type);
  if (type === 'spotify' && c.sources.status?.ha === 'connected') {
    const list=spotifyStatesForWidget(c.sources,c.widget,c.room);
    if (!list.length) return head(c.widget.title || 'Spotify')+`<div class="mod-empty"><p>Choisissez votre lecteur Spotify intégré à Home Assistant.</p><button class="btn-glass" data-act="mod-config">Choisir le compte Spotify</button></div>`;
    const m={id:c.widget.id,title:c.widget.title || 'Spotify',w:c.widget.width || (c.widget.size === 'wide' ? 2 : 1),h:c.widget.height || 2,options:c.widget.options || {}};
    return HD.Modules.types.media.render(m,list,homeContext(c));
  }
  const component=feedmeComponent(c); if (component) return component;
  if (type === 'ha-todos') {
    const state=selected(c,c.sources.states('todo'))[0]; if (!state) return head('Courses')+`<div class="mod-empty"><p>Choisissez une liste Home Assistant.</p><button class="btn-glass" data-act="mod-config">Choisir une liste</button></div>`;
    const slot=c.sources.todoFor(state); return head(c.widget.title || 'Courses',esc(name(state)))+`<div class="native-todos"><div class="todo-list">${slot.items.map(it=>`<label class="todo-row ${it.status === 'completed' ? 'done' : ''}"><input type="checkbox" data-ha-todo="${esc(state.entity_id)}" data-item="${esc(it.uid)}" ${it.status === 'completed' ? 'checked' : ''}><span>${esc(it.summary)}</span></label>`).join('')}${slot.error ? `<p>${esc(slot.error)}</p>` : slot.loading ? '<p>Chargement…</p>' : !slot.items.length ? '<p>La liste est vide.</p>' : ''}</div><form data-form="ha-todo" data-entity="${esc(state.entity_id)}" class="inline-add"><input name="title" required maxlength="300" placeholder="Ajouter un article…" aria-label="Nouvel article"><button class="button primary" aria-label="Ajouter à la liste Home Assistant">${icon('plus')}</button></form></div>`;
  }
  const originalType={sensors:'sensor','ha-media':'media',cameras:'camera',server:'pve-node',guests:'pve-guests'}[type] || type;
  if ((home || c.room || ['temperature','ha-media'].includes(type)) && ['temperature','climate','lights','devices','scenes','sensors','energy','automations','ha-media','notes','calendar','cameras','server','guests','updates','transit'].includes(type)) {
    const def=HD.Modules.types[originalType];
    let list=selected(c,(c.sources.data.states || []).filter((c.widget.entity || Array.isArray(c.widget.entities) ? def.pick : def.auto || def.pick) || (()=>true)));
    const m={id:c.widget.id,title:c.widget.title || '',w:c.widget.width || (c.widget.size === 'wide' ? 2 : c.widget.size === 'full' ? 4 : 1),h:c.widget.height || 2,scope:c.widget.scope,options:{...c.widget.options,...(type === 'notes' ? {text:c.note} : {})}};
    if (type === 'calendar' && !m.options.view) m.options.view='jours';
    if (!def.noEntities && !list.length) return head(c.widget.title || title)+`<div class="mod-empty"><p class="muted small">Aucun appareil compatible ici.</p><button class="btn-glass sm" data-act="mod-config">Choisir des appareils</button></div>`;
    if (def.single) list=list.slice(0,1);
    return def.render(m,list,homeContext(c)).replace('class="note','data-note="'+esc(c.widget.id)+'" class="note-input note');
  }
  if (type === 'system') return (home ? head(title) : '') + metrics(c);
  if (type === 'quotas') return (home ? head(title) : '') + quotas(c);
  if (type === 'rss') return (home ? head(title) : '') + rss(c);
  if (type === 'spotify') return music(c, home);
  if (type === 'todos') return (home ? head('Courses', `${c.todos.filter(t => !t.done).length} articles`) : '') + todo(c);
  if (type === 'notes') return (home ? head('Notes') : '') + `<textarea class="note-input note" data-note="${esc(c.widget.id)}" aria-label="Votre note" placeholder="Écrire une note… (rappels, code wifi invités)" maxlength="20000">${esc(c.note)}</textarea>`;
  if (type === 'calendar') return calendar(c, home);
  if (home && type === 'rooms') return homeRooms(c);
  if (home && type === 'weather') return homeWeather(c);
  if (type === 'agents') {
    const contacts = c.sources.data.agents?.contacts || [];
    return (home ? head(title) : '') + `<div class="messenger native-agent-list">${contacts.map((a, i) => `<button class="messenger-contact" data-action="chat"><span class="messenger-avatar"><span class="messenger-initial">${esc(a.name?.[0] || 'A')}</span></span><span class="messenger-contact-copy"><strong>${esc(a.name)}</strong><span>${esc(a.preview || 'Ouvrir la conversation')}</span></span>${a.unread ? `<span class="messenger-count">${a.unread}</span>` : ''}</button>`).join('') || empty('Retrouvez vos conversations en connectant Cockpit.')}</div>`;
  }
  return (home ? head(title) : '') + fallback(c);
}
