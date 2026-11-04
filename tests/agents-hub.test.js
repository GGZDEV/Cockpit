const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {secretStorage,start,agentAllowed}=require('../agents-hub.cjs');
test('server secrets survive restart, reject tampering and never store plaintext',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agents-hub-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const codec=secretStorage(dir),encrypted=codec.encrypt('server password');assert.ok(!encrypted.includes('server password'));assert.equal(secretStorage(dir).decrypt(encrypted),'server password');
 const bytes=Buffer.from(encrypted,'base64');bytes[15]^=1;assert.throws(()=>codec.decrypt(bytes.toString('base64')));
});
test('autonomous gateway serves agents and quotas with HA auth, denies PC routes and persists connections',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agents-hub-'));const options={backendDir:process.env.AGENTS_TEST_BACKEND_DIR || path.resolve('../FeedMe'),dataDir:dir,haOrigin:'http://ha.test:8123',port:0,authorize:token=>token==='admin'};
 let service=await start(options);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 let base='http://127.0.0.1:'+service.relay.address().port;const headers={Authorization:'Bearer admin',Origin:options.haOrigin};
 assert.equal((await fetch(base+'/api/feedme/agents/')).status,401);
 assert.equal((await fetch(base+'/api/feedme/agents/',{headers:{...headers,Origin:'https://foreign.test'}})).status,403);
 const status=await (await fetch(base+'/api/status',{headers})).json();assert.equal(status.agents,true);assert.equal(status.feedme,false);
 for(const route of ['agents/','ai-usage'])assert.equal((await fetch(base+'/api/feedme/'+route,{headers})).status,200);
 for(const route of ['todos','system/metrics','spotify/status'])assert.equal((await fetch(base+'/api/feedme/'+route,{headers})).status,405);
 assert.equal(agentAllowed('POST','/api/agents/exec'),false);
 const saved=await fetch(base+'/api/feedme/agents/connections',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({kind:'compatible',name:'Persistent test',model:'default',endpoint:'https://example.test/v1',token:'private-server-token'})});
 assert.equal(saved.status,200);assert.ok(!fs.readFileSync(path.join(dir,'agents-store.json'),'utf8').includes('private-server-token'));
 await service.close();service=await start(options);base='http://127.0.0.1:'+service.relay.address().port;
 const snapshot=await (await fetch(base+'/api/feedme/agents/',{headers})).json();assert.equal(snapshot.connections[0].name,'Persistent test');assert.equal(snapshot.connections[0].hasToken,true);
});
function sources(fetch){const context={EventTarget,Event,URL,HD:{Auth:{servedByHA:()=>true}},window:{},location:{href:'http://ha.test/local/metaboard/'},write:()=>{},read:()=>null,timeoutSignal:()=>undefined,fetch};vm.createContext(context);vm.runInContext(fs.readFileSync('public/data.js','utf8').replace(/^import .*;\r?\n/,'').replace('export class Sources','class Sources')+';globalThis.Sources=Sources;',context);const s=new context.Sources();s.runtime={pcOrigin:'http://pc.test:3889',agentsOrigin:'http://server.test:3889'};s.ha={close:()=>{},getToken:async()=>'admin'};s.status.ha='connected';return s;}
test('agents load and stream independently when the PC is unavailable; disconnect clears remote data',async()=>{
 const calls=[],s=sources(async(url,options)=>{calls.push([url,options]);if(url.startsWith('http://pc.test'))throw Error('PC off');return {ok:true,json:async()=>({connections:[],providers:[]})};});
 await s.refresh();assert.equal(s.status.feedme,'offline');assert.equal(s.status.agents,'connected');assert.ok(s.data.quotas);assert.ok(calls.some(([url])=>url==='http://server.test:3889/api/feedme/agents/'));
 await s.feedmeFetch('agents/conversations/c/messages',{method:'POST',body:'{}'});const [url,options]=calls.at(-1);assert.equal(url,'http://server.test:3889/api/feedme/agents/conversations/c/messages');assert.equal(options.headers.Authorization,'Bearer admin');
 s.disconnectHA();assert.equal(s.status.agents,'offline');assert.equal(s.data.agents,undefined);assert.equal(s.data.quotas,undefined);
});
