const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {proxy}=require('../godseye.cjs');
test('proxy preserves path/host/protocol and strips secrets/cookies',async t=>{
 const upstream=http.createServer((req,res)=>{res.setHeader('Set-Cookie','secret=1');res.end(JSON.stringify({url:req.url,host:req.headers.host,proto:req.headers['x-forwarded-proto'],auth:req.headers.authorization,cookie:req.headers.cookie}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const server=http.createServer((req,res)=>proxy(req,res,new URL(req.url,'http://localhost'),{port:upstream.address().port}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const r=await fetch(origin+'/godseye-app.html?embed=1',{headers:{authorization:'Basic secret',cookie:'session=secret','x-forwarded-proto':'https'}});
 const data=await r.json();assert.equal(data.url,'/?embed=1');assert.equal(data.proto,'https');assert.equal(data.auth,undefined);assert.equal(data.cookie,undefined);assert.equal(r.headers.get('set-cookie'),null);
 assert.equal((await fetch(origin+'/api/setup/keys',{method:'POST'})).status,403);
});
