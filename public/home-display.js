import { read, write, esc, icon, num, uid } from './core.js';
import { modules } from './modules.js';

const key = 'mb.home.display.v1';
export const headerTypes = { 'h-date': 'Date', 'h-clock': 'Heure', 'h-temps': 'Températures int. / ext.', 'h-lights': 'Lampes allumées', 'h-fullscreen': 'Bouton plein écran' };
const defaults = () => ({ accent: '#F5C542', bg: { preset: 'chaud' }, header: [['h-date','left'],['h-clock','center'],['h-temps','right'],['h-fullscreen','right']].map(([type, zone]) => ({ id: 'header-' + type, type, zone, options: {} })) });
export const color = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '';
export function sanitizeDisplay(data) {
  const base = defaults(); if (!data || typeof data !== 'object') return base;
  base.accent = color(data.accent) || base.accent;
  if (data.bg && typeof data.bg === 'object') base.bg = {
    preset: String(data.bg.preset || 'chaud'), color: color(data.bg.color),
    image: /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(data.bg.image || '') && data.bg.image.length < 1500000 ? data.bg.image : '',
    dim: Math.max(0, Math.min(.8, Number(data.bg.dim) || 0))
  };
  if (Array.isArray(data.header)) base.header = data.header.filter(m => m && /^[\w-]{1,80}$/.test(m.id) && (Object.prototype.hasOwnProperty.call(headerTypes,m.type) || Object.prototype.hasOwnProperty.call(modules,m.type))).slice(0, 20).map(m => ({
    ...m, width: Number.isInteger(m.width) && m.width >= 1 && m.width <= 4 ? m.width : undefined, height: Number.isInteger(m.height) && m.height >= 1 && m.height <= 4 ? m.height : 2, title: String(m.title || '').slice(0, 80), zone: ['left','center','right'].includes(m.zone) ? m.zone : 'right',
    options: { ...(m.options && typeof m.options==='object' && !Array.isArray(m.options) ? m.options : {}), fmt: ['long','full','short','day','num','s'].includes(m.options?.fmt) ? m.options.fmt : '', hSize: ['s','','l','xl'].includes(m.options?.hSize) ? m.options.hSize : '', hFont: ['','outfit','unbounded','syne','fraunces','dmserif','cormorant','comfortaa','orbitron','righteous','dancing'].includes(m.options?.hFont) ? m.options.hFont : '', hColor: color(m.options?.hColor) }
  }));
  return base;
}
export let homeDisplay = sanitizeDisplay(read(key, null));
export function saveDisplay() { const saved=write(key,homeDisplay); if (saved) window.dispatchEvent(new Event('mb:display-saved')); return saved; }
export function importDisplay(data) { homeDisplay = sanitizeDisplay(data); saveDisplay(); }
export const spanWidth = m => Number.isInteger(m.width) && m.width >= 1 && m.width <= 4 ? m.width : (m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1);
export function addHeader(type) { if (!headerTypes[type] || homeDisplay.header.length >= 20) return; homeDisplay.header.push({ id: uid(), type, zone: 'right', options: {} }); saveDisplay(); }
export const fonts = [['','Standard',''],['outfit','Moderne',"'Outfit',sans-serif"],['unbounded','Affirmée',"'Unbounded',sans-serif"],['syne','Design',"'Syne',sans-serif"],['fraunces','Élégante',"'Fraunces',Georgia,serif"],['dmserif','Magazine',"'DM Serif Display',Georgia,serif",400],['cormorant','Raffinée',"'Cormorant Garamond',Georgia,serif"],['comfortaa','Douce',"'Comfortaa',sans-serif"],['orbitron','Futuriste',"'Orbitron',sans-serif"],['righteous','Rétro',"'Righteous',sans-serif",400],['dancing','Manuscrite',"'Dancing Script',cursive"]];
const grad = (a,b,c) => `linear-gradient(160deg,${a} 0%,${b} 48%,${c} 100%) fixed`;
export const backgrounds = [['chaud','Chaud','#3d3946 linear-gradient(160deg,#7d6553 0%,#5e5049 38%,#4a4351 72%,#3d3946 100%) no-repeat fixed'],['nuit','Nuit',grad('#2F4A7A','#1B2740','#10141F')],['ocean','Océan',grad('#2E7C8A','#1A4A57','#0E242C')],['foret','Forêt',grad('#4F6B4A','#2E4234','#1A231D')],['aurore','Aurore',grad('#8A5A8F','#4E3866','#241B33')],['ardoise','Ardoise',grad('#5B6270','#3A3F48','#22252B')],['noir','Noir','#000000']];
export function applyDisplay(home) {
  if (!home) { document.body.style.removeProperty('background'); document.body.style.removeProperty('--accent'); return; }
  const b = homeDisplay.bg;
  document.body.style.background = b.image ? `#000 linear-gradient(rgba(0,0,0,${b.dim}),rgba(0,0,0,${b.dim})),url("${b.image}") center / cover no-repeat fixed` : color(b.color) || (backgrounds.find(p => p[0] === b.preset) || backgrounds[0])[2];
  document.body.style.setProperty('--accent', homeDisplay.accent);
}
export const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
export const fullscreenSupported = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
export function enterFullscreen() {
  const el = document.documentElement, request = el.requestFullscreen || el.webkitRequestFullscreen;
  try { const result = request?.call(el, { navigationUI: 'hide' }); result?.catch(() => {}); } catch { /* Requires a user gesture. */ }
}
export function toggleFullscreen() {
  if (!fullscreenElement()) return enterFullscreen();
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  try { const result = exit?.call(document); result?.catch(() => {}); } catch { /* Browser controls remain available. */ }
}
export function formatHeaderDate(date, format = 'long') {
  if (format === 'num') return date.toLocaleDateString('fr-FR');
  const options = format === 'short' ? {weekday:'short',day:'numeric',month:'short'} : format === 'day' ? {weekday:'long',day:'numeric'} : {weekday:'long',day:'numeric',month:'long',...(format === 'full' ? {year:'numeric'} : {})};
  const text = date.toLocaleDateString('fr-FR',options); return text.charAt(0).toUpperCase()+text.slice(1);
}
// Téléphone : les boutons fixes (crayon, ou Fond · Module · Terminé) quittent la zone droite qui défile pour rester toujours visibles,
// et la pastille « Plein écran », inutile là où l’écran ne peut pas passer en plein écran (iPhone), n’apparaît qu’en personnalisation.
export function homeHeader({ editing, sources, title, nativeTitle, phone = false }) {
  const now = new Date();
  const chip = (glyph, content) => `<span class="hchip">${icon(glyph)}<span class="hchip-text">${content}</span></span>`;
  function item(m) {
    if (phone && !editing && m.type === 'h-fullscreen' && !fullscreenSupported()) return '';
    const o = m.options || {}, label = headerTypes[m.type] || m.title || nativeTitle(m.type);
    let body;
    if (m.type === 'h-date') {
      body = `<h1 class="home-date">${esc(title || formatHeaderDate(now,o.fmt))}</h1>`;
    } else if (m.type === 'h-clock') body = `<time class="home-clock" data-home-clock="${o.fmt === 's' ? 's' : ''}">${now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',...(o.fmt === 's' ? {second:'2-digit'} : {})})}</time>`;
    else if (m.type === 'h-fullscreen') body = fullscreenSupported() ? `<button class="card hov round-btn" data-action="fullscreen" aria-label="${fullscreenElement() ? 'Quitter le plein écran' : 'Plein écran'}">${icon('expand')}</button>` : chip('expand','Plein écran');
    else if (m.type === 'h-lights') body = chip('bulb', sources.states('light').filter(s => s.state === 'on').length + ' allumées');
    else if (m.type === 'h-temps') {
      const ts = sources.states('sensor').filter(s => s.attributes.device_class === 'temperature' && Number.isFinite(Number(s.state)));
      const inside = ts.length ? num(ts.reduce((sum,s) => sum + Number(s.state),0)/ts.length,1) + '°' : '—';
      body = chip('thermo',`<span class="muted">Int.</span> ${inside} <span class="muted">| Ext.</span> ${num(sources.states('weather')[0]?.attributes.temperature)}°`);
    } else body = `<button class="hchip is-btn" data-action="detail" data-id="${esc(m.id)}">${icon('grid')}<span class="hchip-text">${esc(m.title || nativeTitle(m.type))}</span></button>`;
    const scale = {s:.75,l:1.3,xl:1.7}[o.hSize] || 1, base = m.type === 'h-date' ? 30 : m.type === 'h-clock' ? 40 : 15;
    const family = (fonts.find(f => f[0] === o.hFont) || fonts[0])[2];
    const tools = editing ? `<span class="hitem-tools">${m.type === 'h-fullscreen' ? '' : `<button data-action="header-config" data-id="${esc(m.id)}" aria-label="Réglages de ${esc(label)}">${icon('settings')}</button>`}<button data-action="header-remove" data-id="${esc(m.id)}" aria-label="Retirer ${esc(label)} de l’en-tête">${icon('close')}</button></span>` : '';
    return `<div class="hitem ht-${esc(m.type)} ${(fonts.find(f=>f[0]===o.hFont) || [])[3] === 400 ? 'hf-regular' : ''} ${color(o.hColor) ? 'has-color' : ''}" data-hitem="${esc(m.id)}" data-mod="${esc(m.id)}" style="font-size:${base*scale}px;${color(o.hColor) ? '--hc:' + color(o.hColor) + ';' : ''}${family ? 'font-family:' + family + ';' : ''}"><div class="hitem-body" ${editing ? 'inert' : ''}>${body}</div>${tools}</div>`;
  }
  const fixed = editing ? `<button class="btn-glass" data-action="background">${icon('sun')} Fond</button><button class="btn-glass" data-action="library">${icon('plus')} Module</button><button class="btn-solid" data-action="edit" aria-label="Terminer la personnalisation">${icon('check')} Terminé</button>` : `<button class="card hov round-btn" data-action="edit" aria-label="Personnaliser cette page">${icon('edit')}</button>`;
  return `<header class="page-head is-home ${editing ? 'is-editing' : ''}">${['left','center','right'].map(zone => `<div class="hzone hz-${zone}" data-hzone="${zone}">${homeDisplay.header.filter(m => m.zone === zone).map(item).join('')}${zone === 'right' && !phone ? `<span class="head-fixed">${fixed}</span>` : ''}</div>`).join('')}${phone ? `<span class="head-fixed">${fixed}</span>` : ''}</header>`;
}
