import { statesForWidget } from './rooms.js';
import { esc, icon, num, safeUrl, spark } from './core.js';
const empty = (text, source = '') => `<div class="empty-state">${icon('link')}<strong>${esc(text)}</strong><span>${source ? esc(source) : 'Les données apparaîtront dès que la source sera disponible.'}</span><button class="text-button" data-action="settings">Configurer les connexions ${icon('arrow')}</button></div>`;
const name = s => s.attributes.friendly_name || s.entity_id;
const value = s => `${esc(s.state)} <small>${esc(s.attributes.unit_of_measurement || '')}</small>`;
const meta = (title, category, provider, glyph, description, render, extra = {}) => ({ title, category, provider, glyph, description, render, ...extra });
const filtered = (c,list) => { const ids=new Set(statesForWidget(c.sources,c.widget,c.room).map(s=>s.entity_id)); return list.filter(s=>ids.has(s.entity_id)); };
const available = list => list.filter(s => !['unknown', 'unavailable'].includes(s.state));
export const modules = {
  'ha-todos':meta('Courses Home Assistant','Maison','ha','check','Vos listes Bring, courses ou tâches partagées dans Home Assistant.',()=>empty('Choisissez une liste Home Assistant.'),{domains:['todo']}),
  'feedme-weather':meta('Météo par ville','Quotidien','feedme','sun','Météo Cockpit, recherche de ville et prévisions.',()=>empty('Connectez Cockpit pour choisir votre ville.')),
  temperature:meta('Température','Maison','ha','thermo','Thermomètres et humidité de la pièce.',()=>'',{domains:['sensor']}),
  'ha-media':meta('Spotify / musique','Maison','ha','music','Lecteurs Home Assistant de la pièce.',()=>'',{domains:['media_player']}),
  weather: meta('La météo', 'Quotidien', 'ha', 'sun', 'Un coup d’œil dehors, avant de sortir.', c => {
    const s = filtered(c, c.sources.states('weather'))[0];
    if (!s) return empty('Aucune météo connectée', 'Choisissez une entité weather dans Home Assistant.');
    const a = s.attributes, labels = { partlycloudy: 'Quelques nuages', sunny: 'Ciel dégagé', cloudy: 'Nuageux', rainy: 'Pluvieux', 'clear-night': 'Nuit claire', fog: 'Brumeux' };
    return `<div class="weather-location">${esc(c.sources.demo ? 'À la maison' : name(s))}<span>${esc(labels[s.state] || s.state)}</span></div><div class="weather-now"><strong>${num(a.temperature)}<sup>°</sup></strong><div class="weather-art">${icon('sun')}</div></div><div class="weather-facts"><span>Humidité <b>${num(a.humidity)} %</b></span><span>Vent <b>${num(a.wind_speed)} km/h</b></span></div><div class="weather-caption">Un regard dehors. L’esprit tranquille.</div>`;
  }, { domains: ['weather'], tone: 'peach' }),
  rooms: meta('À la maison', 'Maison', 'ha', 'home', 'Les pièces, leurs températures et leurs lumières.', c => {
    const list = c.sources.data.rooms || [];
    if (!list.length) return empty('Vos pièces vous attendent', 'Connectez HA avec l’accès aux registres des pièces.');
    return `<div class="stat-line"><strong>${num(c.sources.states('light').filter(s => s.state === 'on').length)}</strong><span>lumières allumées</span><span class="mini-tag green">Maison</span></div><div class="room-list">${list.slice(0, c.detail ? 30 : 3).map((r, i) => `<div><span class="room-icon room-${i % 3}">${icon(i === 2 ? 'thermo' : 'home')}</span><span><b>${esc(r.name)}</b><small>${r.lights ? `${r.lights} lumière${r.lights > 1 ? 's' : ''}` : 'Tout est éteint'}</small></span><strong>${r.temp == null ? '—' : num(r.temp, 1) + '°'}</strong></div>`).join('')}</div>`;
  }),
  agents: meta('Vos agents', 'Agents', 'feedme', 'chat', 'Les assistants, messages et conversations de Cockpit.', c => {
    const d = c.sources.data.agents, contacts = d?.contacts || [];
    if (!contacts.length) return empty('Retrouvez vos assistants', 'Ouvrez Cockpit et configurez vos agents depuis son interface.');
    const unread = contacts.reduce((n, a) => n + (a.unread || 0), 0);
    return `<div class="agent-top"><div class="avatar-stack">${contacts.slice(0, 3).map((a, i) => `<span class="avatar av-${i}">${esc(a.name?.slice(0, 1) || 'A')}</span>`).join('')}</div><span class="mini-tag">${contacts.length} assistant${contacts.length > 1 ? 's' : ''}</span></div><h3 class="agent-title">Une longueur<br>d’avance.</h3><p class="agent-caption">${unread ? `${unread} message${unread > 1 ? 's' : ''} à découvrir.` : 'Vos assistants, à portée de main.'}</p><button class="agent-open" data-action="chat">Ouvrir les conversations ${icon('arrow')}</button>`;
  }, { tone: 'forest' }),
  rss: meta('Votre veille', 'Veille', 'feedme', 'rss', 'Les articles de vos flux RSS, sans le bruit.', c => {
    let articles = c.sources.data.articles;
    if (!Array.isArray(articles)) return empty('Votre veille se connecte à Cockpit');
    if (c.query) articles = articles.filter(a => (a.title + a.source).toLowerCase().includes(c.query.toLowerCase()));
    if (!articles.length) return `<div class="empty-state">${icon('rss')}<strong>Aucun article pour le moment</strong><span>Essayez un autre mot-clé ou ajoutez des sources dans Cockpit.</span></div>`;
    return `<div class="news-tabs"><span class="active">À la une</span><span>${articles.length} articles</span><span class="news-label">${c.sources.demo ? 'Sélection de démonstration' : 'Vos flux Cockpit'}</span></div><div class="article-list">${articles.slice(0, c.detail ? 60 : 3).map((a, i) => `<button class="article" data-action="article" data-id="${esc(a.id)}"><div class="article-mark mark-${i % 4}">${icon(['chat', 'home', 'grid', 'server'][i % 4])}</div><div class="article-copy"><div class="article-meta"><span>${esc(a.category || 'Veille')}</span><span>${esc(a.source)}</span></div><h3>${esc(a.title)}</h3>${c.detail ? `<p>${esc((a.description || '').replace(/<[^>]*>/g, ''))}</p>` : ''}</div>${icon('arrow')}</button>`).join('')}</div>`;
  }, { size: 'wide' }),
  system: meta('Ce PC', 'Système', 'feedme', 'monitor', 'CPU, mémoire et activité de votre ordinateur.', c => {
    const m = c.sources.data.metrics; if (!m) return empty('Le PC n’est pas connecté');
    const cpu = m.cpu?.usagePercent, ram = m.memory?.usedPercent;
    return `<div class="system-head"><span class="device-avatar">${icon('monitor')}</span><span><strong>${esc(c.sources.demo ? 'Mon espace de travail' : 'PC hébergeant Cockpit')}</strong><small>Activité du système</small></span><i class="status-dot"></i></div><div class="system-values"><div><span>CPU</span><strong>${num(cpu)}<small>%</small></strong></div><div><span>Mémoire</span><strong>${num(ram)}<small>%</small></strong></div></div>${c.sources.demo ? spark([13, 16, 14, 25, 22, 19, 30, 25, 40, 21, 26, 23]) : spark(c.sources.history)}<div class="chart-caption">${c.sources.demo ? 'Activité simulée' : c.sources.history.length > 1 ? 'Mesures depuis l’ouverture' : 'Première mesure · historique en cours'}</div>`;
  }),
  energy: meta('Énergie', 'Maison', 'ha', 'bolt', 'La puissance et les compteurs de la maison.', c => {
    const all = filtered(c, available(c.sources.states('sensor')).filter(s => ['power', 'energy'].includes(s.attributes.device_class)));
    if (!all.length) return empty('Aucun capteur d’énergie');
    return `<div class="energy-main"><span class="energy-bolt">${icon('bolt')}</span><div><strong>${value(all[0])}</strong><span>${esc(name(all[0]))}</span></div></div>${c.sources.demo ? `<div class="energy-bars" aria-label="Consommation simulée">${[22, 18, 16, 25, 38, 65, 45, 33, 48, 58, 37, 70, 42, 60, 46, 30, 54, 45, 39, 50, 42, 56, 30, 24].map((n, i) => `<i style="height:${n}%" class="${i > 19 ? 'dim' : ''}"></i>`).join('')}</div><div class="axis"><span>00:00</span><span>12:00</span><span>Maintenant</span></div>` : `<p class="subtle">Mesure instantanée · Home Assistant</p>`}<div class="energy-bottom">${all[1] ? `<span>${esc(name(all[1]))}</span><b>${value(all[1])}</b>` : '<span>Actualisé en direct</span>'}</div>`;
  }, { tone: 'sage', domains: ['sensor'] }),
  lights: meta('Éclairage', 'Maison', 'ha', 'bulb', 'Allumez, éteignez, retrouvez la bonne ambiance.', c => {
    const lights = filtered(c, c.sources.states('light')); if (!lights.length) return empty('Aucune lumière connectée');
    return `<div class="light-grid">${lights.slice(0, c.detail ? 50 : 4).map(s => `<button class="light-tile ${s.state === 'on' ? 'on' : ''}" data-action="toggle-light" data-id="${esc(s.entity_id)}" ${['unavailable', 'unknown'].includes(s.state) ? 'disabled' : ''} aria-pressed="${s.state === 'on'}">${icon('bulb')}<b>${esc(name(s))}</b><span>${s.state === 'on' ? 'Allumée' : s.state === 'off' ? 'Éteinte' : 'Indisponible'}</span><i class="switch"></i></button>`).join('')}</div>`;
  }, { domains: ['light'] }),
  climate: meta('Température idéale', 'Maison', 'ha', 'thermo', 'La consigne du thermostat, au degré près.', c => {
    const s = filtered(c, c.sources.states('climate'))[0]; if (!s) return empty('Aucun thermostat connecté');
    return `<div class="thermostat"><span>${esc(name(s))}</span><div class="thermo-dial"><span>Consigne</span><strong>${num(s.attributes.temperature, 1)}°</strong><small>${s.state === 'off' ? 'Chauffage arrêté' : 'Chauffage actif'}</small></div><div class="thermo-actions"><button class="round-button" data-action="temp" data-id="${esc(s.entity_id)}" data-step="-0.5" aria-label="Baisser la température">−</button><span>Pièce : ${num(s.attributes.current_temperature, 1)}°</span><button class="round-button" data-action="temp" data-id="${esc(s.entity_id)}" data-step="0.5" aria-label="Augmenter la température">+</button></div></div>`;
  }, { domains: ['climate'], tone: 'peach' }),
  spotify: meta('Dans vos oreilles', 'Quotidien', 'both', 'music', 'Votre compte Spotify intégré à Home Assistant : lecture, volume et choix de la sortie audio.', c => {
    const d = c.sources.data.spotify; if (!d?.track) return empty('Rien en lecture', 'Le morceau en cours dans Spotify apparaîtra ici via Cockpit.');
    return `<div class="music-player"><div class="album-art">${d.track.art ? `<img src="${esc(safeUrl(d.track.art))}" alt="Pochette de l’album" loading="lazy">` : '<span class="album-sun"></span><span class="album-word">DIVE</span>'}</div><div class="song"><strong>${esc(d.track.title)}</strong><span>${esc(d.track.artist)}</span><small>${esc(d.device?.name || 'Spotify')}</small></div></div><div class="track-progress"><i style="width:${Math.max(0, Math.min(100, (d.progressMs || 0) / Math.max(1, d.track.durationMs || 1) * 100))}%"></i></div><div class="music-bottom"><span>${d.playing ? 'En lecture' : 'En pause'}</span>${c.sources.demo ? `<button class="round-button" data-action="demo-music" aria-label="${d.playing ? 'Mettre en pause' : 'Lire'}">${icon(d.playing ? 'pause' : 'play')}</button>` : `<a class="text-button" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(d.track.url || 'https://open.spotify.com/'))}">Ouvrir Spotify ${icon('arrow')}</a>`}</div>`;
  },{domains:['media_player']}),
  calendar: meta('À l’agenda', 'Quotidien', 'both', 'calendar', 'Vos rendez-vous Cockpit et Home Assistant.', c => {
    const raw = [...(c.sources.data.calendar?.events || []), ...(c.sources.data.haCalendar || [])];
    const list = raw.map(e => ({ ...e, time: new Date(typeof e.start === 'object' ? e.start.dateTime || e.start.date : e.start), title: e.title || e.summary })).filter(e => !Number.isNaN(e.time.valueOf())).sort((a, b) => a.time - b.time);
    if (!list.length) return empty('L’agenda est libre', 'Les événements de vos calendriers connectés s’afficheront ici.');
    return `<div class="calendar-list">${list.slice(0, c.detail ? 30 : 3).map((e, i) => `<div><span class="event-time">${e.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}<small>${e.time.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</small></span><i class="event-line line-${i % 3}"></i><span><b>${esc(e.title)}</b><small>${esc(e.calendar || e.source || 'Calendrier')}</small></span></div>`).join('')}</div><div class="card-bottom-note">Une place pour ce qui compte.</div>`;
  }),
  todos: meta('À votre rythme', 'Quotidien', 'local', 'check', 'Une liste locale au prototype, pour avancer simplement.', c => {
    const items = c.todos;
    return `<div class="todo-summary">${items.filter(t => !t.done).length} choses à faire<span>Aucune urgence.</span></div><div class="todo-list">${items.slice(0, c.detail ? 100 : 4).map(t => `<label class="todo-row ${t.done ? 'done' : ''}"><input type="checkbox" data-action="todo-check" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><span>${esc(t.title)}</span></label>`).join('')}</div><form data-form="todo" class="inline-add"><input name="title" aria-label="Nouvelle tâche" placeholder="Ajouter quelque chose…" maxlength="200" required><button aria-label="Ajouter la tâche">${icon('plus')}</button></form>`;
  }),
  notes: meta('Un coin pour vos idées', 'Quotidien', 'local', 'note', 'Un mémo personnel, conservé dans ce navigateur.', c => `<textarea class="note-input" data-note="${esc(c.widget.id)}" aria-label="Votre note" placeholder="Une idée, une envie, quelque chose à ne pas oublier…" maxlength="20000">${esc(c.note)}</textarea><div class="note-foot">${icon('note')} Enregistré sur cet écran</div>`, { tone: 'butter' }),
  scenes: meta('Les bonnes ambiances', 'Maison', 'ha', 'sun', 'Lancez les scènes de votre maison en un geste.', c => {
    const list = filtered(c, c.sources.states('scene')); if (!list.length) return empty('Aucune scène disponible');
    return `<div class="scene-list">${list.slice(0, c.detail ? 30 : 4).map((s, i) => `<button data-action="scene" data-id="${esc(s.entity_id)}"><span class="scene-icon sc-${i % 3}">${icon(['sun', 'logout', 'play'][i % 3])}</span><b>${esc(name(s))}</b>${icon('arrow')}</button>`).join('')}</div>`;
  }, { domains: ['scene'] }),
  sensors: meta('Vos capteurs', 'Maison', 'ha', 'thermo', 'Température, batterie, humidité : les valeurs utiles.', c => {
    const list = filtered(c, available(c.sources.states('sensor'))); if (!list.length) return empty('Aucun capteur disponible');
    return `<div class="sensor-list">${list.slice(0, c.detail ? 100 : 5).map(s => `<div><span>${esc(name(s))}</span><strong>${value(s)}</strong></div>`).join('')}</div>`;
  }, { domains: ['sensor'] }),
  server: meta('Votre infrastructure', 'Système', 'ha', 'server', 'Les capteurs Proxmox, CPU et mémoire du serveur.', c => {
    const list = filtered(c, c.sources.states('sensor').filter(s => /proxmox|pve/i.test(s.entity_id + name(s))));
    if (!list.length) return empty('Aucun capteur Proxmox', 'Connectez l’intégration Proxmox à Home Assistant.');
    return `<div class="server-intro"><span class="device-avatar">${icon('server')}</span><div><b>Proxmox</b><span>${list.length} mesures disponibles</span></div><span class="mini-tag green">Connecté</span></div><div class="sensor-list">${list.slice(0, c.detail ? 100 : 4).map(s => `<div><span>${esc(name(s))}</span><strong>${value(s)}</strong></div>`).join('')}</div>`;
  }, { domains: ['sensor'] }),
  updates: meta('Tout garder à jour', 'Système', 'ha', 'refresh', 'Les nouvelles versions signalées par Home Assistant.', c => {
    const list = filtered(c, c.sources.states('update')); if (!list.length) return empty('Aucune information de mise à jour');
    return `<div class="todo-summary">${list.filter(s => s.state === 'on').length} mise(s) à jour<span>Un œil sur vos versions.</span></div><div class="updates-list">${list.slice(0, c.detail ? 50 : 4).map(s => `<div>${icon('refresh')}<span><b>${esc(name(s))}</b><small>${esc(s.attributes.latest_version || s.attributes.installed_version || '')}</small></span><span class="mini-tag ${s.state === 'on' ? 'orange' : 'green'}">${s.state === 'on' ? 'Disponible' : 'À jour'}</span></div>`).join('')}</div><p class="subtle">Installation depuis Home Assistant.</p>`;
  }, { domains: ['update'] }),
  boards: meta('À garder de côté', 'Veille', 'feedme', 'book', 'Vos collections d’articles sauvegardées dans Cockpit.', c => {
    const list = c.sources.data.boards; if (!list?.length) return empty('Vos collections sont dans Cockpit');
    return `<div class="boards-list">${list.map((b, i) => `<button data-action="board" data-id="${esc(b.id)}"><span class="board-cover cover-${i % 3}">${icon('book')}</span><span><b>${esc(b.name)}</b><small>${b.items?.length || 0} article(s)</small></span>${icon('arrow')}</button>`).join('')}</div>`;
  }),
  quotas: meta('De la place pour créer', 'Agents', 'feedme', 'bolt', 'Les quotas IA suivis par vos connexions Cockpit.', c => {
    const sources = c.sources.data.quotas?.sources || [];
    const list = sources.flatMap(s => (s.providers || []).flatMap(p => (p.windows || []).map(w => ({ ...w, name: p.name, stale: s.stale || p.stale }))));
    if (!list.length) return empty('Aucun quota configuré', 'Configurez le suivi des quotas dans Cockpit.');
    return `<div class="quota-list">${list.slice(0, c.detail ? 30 : 4).map(w => { const left = w.remainingPercent ?? 100 - w.usedPercent; return `<div><span><b>${esc(w.name)}</b><small>${esc(w.label)}${w.stale ? ' · dernière valeur connue' : ''}</small></span><strong>${num(left)}<small>%</small></strong><div class="meter"><i style="width:${Math.max(0, Math.min(100, left))}%"></i></div></div>`; }).join('')}</div><div class="card-bottom-note">Quota restant</div>`;
  }),
  transit: meta('Le prochain départ', 'Quotidien', 'ha', 'train', 'Les capteurs train et RER de Home Assistant.', c => {
    const list = filtered(c, c.sources.states('sensor').filter(s => /rer|train|idfm|departure/i.test(s.entity_id + name(s))));
    if (!list.length) return empty('Aucun départ connecté', 'Ajoutez votre capteur de transport dans Home Assistant.');
    return `<div class="transit-title"><span class="line-badge">${c.sources.demo ? 'D' : icon('train')}</span><div><b>${esc(name(list[0]))}</b><small>Prochain départ</small></div></div><div class="departure"><strong>${esc(list[0].state)}</strong><span>${esc(list[0].attributes.unit_of_measurement || '')}</span></div><div class="card-bottom-note">${c.sources.demo ? 'Horaires de démonstration' : 'Valeur communiquée par Home Assistant'}</div>`;
  }, { domains: ['sensor'] }),
  cameras: meta('Un regard sur la maison', 'Maison', 'ha', 'camera', 'Les caméras et leurs images dans Home Assistant.', c => {
    const list = filtered(c, c.sources.states('camera'));
    if (c.sources.demo) return `<div class="camera-demo">${icon('camera')}<b>L’entrée de la maison</b><span>Emplacement caméra · démonstration</span></div>`;
    if (!list.length) return empty('Aucune caméra connectée');
    const s = list[0], token = s.attributes.access_token, base = c.sources.ha?.baseUrl;
    return token && base ? `<div class="camera-live"><img src="${esc(base + '/api/camera_proxy/' + encodeURIComponent(s.entity_id) + '?token=' + encodeURIComponent(token))}" alt="${esc(name(s))}"><span>${esc(name(s))}</span></div><p class="subtle">Image fixe à l’ouverture de la vue.</p>` : empty('Image indisponible');
  }, { domains: ['camera'], size: 'wide' }),
};
Object.assign(modules, {
  devices: meta('Les appareils', 'Maison', 'ha', 'grid', 'Prises, ventilateurs, volets, serrures et leurs états.', c => {
    const domains = ['switch', 'input_boolean', 'fan', 'cover', 'lock', 'vacuum', 'valve', 'humidifier', 'water_heater', 'binary_sensor'];
    const list = filtered(c, domains.flatMap(d => c.sources.states(d)));
    if (!list.length) return empty('Aucun appareil disponible');
    return `<div class="sensor-list">${list.slice(0, c.detail ? 100 : 5).map(s => `<div><span>${esc(name(s))}</span>${['switch', 'input_boolean', 'fan'].includes(s.entity_id.split('.')[0]) ? `<button class="button" data-action="toggle-device" data-id="${esc(s.entity_id)}" ${['unavailable', 'unknown'].includes(s.state) ? 'disabled' : ''} aria-pressed="${s.state === 'on'}">${s.state === 'on' ? 'Allumé' : s.state === 'off' ? 'Éteint' : esc(s.state)}</button>` : `<strong>${esc(s.state)}</strong>`}</div>`).join('')}</div>`;
  }, { domains: ['switch', 'input_boolean', 'fan', 'cover', 'lock', 'vacuum', 'valve', 'humidifier', 'water_heater', 'binary_sensor'] }),
  automations: meta('Les automatismes', 'Maison', 'ha', 'bolt', 'Activer une automatisation ou lancer un script.', c => {
    const list = filtered(c, [...c.sources.states('automation'), ...c.sources.states('script')]);
    if (!list.length) return empty('Aucun automatisme connecté');
    return `<div class="scene-list">${list.slice(0, c.detail ? 100 : 4).map(s => `<button data-action="${s.entity_id.startsWith('script.') ? 'run-script' : 'toggle-device'}" data-id="${esc(s.entity_id)}" ${['unavailable', 'unknown'].includes(s.state) ? 'disabled' : ''}><span class="scene-icon">${icon('bolt')}</span><b>${esc(name(s))}</b><span class="mini-tag green">${s.entity_id.startsWith('script.') ? 'Lancer' : s.state === 'on' ? 'Active' : 'Inactive'}</span></button>`).join('')}</div>`;
  }, { domains: ['automation', 'script'] }),
  guests: meta('VM & conteneurs', 'Système', 'ha', 'server', 'Les états de vos machines virtuelles et conteneurs.', c => {
    const list = filtered(c, (c.sources.data.states || []).filter(s => /qemu|lxc|\bvm\b|vm_|container|conteneur/i.test(s.entity_id + ' ' + name(s))));
    if (!list.length) return empty('Aucune VM ou conteneur détecté', 'Les mesures remontées par votre intégration Proxmox apparaîtront ici.');
    return `<div class="sensor-list">${list.slice(0, c.detail ? 100 : 5).map(s => `<div><span>${esc(name(s))}</span><strong>${value(s)}</strong></div>`).join('')}</div><p class="subtle">Le pilotage des machines reste dans Cockpit.</p>`;
  }, { domains: ['sensor', 'binary_sensor'] }),
});
export const presets = {
  overview: ['weather', 'rooms', 'agents', 'energy', 'rss', 'system', 'spotify', 'calendar', 'todos', 'notes'],
  home: ['rooms', 'weather', 'scenes', 'lights', 'climate', 'energy', 'transit', 'calendar', 'devices', 'automations'],
  news: ['rss', 'boards', 'notes'],
  agents: ['agents', 'quotas', 'todos', 'notes'],
  system: ['system', 'server', 'updates', 'sensors', 'guests'],
};
