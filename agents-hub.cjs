'use strict';
// Standalone agent service. No Electron, Windows session or desktop daemon.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRelay}=require('./relay.cjs');
const {allowed}=require('./server.js');
function secretStorage(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'storage.key');
  try { fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600}); } catch(e) { if(e.code!=='EEXIST')throw e; }
  const key=fs.readFileSync(file);if(key.length!==32)throw Error('Clé de stockage invalide.');
  return {
    encrypt(value) { const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(String(value),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64'); },
    decrypt(value) { const data=Buffer.from(value,'base64');if(data.length<28)throw Error('Secret invalide.');const decipher=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAuthTag(data.subarray(-16));return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]).toString('utf8'); }
  };
}
function agentAllowed(method,route) { return /^\/api\/(agents(?:\/|$)|ai-usage(?:\/|$))/.test(route) && allowed(method,route); }
async function start({backendDir,dataDir,haOrigin,host='127.0.0.1',port=3889,authorize}={}) {
  if(!backendDir || !dataDir || !haOrigin)throw Error('BACKEND_DIR, AGENTS_DATA_DIR et HA_ORIGIN sont requis.');
  const origin=new URL(haOrigin);if(!['http:','https:'].includes(origin.protocol) || origin.origin!==haOrigin)throw Error('HA_ORIGIN doit être une origine HTTP(S).');
  const backend=path.resolve(backendDir),express=require(require.resolve('express',{paths:[backend]}));
  const codec=secretStorage(path.resolve(dataDir));
  const agents=require(path.join(backend,'agents.js')).createAgentRouter({dataDir:path.resolve(dataDir),secretStorage:codec});
  const usage=require(path.join(backend,'ai-usage.js')).createUsageRouter({dataDir:path.resolve(dataDir),readUsage:id=>agents.readUsage(id),connections:()=>agents.usageConnections()});
  const app=express();app.disable('x-powered-by');
  app.get('/api/status',(_req,res)=>res.json({app:'cockpit-agents',agents:true,feedme:false}));
  app.use('/api/feedme/agents',express.json({limit:'40mb'}),agents);
  app.use('/api/feedme/ai-usage',express.json({limit:'64kb'}),usage);
  const local=await new Promise((resolve,reject)=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));server.once('error',reject);});
  const relay=createRelay({haOrigin,localOrigin:'http://127.0.0.1:'+local.address().port,allowed:agentAllowed,authorize});
  try {await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(port,host,resolve);});}
  catch(e){agents.close();local.close();throw e;}
  return {relay,async close(){agents.close();await Promise.all([relay,local].map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));}};
}
if(require.main===module)start({backendDir:process.env.BACKEND_DIR,dataDir:process.env.AGENTS_DATA_DIR,haOrigin:process.env.HA_ORIGIN,host:process.env.AGENTS_HOST || '127.0.0.1',port:Number(process.env.AGENTS_PORT || 3889)}).then(service=>{
  console.log('Service agents autonome actif.');for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>service.close().then(()=>process.exit(0)));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={start,secretStorage,agentAllowed};
