'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
async function feedmeRunning() {
  const results=await Promise.all(Array.from({length:6},(_,i)=>3777+i).map(async port=>{try {const r=await fetch('http://127.0.0.1:'+port+'/api/browser/status',{signal:AbortSignal.timeout(1000),redirect:'error'});return r.ok && (await r.json()).app==='feedme';}catch{return false;}}));
  return results.some(Boolean);
}
async function ensureFeedMe() {
  if (await feedmeRunning()) return;
  const root=path.resolve(project,'..','FeedMe');
  let executable;try {executable=require(require.resolve('electron',{paths:[root]}));}catch {throw Error('Le service Cockpit nécessite son installation locale existante.');}
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,[root,'--browser'],{cwd:root,detached:true,stdio:'ignore',windowsHide:true,env});
  const failed=new Promise((_,reject)=>child.once('error',reject));child.unref();
  await Promise.race([failed,(async()=>{for(let i=0;i<40;i++){if(await feedmeRunning())return;await new Promise(resolve=>setTimeout(resolve,300));}throw Error('Le service Cockpit ne démarre pas.');})()]);
}
async function running() {
  try { const r = await fetch('http://127.0.0.1:' + Number(process.env.PORT || 3888) + '/browser-status.json', { signal: AbortSignal.timeout(1200), redirect: 'error' }); return r.ok && (await r.json()).app === 'metaboard'; } catch { return false; }
}
async function ensureService() {
  try {await ensureFeedMe();} catch(e) {console.warn(e.message);}
  if (await running()) return;
  const child = spawn(process.execPath, [path.join(project, 'server.js')], { cwd: project, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env } });
  const failed = new Promise((_, reject) => child.once('error', reject));
  child.unref();
  await Promise.race([failed, (async () => {
    for (let i = 0; i < 30; i++) { if (await running()) return; await new Promise(resolve => setTimeout(resolve, 300)); }
    throw new Error('Cockpit ne démarre pas. Le port local est peut-être occupé.');
  })()]);
}
if (require.main === module) ensureService().then(() => console.log('Cockpit reste actif en arrière-plan : http://127.0.0.1:' + Number(process.env.PORT || 3888))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { ensureService, ensureFeedMe };
