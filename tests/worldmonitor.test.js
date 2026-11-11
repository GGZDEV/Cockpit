const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createServer}=require('../server');
test('World Monitor full app uses isolated authenticated origin and strips Cockpit credentials',async t=>{
 const backend=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'self'");res.setHeader('Set-Cookie',['wm_session=abc; Path=/','cockpit_session=bad; Path=/']);res.end(JSON.stringify({url:req.url,auth:req.headers.authorization,cookie:req.headers.cookie}));});
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const original=[process.env.COCKPIT_WORLDMONITOR_HOST,process.env.COCKPIT_WORLDMONITOR_UPSTREAM];
 process.env.COCKPIT_WORLDMONITOR_HOST='worldmonitor.ggz.ovh';process.env.COCKPIT_WORLDMONITOR_UPSTREAM='http://127.0.0.1:'+backend.address().port;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cockpit-wm-'));
 const server=createServer({serverMode:true,allowedHosts:['worldmonitor.ggz.ovh','cockpit.ggz.ovh'],webPassword:'test',stateDir:dir});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();fs.rmSync(dir,{recursive:true,force:true});['COCKPIT_WORLDMONITOR_HOST','COCKPIT_WORLDMONITOR_UPSTREAM'].forEach((k,i)=>{if(original[i]===undefined)delete process.env[k];else process.env[k]=original[i];});});
 const base='http://127.0.0.1:'+server.address().port;
 const send=(url,options={})=>new Promise((resolve,reject)=>{const u=new URL(url);const q=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method:options.method||'GET',headers:options.headers},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,json:async()=>JSON.parse(body),headers:{get:k=>Array.isArray(r.headers[k])?r.headers[k].join(', '):r.headers[k]}}));});q.on('error',reject);q.end(options.body);});

 const headers={host:'worldmonitor.ggz.ovh',authorization:'Basic '+Buffer.from('cockpit:test').toString('base64'),'x-forwarded-proto':'https'};
 assert.equal((await send(base+'/',{headers:{host:headers.host}})).status,401);
 const r=await send(base+'/api/bootstrap?view=full',{headers:{...headers,cookie:'cockpit_session=private; wm_session=ok'}});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.url,'/api/bootstrap?view=full');assert.equal(data.auth,undefined);assert.equal(data.cookie.trim(),'wm_session=ok');
 assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'self' https:\/\/cockpit.ggz.ovh/);
 assert.doesNotMatch(r.headers.get('set-cookie'),/cockpit_session/);
 assert.equal((await send(base+'/api/bootstrap',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'})).status,403);
 const isolated=await send(base+'/api/status',{headers:{...headers,host:'cockpit.ggz.ovh'}});assert.equal((await isolated.json()).app,'metaboard');
});
