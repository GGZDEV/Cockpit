import { esc, read, write } from './core.js';
import { selectedTheme } from './preferences.js';
const types={'feedme-settings':'settings',rss:'rss',spotify:'spotify',system:'system',quotas:'ai-usage',boards:'boards',todos:'todo',calendar:'calendar',agents:'agents','feedme-weather':'weather'};
const sizes=new Map();
const overlays=new Set();
export const feedmeOverlayOpen=id=>overlays.has(id);
export function feedmeComponent(c) {
  const type=types[c.widget.type];
  if (!type || (['agents','quotas'].includes(c.widget.type) ? c.sources.status.agents : c.sources.status.feedme) !== 'connected') return '';
  if (c.widget.type === 'spotify' && c.sources.status.ha === 'connected') return '';
  if (c.widget.type === 'calendar' && (c.widget.entity || c.widget.entities?.length)) return '';
  const params=new URLSearchParams({v:String(window.MB_ASSET_VERSION || 'local'),widget:type,id:c.widget.id,theme:selectedTheme(),revision:String(read('mb.feedme.revision',0)),title:c.widget.title || ''});
  const size=sizes.get(c.widget.id) || (type === 'agents' ? 650 : type === 'rss' ? 600 : type === 'system' ? 240 : 340);
  return `<iframe id="feedme-${esc(c.widget.id)}" class="native-feedme-frame${overlays.has(c.widget.id) ? ' is-overlay-open' : ''}" data-native-feedme="${esc(c.widget.id)}" src="integrations/feedme/index.html?${esc(params)}" title="${esc(c.widget.title || types[c.widget.type])} Cockpit" style="height:${size}px" referrerpolicy="same-origin"></iframe>`;
}
window.addEventListener('message',event=>{
  if (event.origin !== location.origin || event.data?.type !== 'metaboard:widget-size') return;
  const frame=document.getElementById('feedme-'+event.data.id);
  if (!frame || event.source !== frame.contentWindow) return;
  const overlay=!!event.data.overlay && !frame.closest('dialog');
  if (overlay) overlays.add(event.data.id); else overlays.delete(event.data.id);
  frame.classList.toggle('is-overlay-open',overlay); frame.closest('[data-widget]')?.classList.toggle('frame-overlay',overlay);
  if (overlay) return;
  const height=Math.max(70,Math.min(16000,Number(event.data.height)||70));
  if (sizes.get(event.data.id) === height) return;
  sizes.set(event.data.id,height); frame.style.height=height+'px';
});

const preferenceKey=key=>/^mb\.feedme\.widget:[\w-]{1,80}$/.test(key) || ['fm-read','fm-favorites','fm-hidden-sources'].includes(key);
export function feedmePreferences() {
  const out={}; try { for (let i=0;i<localStorage.length;i++) { const key=localStorage.key(i); if (preferenceKey(key)) { const value=localStorage.getItem(key); if (value?.length<=200000) out[key]=JSON.parse(value); } } } catch {} return out;
}
export function importFeedmePreferences(values) {
  for (const [key,value] of Object.entries(values || {}).slice(0,100)) if (preferenceKey(key) && JSON.stringify(value).length<=200000) write(key,value);
  write('mb.feedme.revision',Date.now());
}
