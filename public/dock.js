import { esc, icon, iconNames } from './core.js';

// Dock (rail de gauche) : ordre des pages, liens, séparateurs et icône de chaque entrée, enregistrés dans mb.dock.v1.
// Une icône s’écrit « nom » (pictogramme de core.js), « x:nom » (pictogrammes ci-dessous), « h:nom » (HD.IC) ou « e:🌐 » (emoji).
const extra = {
  heart: '<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-4 5 5 0 0 1 9 4c-2 4.6-9 9-9 9Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 4 6.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zm4 5h4"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15m6-12v15"/>',
  pin: '<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="m7 8 10-5M6 12h4m-4 4h4"/><circle cx="15" cy="14" r="3"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  newspaper: '<path d="M4 5h13v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm13 4h3v10a2 2 0 0 1-2 2M8 9h5m-5 4h5m-5 4h3"/>',
  gamepad: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10.5v4m-2-2h4m6-.5h.01m3 1.5h.01"/>',
  cart: '<path d="M3 4h2l2.5 11h11L21 7H6.5"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13m0-13S10 3 7.5 4.5 9 8 12 8Zm0 0s2-5 4.5-3.5S15 8 12 8Z"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2Zm13 7.5h.01"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 13h18"/>',
  chart: '<path d="M3 3v18h18M7 16v-4m5 4V8m5 8V9"/>',
  pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m5 0h5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0m-3.5 3.5h.01"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 10v4m4-4v4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zm-9 10 9 5 9-5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5M5 4h14l2 9v7H3v-7z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8m-9 4h4"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3 8 21m8-18-2 18"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9m-4 4 3 3m-6 0 2 2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5m0 3.5h.01"/>',
  flag: '<path d="M5 21V4h12l-2 4 2 4H5"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0zm0 2H4a3 3 0 0 0 3 4m10-4h3a3 3 0 0 1-3 4m-5 4v4m-4 3h8l-1-3H9z"/>',
  rocket: '<path d="M12 15 9 12c1.5-5 5-9 11-9 0 6-4 9.5-9 11zm-3-3H5l3-4h4m0 7v4l4-3v-4m-10 1c-2 1-2 4-2 4s3 0 4-2"/>',
  wrench: '<path d="M15 4a5 5 0 0 0-5.6 6.6L3 17v4h4l6.4-6.4A5 5 0 0 0 20 9l-3 1-3-3 1-3z"/>',
  puzzle: '<path d="M4 7h4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H4v-4a2 2 0 1 0 0-4z"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15m-1-1 7-7"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-5-4-7-5-12-2 2-3 4-3 6-1-1-2-2-2-4-2 2-4 5-4 10a7 7 0 0 0 7 7Z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  umbrella: '<path d="M3 12a9 9 0 0 1 18 0zm9 0v7a2 2 0 0 0 4 0"/>',
  car: '<path d="M5 17H3v-5l2-5h14l2 5v5h-2M5 12h14"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/>',
  plane: '<path d="M10.5 21 12 17l-1-5-7 2v-2.5L11 7V3.5a1 1 0 0 1 2 0V7l7 4.5V14l-7-2-1 5 1.5 4z"/>',
  coffee: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zm13 2h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3m4-3v3"/>',
  cutlery: '<path d="M6 3v7a2 2 0 0 0 4 0V3M8 3v18m9-18c-2 0-3 3-3 7h3v11"/>',
  bed: '<path d="M3 19V6m0 8h18v5M3 11h6V8h8a4 4 0 0 1 4 4v2"/>',
  dumbbell: '<path d="M6 7v10M3 9v6m15-8v10m3-8v6M6 12h12"/>',
  graduation: '<path d="m2 9 10-5 10 5-10 5zm4 2v5c3 2.5 9 2.5 12 0v-5m4-2v6"/>',
};
// Mots-clés français pour la recherche (les noms techniques restent cherchables).
const words = { home: 'maison accueil', grid: 'grille pièces', rss: 'flux veille', chat: 'agents discussion', kanban: 'projets tableau', server: 'système serveur', settings: 'réglages', calendar: 'agenda', note: 'notes', book: 'livre lecture', music: 'musique', camera: 'caméra photo', folder: 'dossier', clock: 'horloge heure', bulb: 'lumière', thermo: 'température', bolt: 'énergie éclair', cloud: 'nuage météo', sun: 'soleil', star: 'étoile favori', heart: 'cœur', user: 'personne profil', users: 'groupe famille', mail: 'courriel', bell: 'cloche notification', map: 'carte', pin: 'lieu position', globe: 'monde terre', compass: 'boussole', headphones: 'casque audio', mic: 'micro', image: 'photo', newspaper: 'journal actualité', gamepad: 'jeu manette', cart: 'courses panier', gift: 'cadeau', wallet: 'portefeuille argent', briefcase: 'travail', chart: 'graphique statistiques', pie: 'camembert', terminal: 'console', cpu: 'processeur', database: 'base données', battery: 'batterie', layers: 'calques', list: 'liste', inbox: 'boîte réception', tag: 'étiquette', shield: 'sécurité bouclier', key: 'clé', eye: 'œil voir', help: 'aide question', flag: 'drapeau', trophy: 'trophée', rocket: 'fusée', wrench: 'outil clé', palette: 'couleurs', leaf: 'feuille nature', flame: 'feu flamme', wind: 'vent', umbrella: 'parapluie pluie', car: 'voiture', plane: 'avion voyage', coffee: 'café', cutlery: 'repas cuisine', bed: 'lit chambre', dumbbell: 'sport', graduation: 'école études', train: 'transport' };
export const emojiGroups = {
  'Maison et vie': '🏠 🏡 🏢 🛋️ 🛏️ 🚪 🪟 🛁 🚿 🧺 🍳 🍽️ ☕ 🍷 🍺 🧃 🍎 🥖 🛒 🧹 🔑 🔒 💡 🕯️ 🔌 🔋 🌡️ 🧯 🪴 🐶 🐱 👶 👨‍👩‍👧 ❤️ 🎂 🎁',
  'Travail et outils': '💼 📁 📂 🗂️ 📋 📌 📎 ✏️ 🖊️ 📝 📒 📓 📚 📖 🗓️ 📅 ⏰ ⏱️ 🧮 📊 📈 📉 🧾 💰 💳 🏦 ⚙️ 🛠️ 🔧 🔨 🧰 🧪 🔬 🧠 🎯 ✅ ☑️ 🏷️',
  'Technologie': '💻 🖥️ ⌨️ 🖱️ 🖨️ 📱 📲 ☎️ 📞 📡 🛰️ 🤖 👾 🕹️ 🎮 💾 💿 📀 🗄️ 🔍 🔎 🔗 🌐 📶 🛜 🔐 🧩 ⚡ 🔦 📷 📸 🎥 📹 📺 📻 🎙️ 🎧 🔊 🔔',
  'Médias et loisirs': '🎵 🎶 🎸 🎹 🥁 🎤 🎬 🎞️ 🍿 🎨 🖼️ 📰 🗞️ 📣 📢 ✉️ 📧 📨 💬 💭 🗨️ 🎲 ♟️ 🎳 ⚽ 🏀 🎾 🚴 🏃 🧘 🏋️ 🏊 ⛷️ 🎣 🏕️ 🎭 🎟️ 🏆 🥇',
  'Nature et météo': '☀️ 🌤️ ⛅ 🌥️ ☁️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ 🌬️ 🌪️ 🌈 ☂️ 💧 🌊 🔥 🌙 ⭐ 🌟 ✨ 🪐 🌍 🌎 🌏 🗺️ 🏔️ ⛰️ 🌋 🌲 🌳 🌴 🌵 🌷 🌻 🍀 🍁 🐝 🦋',
  'Transports et lieux': '🚗 🚕 🚙 🚌 🚎 🚑 🚒 🚓 🚲 🛵 🏍️ 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🚀 🛸 🚁 ⛵ 🚢 ⚓ ⛽ 🚦 🅿️ 🗼 🗽 🏰 🏛️ ⛪ 🏥 🏫 🏪 🏟️ 🎡 🧭 📍',
  'Symboles': '⭐ ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 ⚠️ ⛔ 🚫 ✔️ ❌ ❓ ❗ ➕ ➖ ♻️ ⚛️ ☮️ ☯️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 🔶 🔷 💠 🔆 🏁',
};

