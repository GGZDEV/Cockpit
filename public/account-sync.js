import { read, write } from './core.js';

// Separate HA user-data key: never writes maison_dashboard or its original notes.
export function accountSync(sources, snapshot, apply, report) {
  const key='metaboard_dashboard_v1';
  let connection, timer, queued=false, pulling=false;
  const stampKey=()=> 'mb.sync.updated:'+encodeURIComponent(sources.ha?.baseUrl || read('mb.ha.url',''));
  async function push() {
    if (pulling || !sources.ha || sources.status.ha !== 'connected') return;
    const conn=sources.ha, updated=read(stampKey(),0) || Date.now();
    try {
      sources.syncStatus='saving';
      await conn.setUserData(key,{version:1,updated,...snapshot()});
      if (sources.ha !== conn) return;
      sources.syncStatus='synced';
      if (read(stampKey(),0) <= updated) { queued=false; write(stampKey(),updated); } else { queued=true; clearTimeout(timer);timer=setTimeout(push,50); }
    } catch(e) { sources.syncStatus='error'; report('La sauvegarde locale est conservée. Synchronisation HA : '+e.message); }
  }
  function save() {
    if (pulling) return;
    queued=true; write(stampKey(),Math.max(Date.now(),read(stampKey(),0)+1)); clearTimeout(timer); timer=setTimeout(push,650);
  }
  sources.addEventListener('change',()=>{
    const conn=sources.ha;
    if (!conn || sources.status.ha !== 'connected' || !sources.registries) return;
    if (connection === conn) return;
    connection=conn; pulling=true;
    const remote=sources.remoteMeta;
    if (remote?.version === 1 && remote.updated > read(stampKey(),0)) {
      apply(remote); write(stampKey(),remote.updated); queued=false;
    }
    pulling=false;
    if (!remote || queued) { clearTimeout(timer); timer=setTimeout(push,50); }
    else sources.syncStatus='synced';
  });
  setInterval(async()=>{
    const conn=sources.ha; if (!conn || sources.status.ha !== 'connected' || queued || pulling || document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    try { const remote=await conn.getUserData(key); if (sources.ha !== conn || queued || remote?.version !== 1 || remote.updated <= read(stampKey(),0)) return; pulling=true; apply(remote); write(stampKey(),remote.updated); pulling=false; sources.emit(); } catch {}
  },20000);
  window.addEventListener('pagehide',()=>{ if (queued) push(); });
  return save;
}
