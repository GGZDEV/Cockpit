import { read, write, timeoutSignal } from './core.js';
export class Sources extends EventTarget {
  constructor() {
    super(); this.demo = false; this.data = { states: [] }; write('mb.demo',false);
    this.status = { agents: 'offline', feedme: 'offline', ha: 'offline' }; this.errors = {}; this.history = []; this.metricHistory = {}; this.loading = false; this.generation = 0;
  }
  emit() { this.revision = (this.revision || 0) + 1; this.dispatchEvent(new Event('change')); }
  async feedmeFetch(route,options={}) {
    let base='',headers={...options.headers};
    if (!this.runtime) { const response=await fetch(new URL('runtime.json?v='+(window.MB_ASSET_VERSION || Date.now()),location.href),{cache:'no-store'});if (!response.ok) throw Error('Configuration des services indisponible.');this.runtime=await response.json(); }
    const agentRoute=/^(agents(?:\/|$)|ai-usage(?:[/?]|$)|__agents_status$)/.test(route);
    const remote=agentRoute && this.runtime.agentsOrigin || (HD.Auth?.servedByHA() ? this.runtime.pcOrigin : null);
    if (remote) {
      if (!this.ha || this.status.ha !== 'connected') throw Error('Connectez votre session Home Assistant.');
      const endpoint=new URL(remote); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw Error('Adresse du service invalide.');
      base=endpoint.origin;headers.Authorization='Bearer '+await this.ha.getToken();
    } else if (HD.Auth?.servedByHA()) throw Error('Le service demandé n’est pas configuré.');
    return fetch(base+(['__status','__agents_status'].includes(route) ? '/api/status' : route.startsWith('/api/projects/') ? route : '/api/feedme/'+route),{...options,headers,signal:options.signal || timeoutSignal(22000)});
  }
  async api(route, options = {}) {
    const r = await this.feedmeFetch(route,{...options,headers:{'Content-Type':'application/json',...options.headers}});
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Service indisponible'); return j;
  }
  async refresh() {
    if (this.loading) return;
    if (HD.Auth?.servedByHA() && (!this.ha || this.status.ha !== 'connected')) { this.status.feedme='offline';this.errors.feedme='Connectez votre session Home Assistant pour joindre les services.';this.emit();return; }
    const generation = this.generation; this.loading = true; this.emit();
    const agentRefresh=Promise.all([['agents','agents/'],['quotas','ai-usage']].map(async ([key,route])=>{
          try { const value=await this.api(route);if(generation!==this.generation)return;this.data[key]=value;delete this.errors[key];if(key==='agents')this.status.agents='connected';this.emit(); }
          catch(e) { if(generation===this.generation){this.errors[key]=e.message;if(key==='agents')this.status.agents='offline';this.emit();} }
        }));
    try {
      const statusResponse=await this.feedmeFetch('__status');const status=await statusResponse.json();if (!statusResponse.ok) throw Error(status.error || 'Service PC indisponible.');
      if (generation !== this.generation) return;
      this.suggestedHA = status.haSuggestedUrl; this.status.feedme = status.feedme ? 'connected' : 'offline';
      if (!status.feedme) this.errors.feedme = 'Le service PC est indisponible.';
      if (status.feedme) delete this.errors.feedme; this.emit();
      const endpoints = { articles: 'articles', metrics: 'system/metrics', spotify: 'spotify/now-playing', spotifyStatus: 'spotify/status', calendar: 'calendar', todos: 'todos', boards: 'boards' };
      // La veille est servie par Cockpit lui-même ; le reste dépend encore du service PC.
      const routes = Object.entries(status.feedme ? endpoints : status.rss ? { articles: 'articles', feeds: 'feeds' } : {});
      if (status.feedme && status.rss) routes.push(['feeds', 'feeds']);
      await Promise.all(routes.map(async ([key, route]) => {
        try { const value = await this.api(route); if (generation !== this.generation) return; this.data[key] = value; delete this.errors[key]; }
        catch (e) { if (generation === this.generation) this.errors[key] = e.message; }
      }));
      if (generation !== this.generation) return;
      this.metricHistory ||= {}; const sample = this.data.metrics; for (const [key,value] of Object.entries({ cpu:sample?.cpu?.usagePercent, ram:sample?.memory?.usedPercent, gpu:sample?.gpu?.loadPercent ?? sample?.gpu?.usagePercent, vram:sample?.gpu?.vramPercent })) if (Number.isFinite(value)) this.metricHistory[key]=[...(this.metricHistory[key] || []),value].slice(-60);
      const cpu = this.data.metrics?.cpu?.usagePercent;
      if (Number.isFinite(cpu)) this.history = [...this.history, cpu].slice(-30);
      this.updatedAt = Date.now();
    } catch (e) { if (generation === this.generation) {this.status.feedme='offline';this.errors.feedme = e.message || 'Le service local est indisponible.';} }
    finally {
      if (generation === this.generation) {
        await agentRefresh;
        if(generation===this.generation){this.loading=false;this.emit();}
      }
    }
  }
  disconnectHA() { this.generation++;this.loading=false;this.ha?.close(); this.ha = null; this.forecasts = {}; this.calendarCache={}; this.todoCache={}; this.registries = null; this.originalLayout = null; this.status.ha = 'offline'; this.status.agents='offline'; delete this.data.agents; delete this.data.quotas; }
  async connectHA(url, token) {
    if (this.demo) throw new Error('Passez en données réelles avant de connecter Home Assistant.');
    let parsed; try { parsed = new URL(url); } catch { throw new Error('Adresse Home Assistant invalide.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Utilisez une adresse HTTP ou HTTPS.');
    const auth = typeof token === 'string' ? token.trim() : token;
    if (!auth || typeof auth !== 'string' && typeof auth.getToken !== 'function') throw new Error('Renseignez un jeton Home Assistant.');
    this.disconnectHA();
    this.data.states = []; this.data.rooms = []; this.data.haCalendar = [];
    const conn = new HD.HAConnection(parsed.origin, auth); this.ha = conn; this.status.ha = 'connecting'; this.emit();
    conn.on('status', status => { if (this.ha !== conn) return; this.status.ha = status; this.emit(); });
    conn.on('ready', async () => {
      try {
        this.forecasts = {};
        const [result, original, meta] = await Promise.all([conn.fetchAll(), conn.getUserData('maison_dashboard').catch(() => null), conn.getUserData('metaboard_dashboard_v1').catch(() => null)]);
        this.remoteMeta=meta; if (this.ha !== conn) return;
        this.originalLayout = original && typeof original === 'object' ? original : HD.Auth?.servedByHA() ? read('hd.layout', null) : null;
        this.data.states = result.states; this.registries = result;
        const devices = new Map(result.devices.map(d => [d.id, d.area_id]));
        const registry = new Map(result.entities.map(e => [e.entity_id, e]));
        this.data.rooms = result.areas.map(area => {
          const states = result.states.filter(s => { const e = registry.get(s.entity_id); return e && (e.area_id || devices.get(e.device_id)) === area.area_id; });
          const temps = states.filter(s => s.attributes.device_class === 'temperature' && Number.isFinite(Number(s.state)));
          return { name: area.name, ids: states.map(s => s.entity_id), temp: temps.length ? temps.reduce((n, s) => n + Number(s.state), 0) / temps.length : null, lights: states.filter(s => s.entity_id.startsWith('light.') && s.state === 'on').length };
        });
        const calendars = result.states.filter(s => s.entity_id.startsWith('calendar.')).slice(0, 12);
        const end = new Date(Date.now() + 7 * 86400000);
        const events = (await Promise.all(calendars.map(s => conn.fetchCalendarEvents(s.entity_id, new Date(), end).catch(() => [])))).flat();
        if (this.ha !== conn) return;
        this.data.haCalendar = events;
        delete this.errors.ha; this.emit(); if (HD.Auth?.servedByHA()) this.refresh();
      } catch (e) { if (this.ha === conn) { this.errors.ha = e.message; this.emit(); } }
    });
    conn.on('state', event => {
      if (this.ha !== conn) return;
      this.data.states = this.data.states.filter(s => s.entity_id !== event.entity_id);
      if (event.new_state) this.data.states.push(event.new_state);
      for (const room of this.data.rooms || []) {
        if (!room.ids) continue;
        const states = this.data.states.filter(s => room.ids.includes(s.entity_id));
        const temps = states.filter(s => s.attributes.device_class === 'temperature' && Number.isFinite(Number(s.state)));
        room.temp = temps.length ? temps.reduce((v, s) => v + Number(s.state), 0) / temps.length : null;
        room.lights = states.filter(s => s.entity_id.startsWith('light.') && s.state === 'on').length;
      }
      this.emit();
    });
    try { await conn.connect(); write('mb.ha.url', parsed.origin); }
    catch (e) { if (this.ha === conn) { conn.close(); this.ha = null; this.status.ha = 'offline'; this.errors.ha = e.message; this.emit(); } throw e; }
  }
  states(domain) { return (this.data.states || []).filter(s => s.entity_id.startsWith(domain + '.')); }
  forecastFor(st, type) {
    this.forecasts ||= {};
    const key = st.entity_id + ':' + type;
    if (!this.forecasts[key] && this.ha) {
      const slot = this.forecasts[key] = { items: [], type }, conn = this.ha;
      conn.subscribeForecast(st.entity_id, type, ev => { if (this.ha !== conn) return; slot.items = ev.forecast || []; this.emit(); }).catch(() => {});
    }
    return this.forecasts[key] || null;
  }
  todoFor(st) {
    this.todoCache ||= {}; const old=this.todoCache[st.entity_id];
    if (old && (old.subscribed || Date.now()-old.at<30000)) return old;
    const slot=this.todoCache[st.entity_id]={items:old?.items || [],at:Date.now(),loading:true},conn=this.ha;
    if (!conn) return slot;
    const receive=items=>{slot.items=items;slot.loading=false;if (this.ha===conn) this.emit();};
    conn.listTodo(st.entity_id).then(receive).catch(e=>{slot.error=e.message;slot.loading=false;if (this.ha===conn) this.emit();});
    if (!old) conn.subscribeTodo(st.entity_id,receive).then(()=>{slot.subscribed=true;}).catch(()=>{});
    return slot;
  }
  calendarFor(list, days=7) {
    this.calendarCache ||= {}; const key=list.map(s=>s.entity_id).sort().join(',')+':'+days;
    const old=this.calendarCache[key]; if (old && Date.now()-old.at<60000) return old;
    const slot=this.calendarCache[key]={raw:old?.raw || {},at:Date.now(),loading:true,error:null}, conn=this.ha;
    if (!conn) { slot.loading=false; return slot; }
    const end=new Date(Date.now()+Math.max(1,Math.min(365,days))*86400000);
    Promise.all(list.map(async st=>{ slot.raw[st.entity_id]=await conn.fetchCalendarEvents(st.entity_id,new Date(new Date().setHours(0,0,0,0)),end); })).then(()=>{slot.loading=false;if (this.ha===conn) this.emit();}).catch(e=>{slot.loading=false;slot.error=e.message;if (this.ha===conn) this.emit();});
    return slot;
  }
  cameraUrl(st,live=true) {
    if (!this.ha || !st?.attributes.access_token) return '';
    return this.ha.baseUrl.replace(/\/$/,'')+'/api/camera_proxy'+(live ? '_stream/' : '/')+encodeURIComponent(st.entity_id)+'?token='+encodeURIComponent(st.attributes.access_token)+(live ? '' : '&t='+Math.floor(Date.now()/10000));
  }
  async action(domain, service, id, data = {}) {
    if (!this.ha || this.status.ha !== 'connected') throw new Error('Connectez Home Assistant dans les réglages.');
    await this.ha.callService(domain, service, id, data);
  }
}
