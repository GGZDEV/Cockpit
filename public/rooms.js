import { read } from './core.js';

const cache = new WeakMap();
export function roomModel(sources) {
  const states = sources.data.states || [], old = cache.get(sources);
  if (old && old.states === states && old.revision === sources.revision && old.registry === sources.registries && old.original === sources.originalLayout && old.preferences === sources.roomPreferences) return old.value;
  let registry = sources.registries;
  if (sources.demo) {
    const rooms = sources.data.rooms || [];
    registry = { areas: rooms.map(r => ({area_id:r.id,name:r.name})), devices: rooms.map(r => ({id:'demo-'+r.id,area_id:r.id})), entities: rooms.flatMap(r => (r.ids || []).map(entity_id => ({entity_id,area_id:r.id,device_id:'demo-'+r.id}))) };
  }
  const index = HD.Model.buildIndex({areas:registry?.areas || [],devices:registry?.devices || [],entities:registry?.entities || [],states});
  const byState = new Map(states.map(s => [s.entity_id,s]));
  const relevant = st => st && Object.values(HD.Modules.types).some(t => t.pick && t.pick(st));
  const order = sources.roomPreferences?.order || sources.originalLayout?.rooms?.order || [], hidden = sources.roomPreferences?.hidden || sources.originalLayout?.rooms?.hidden || {};
  const rooms = index.rooms.filter(r => !hidden[r.id] && r.ids.some(id => relevant(byState.get(id))));
  rooms.sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : 1000+index.rooms.indexOf(a)) - (order.includes(b.id) ? order.indexOf(b.id) : 1000+index.rooms.indexOf(b)));
  const summaries = rooms.map(room => {
    const list = room.ids.map(id => byState.get(id)).filter(Boolean);
    const temperatures = list.filter(s => HD.Model.isTemp(s) && HD.Model.isAvail(s)).map(s => Number(s.state)).filter(Number.isFinite);
    const climate = list.find(s => s.entity_id.startsWith('climate.') && s.attributes.current_temperature != null);
    const humidities = list.filter(s => HD.Model.isHumidity(s) && HD.Model.isAvail(s)).map(s => Number(s.state)).filter(Number.isFinite);
    const devices = list.filter(HD.Model.isGridEntity).map(s => HD.Model.describe(s,room.name));
    return {...room,hum:humidities.length ? humidities.reduce((a,b)=>a+b,0)/humidities.length : climate?.attributes.current_humidity != null ? Number(climate.attributes.current_humidity) : null,temp:temperatures.length ? temperatures.reduce((a,b)=>a+b,0)/temperatures.length : climate ? Number(climate.attributes.current_temperature) : null,active:devices.filter(d => d.on && d.action).length,total:devices.length,lightTotal:list.filter(s=>s.entity_id.startsWith('light.')).length,lights:list.filter(s=>s.entity_id.startsWith('light.') && s.state === 'on').length};
  });
  HD.Model.setNames({...sources.originalLayout?.names,...sources.roomPreferences?.names});
  const value = {index,states:byState,rooms:summaries};
  cache.set(sources,{states,revision:sources.revision,registry:sources.registries,original:sources.originalLayout,preferences:sources.roomPreferences,value}); return value;
}
export function activeRoom(sources, id) { const rooms=roomModel(sources).rooms; return rooms.find(r=>r.id===id) || rooms[0] || null; }
export function roomLayoutKey(sources, room) {
  const source = sources.demo ? 'demo' : 'ha-'+encodeURIComponent(sources.ha?.baseUrl || read('mb.ha.url','default'));
  return 'room:'+source+':'+encodeURIComponent(room.id);
}
export function stableRoomId(key) {
  let hash=2166136261; for (let i=0;i<key.length;i++) hash=Math.imul(hash^key.charCodeAt(i),16777619);
  return 'room-'+(hash>>>0).toString(36);
}
export const legacyRoomTypes = {'home-weather':'weather','home-rooms':'rooms','home-agenda':'calendar','home-notes':'ha-todos','home-scenes':'scenes',temperature:'temperature',climate:'climate',lights:'lights',devices:'devices',scenes:'scenes',sensor:'sensors',energy:'energy',weather:'weather',calendar:'calendar',transit:'transit',notes:'notes',automations:'automations',media:'ha-media',camera:'cameras',rooms:'rooms',updates:'updates','pve-node':'server','pve-guests':'guests'};
export function importedRoomWidgets(sources, room, profile) {
  if (sources.demo) return null;
  return importedPageWidgets(sources,'room:'+room.id,profile);
}
export function importedPageWidgets(sources,key,profile) {
  const page = sources.originalLayout?.pages?.[key]; if (!Array.isArray(page?.modules)) return null;
  return page.modules.filter(m=>m && legacyRoomTypes[m.type]).map((m,i)=>({
    id:stableRoomId(profile+(sources.ha?.baseUrl || '')+key+':'+m.id+':'+i),type:legacyRoomTypes[m.type],
    width:Math.max(1,Math.min(4,Math.round(Number(m.w)||1))),height:Math.max(1,Math.min(4,Math.round(Number(m.h)||2))),
    size:Number(m.w)>=4 ? 'full' : Number(m.w)>=2 ? 'wide' : 'normal', title:String(m.title||'').slice(0,80),
    scope:m.scope === 'room' ? 'room' : 'all',entities:Array.isArray(m.entities) ? m.entities.filter(id=>typeof id==='string') : null,
    options:m.options && typeof m.options==='object' ? JSON.parse(JSON.stringify(m.options)) : {},
    accent:/^#[0-9a-f]{6}$/i.test(m.options?.accent || '') ? m.options.accent : '',
    ...(m.type === 'notes' ? {importedNote:String(m.options?.text || '').slice(0,20000)} : {})
  }));
}
// Same generated room layout as HomeDashboard/js/layout.js; custom pages are imported above.
export function defaultRoomWidgets(sources,room,profile) {
  const model=roomModel(sources), list=room.ids.map(id=>model.states.get(id)).filter(Boolean);
  const has=type=>list.some(HD.Modules.types[type].auto || HD.Modules.types[type].pick) || type === 'scenes' && [...model.index.visible].some(id=>!model.index.areaOf.get(id) && HD.Modules.types.scenes.pick(model.states.get(id))); 
  const make=(type,width,height)=>({id:stableRoomId(profile+roomLayoutKey(sources,room)+':'+type),type,width,height,size:width>=4?'full':width>=2?'wide':'normal',scope:'room'});
  const climate=has('climate'), temp=has('temperature'), scenes=has('scenes'), center=[];
  if (has('lights')) center.push(make('lights',2,2));
  if (has('devices')) center.push(make('devices',2,2));
  const left=climate ? make('climate',1,4) : temp ? make('temperature',1,4) : null;
  const right=scenes ? make('scenes',1,4) : climate && temp ? make('temperature',1,4) : null;
  const out=[left,...center,right].filter(Boolean);
  if (climate && temp && scenes) out.push(make('temperature',2,2));
  if (!center.length) out.forEach(m=>{m.width=2;m.size='wide';});
  return out;
}
export function spotifyStatesForWidget(sources,widget,room) {
  const manual=!!widget.entity || Array.isArray(widget.entities);
  const candidates=statesForWidget(sources,widget,manual || widget.scope === 'room' ? room : null).filter(s=>s.entity_id.startsWith('media_player.'));
  if (manual) return candidates.slice(0,1);
  const spotifyIds=new Set((sources.registries?.entities || []).filter(e=>e.platform === 'spotify').map(e=>e.entity_id));
  return candidates.filter(s=>spotifyIds.has(s.entity_id) || /spotify/i.test(s.entity_id) || /spotify/i.test(s.attributes.app_name || '') || /^spotify:/.test(s.attributes.media_content_id || '')).slice(0,1);
}
export function statesForWidget(sources,widget,room) {
  const model=roomModel(sources), all=sources.data.states || [];
  if (Array.isArray(widget.entities)) { const ids=new Set(widget.entities); return all.filter(s=>ids.has(s.entity_id)); }
  if (widget.entity) return all.filter(s=>s.entity_id===widget.entity);
  if (['server','guests','updates'].includes(widget.type)) return all;
  const ids=new Set(room && widget.scope !== 'all' ? room.ids : model.index.visible);
  let list=all.filter(s=>ids.has(s.entity_id));
  if (room && widget.scope !== 'all' && widget.type === 'scenes' && !list.some(HD.Modules.types.scenes.pick)) list=all.filter(s=>model.index.visible.has(s.entity_id) && !model.index.areaOf.get(s.entity_id));
  return list;
}
