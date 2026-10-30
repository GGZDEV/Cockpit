const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createRelay,haAdministrator}=require('../relay.cjs'),{allowed}=require('../server');
test('HA relay checks the actual HA administrator role and shares a bounded authentication probe for parallel requests',async()=>{
  let probes=0;
  class Socket extends EventTarget {
    constructor(){super();probes++;queueMicrotask(()=>this.emit({type:'auth_required'}));}
    emit(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
    send(raw){const message=JSON.parse(raw);if(message.type==='auth'){this.token=message.access_token;queueMicrotask(()=>this.emit({type:this.token==='invalid'?'auth_invalid':'auth_ok'}));}else queueMicrotask(()=>this.emit({type:'result',id:1,success:true,result:{is_admin:this.token==='admin'}}));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  const authorize=haAdministrator('http://ha.test:8123',Socket);
  assert.deepEqual(await Promise.all([authorize('admin'),authorize('admin')]),[true,true]);assert.equal(probes,1);
  assert.equal(await authorize('user'),false);assert.equal(await authorize('invalid'),false);assert.equal(await authorize(undefined),false);
});
test('tablet relay validates HA authorization, isolates its origin and never forwards the HA token to FeedMe',async t=>{
  let called=0;
  const upstream=http.createServer(async(req,res)=>{called++;assert.equal(req.headers.authorization,undefined);const body=[];for await(const chunk of req)body.push(chunk);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({url:req.url,body:Buffer.concat(body).toString()}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const origin='http://home.test:8123',relay=createRelay({haOrigin:origin,localOrigin:'http://127.0.0.1:'+upstream.address().port,allowed,authorize:token=>token==='valid-admin'});
  await new Promise(r=>relay.listen(0,'127.0.0.1',r));
  t.after(()=>{relay.closeAllConnections();relay.close();upstream.closeAllConnections();upstream.close();});
  const base='http://127.0.0.1:'+relay.address().port;
  assert.equal((await fetch(base+'/api/status')).status,401);assert.equal(called,0);
  assert.equal((await fetch(base+'/api/status',{headers:{Authorization:'Bearer valid-admin',Origin:'https://foreign.test'}})).status,403);
  const preflight=await fetch(base+'/api/feedme/todos',{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.equal((await fetch(base+'/server.js',{headers:{Authorization:'Bearer valid-admin'}})).status,405);
  assert.equal((await fetch(base+'/api/feedme/agents/exec',{method:'POST',headers:{Authorization:'Bearer valid-admin'}})).status,405);
  const response=await fetch(base+'/api/feedme/todos',{method:'POST',headers:{Authorization:'Bearer valid-admin',Origin:origin,'Content-Type':'application/json'},body:'{"title":"Task"}'});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),origin);
  assert.deepEqual(await response.json(),{url:'/api/feedme/todos',body:'{"title":"Task"}'});assert.equal(called,1);
});