const hdIcons = () => globalThis.HD?.IC || {};
const svg = inner => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
// Bibliothèque : chaque entrée { ref, search, group }.
export function iconLibrary() {
  const list = [], seen = new Set();
  const add = (ref, name, group) => { if (!seen.has(ref)) { seen.add(ref); list.push({ ref, group, search: `${name} ${words[name] || ''}`.toLowerCase() }); } };
  for (const name of iconNames) add(name, name, 'Pictogrammes');
  for (const name of Object.keys(extra)) add('x:' + name, name, 'Pictogrammes');
  for (const name of Object.keys(hdIcons())) add('h:' + name, name, 'Pictogrammes');
  for (const [group, text] of Object.entries(emojiGroups)) for (const e of text.split(' ')) add('e:' + e, group, group);
  return list;
}
export function validIcon(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 40) return false;
  if (ref.startsWith('e:')) { const e = ref.slice(2); return e.length > 0 && e.length <= 16 && !/[<>&"'\s]/.test(e); }
  if (ref.startsWith('x:')) return Object.hasOwn(extra, ref.slice(2));
  if (ref.startsWith('h:')) return /^\w{1,30}$/.test(ref.slice(2));
  return iconNames.includes(ref);
}
export function dockIcon(ref) {
  if (typeof ref === 'string' && ref.startsWith('e:') && validIcon(ref)) return `<span class="dock-emoji" aria-hidden="true">${esc(ref.slice(2))}</span>`;
  if (typeof ref === 'string' && ref.startsWith('x:') && validIcon(ref)) return svg(extra[ref.slice(2)]);
  if (typeof ref === 'string' && ref.startsWith('h:')) { const d = hdIcons()[ref.slice(2)]; if (typeof d === 'string') return svg(`<path d="${esc(d)}"/>`); }
  return icon(validIcon(ref) ? ref : 'grid');
}

// Liens d’origine du rail, présents seulement quand Cockpit est servi par son serveur.
export const builtinLinks = {
  godseye: { label: 'God’s Eye View', href: '/godseye.html', icon: 'e:🌐', newTab: false },
  worldmonitor: { label: 'World Monitor', href: '/worldmonitor.html', icon: 'e:🛰️', newTab: false },
  radio: { label: 'OpenRadio', href: 'https://openradio.space/', icon: 'e:📻', newTab: true },
};
// Anciennes adresses d’un lien d’origine, remplacées dans les docks déjà enregistrés.
const legacyLinks = { radio: 'https://radio.garden/' };
export const validHref = href => typeof href === 'string' && href.length <= 500 && !/[\s<>"']/.test(href) && (/^https?:\/\/[^/]/i.test(href) || /^\/(?!\/)/.test(href));
// L’entrée Paramètres fait partie du dock : déplaçable et d’icône réglable, mais jamais retirée.
const settingsEntries = () => [{ kind: 'sep', id: 'sep-settings' }, { kind: 'settings', id: 'settings' }];
export const defaultDock = (pageIds, serverMode = false) => [...pageIds.map(id => ({ kind: 'page', id })), ...(serverMode ? Object.entries(builtinLinks).map(([id, l]) => ({ kind: 'link', id, ...l })) : []), ...settingsEntries()];
export function sanitizeDock(value, pageIds, serverMode = false) {
  if (!Array.isArray(value)) return defaultDock(pageIds, serverMode);
  const out = [], seen = new Set(), text = v => typeof v === 'string' ? v.trim().slice(0, 60) : '';
  for (let item of value.slice(0, 80)) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{1,60}$/.test(item.id) || seen.has(item.id)) continue;
    if (item.kind === 'link' && legacyLinks[item.id] === item.href) item = { ...item, ...builtinLinks[item.id] };
    const ico = validIcon(item.icon) ? { icon: item.icon } : {}, label = text(item.label);
    if (item.kind === 'settings' && item.id === 'settings') out.push({ kind: 'settings', id: 'settings', ...ico, ...(label ? { label } : {}) });
    else if (item.id === 'settings') continue;
    else if (item.kind === 'page' && pageIds.includes(item.id)) out.push({ kind: 'page', id: item.id, ...ico, ...(label ? { label } : {}) });
    else if (item.kind === 'sep' && !pageIds.includes(item.id)) out.push({ kind: 'sep', id: item.id });
    else if (item.kind === 'link' && !pageIds.includes(item.id) && validHref(item.href) && (serverMode || !builtinLinks[item.id])) out.push({ kind: 'link', id: item.id, label: label || 'Lien', href: item.href, icon: ico.icon || 'link', newTab: item.newTab === true });
    else continue;
    seen.add(item.id);
  }
  for (const id of pageIds) if (!seen.has(id)) out.push({ kind: 'page', id });
  if (!seen.has('settings')) out.push(...settingsEntries().filter(e => !seen.has(e.id)));
  return out;
}
// Entrées affichées sur un écran : pages visibles seulement, sans séparateur en tête, en fin ni doublé.
export function visibleDock(items, visiblePages) {
  const out = [];
  for (const item of items) {
    if ((item.kind === 'page' && !visiblePages.includes(item.id)) || (item.kind === 'link' && !item.href)) continue;
    if (item.kind === 'sep' && (!out.length || out[out.length - 1].kind === 'sep')) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].kind === 'sep') out.pop();
  return out;
}
export function moveDockItem(items, id, to) {
  const from = items.findIndex(i => i.id === id); if (from < 0) return items;
  const next = [...items], [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}
