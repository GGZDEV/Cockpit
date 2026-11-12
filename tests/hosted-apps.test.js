const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createServer}=require('../server');
test('World Monitor full app uses isolated authenticated origin and strips Cockpit credentials',async t=>{
 const backend=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/'?'text/html':'application/json');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'nonce-test-bootstrap' 'strict-dynamic'; frame-ancestors 'self'");res.setHeader('Set-Cookie',['wm_session=abc; Path=/','cockpit_session=bad; Path=/']);res.end(req.url==='/'?'<html><head></head><body>World Monitor</body></html>':JSON.stringify({url:req.url,auth:req.headers.authorization,cookie:req.headers.cookie}));});
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const original=[process.env.COCKPIT_WORLDMONITOR_HOST,process.env.COCKPIT_WORLDMONITOR_UPSTREAM];
 process.env.COCKPIT_WORLDMONITOR_HOST='worldmonitor.ggz.ovh';process.env.COCKPIT_WORLDMONITOR_UPSTREAM='http://127.0.0.1:'+backend.address().port;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cockpit-wm-'));
 const server=createServer({serverMode:true,allowedHosts:['worldmonitor.ggz.ovh','cockpit.ggz.ovh'],webPassword:'test',stateDir:dir});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();fs.rmSync(dir,{recursive:true,force:true});['COCKPIT_WORLDMONITOR_HOST','COCKPIT_WORLDMONITOR_UPSTREAM'].forEach((k,i)=>{if(original[i]===undefined)delete process.env[k];else process.env[k]=original[i];});});
 const base='http://127.0.0.1:'+server.address().port;
 const send=(url,options={})=>new Promise((resolve,reject)=>{const u=new URL(url);const q=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method:options.method||'GET',headers:options.headers},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,text:async()=>body,json:async()=>JSON.parse(body),headers:{get:k=>Array.isArray(r.headers[k])?r.headers[k].join(', '):r.headers[k]}}));});q.on('error',reject);q.end(options.body);});

 const headers={host:'worldmonitor.ggz.ovh',authorization:'Basic '+Buffer.from('cockpit:test').toString('base64'),'x-forwarded-proto':'https'};
 assert.equal((await send(base+'/',{headers:{host:headers.host}})).status,401);
 const r=await send(base+'/api/bootstrap?view=full',{headers:{...headers,cookie:'cockpit_session=private; wm_session=ok'}});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.url,'/api/bootstrap?view=full');assert.equal(data.auth,undefined);assert.equal(data.cookie.trim(),'wm_session=ok');
 assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'self' https:\/\/cockpit.ggz.ovh/);
 assert.doesNotMatch(r.headers.get('set-cookie'),/cockpit_session/);
 assert.match(await (await send(base+'/',{headers})).text(),/<head><script nonce="test-bootstrap" src="\/hosted-auth.js"><\/script>/);
 const shim=await send(base+'/hosted-auth.js',{headers});assert.equal(shim.status,200);assert.match(await shim.text(),/url.origin === window.location.origin/);
 assert.equal((await send(base+'/api/bootstrap',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'})).status,403);
 const isolated=await send(base+'/api/status',{headers:{...headers,host:'cockpit.ggz.ovh'}});assert.equal((await isolated.json()).app,'metaboard');
});

// CO-40 : OpenRadio auto-hébergé sur son propre hôte, même isolation que World Monitor.
test('OpenRadio is proxied on its own authenticated host and /openradio.html opens it',async t=>{
 const backend=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('X-Frame-Options','DENY');if(req.url!='/')res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'");res.end(JSON.stringify({url:req.url,auth:req.headers.authorization,host:req.headers.host}));});
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const keys=['COCKPIT_OPENRADIO_HOST','COCKPIT_OPENRADIO_UPSTREAM'],original=keys.map(k=>process.env[k]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cockpit-or-'));
 const server=createServer({serverMode:true,allowedHosts:['openradio.ggz.ovh','cockpit.ggz.ovh'],webPassword:'test',stateDir:dir});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();fs.rmSync(dir,{recursive:true,force:true});keys.forEach((k,i)=>{if(original[i]===undefined)delete process.env[k];else process.env[k]=original[i];});});
 const base='http://127.0.0.1:'+server.address().port;
 const send=(p,headers)=>new Promise((resolve,reject)=>{const q=http.request(base+p,{headers},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body}));});q.on('error',reject);q.end();});
 const auth={authorization:'Basic '+Buffer.from('cockpit:test').toString('base64'),'x-forwarded-proto':'https'};
 delete process.env.COCKPIT_OPENRADIO_HOST;
 assert.equal((await send('/openradio.html',{...auth,host:'cockpit.ggz.ovh'})).headers.location,'https://openradio.space/');
 process.env.COCKPIT_OPENRADIO_HOST='openradio.ggz.ovh';process.env.COCKPIT_OPENRADIO_UPSTREAM='http://127.0.0.1:'+backend.address().port;
 const page=await send('/openradio.html',{...auth,host:'cockpit.ggz.ovh'});
 assert.equal(page.status,200);assert.match(page.body,/<iframe[^>]+src="\/openradio-frame"/);
 // Le cadre ouvre la session sur l’hôte OpenRadio par un jeton à usage unique, lié à cet hôte.
 assert.equal((await send('/openradio-frame',{host:'cockpit.ggz.ovh'})).status,401);
 const frame=new URL((await send('/openradio-frame',{...auth,host:'cockpit.ggz.ovh'})).headers.location);
 assert.equal(frame.origin+frame.pathname,'https://openradio.ggz.ovh/__cockpit/handoff');
 assert.equal((await send(frame.pathname+frame.search,{host:'worldmonitor.ggz.ovh'})).status,401);
 const handoff=await send(frame.pathname+frame.search,{host:'openradio.ggz.ovh','x-forwarded-proto':'https'});
 assert.equal(handoff.status,303);assert.equal(handoff.headers.location,'/');
 const cookie=handoff.headers['set-cookie'][0].split(';')[0];assert.match(cookie,/^cockpit_session=/);
 assert.equal((await send('/api/stations',{host:'openradio.ggz.ovh',cookie})).status,200);
 assert.equal((await send(frame.pathname+frame.search,{host:'openradio.ggz.ovh'})).status,403);
 assert.equal((await send('/__cockpit/handoff?t=forged',{host:'openradio.ggz.ovh'})).status,403);
 assert.equal((await send('/',{host:'openradio.ggz.ovh'})).status,401);
 const loginIcon=await send('/brand/icon-192.png',{host:'openradio.ggz.ovh'});
 assert.equal(loginIcon.status,200);assert.match(loginIcon.headers['content-type'],/image\/png/);
 const r=await send('/api/stations?country=FR',{...auth,host:'openradio.ggz.ovh'});
 assert.equal(r.status,200);const data=JSON.parse(r.body);
 assert.equal(data.url,'/api/stations?country=FR');assert.equal(data.auth,undefined);assert.equal(data.host,'openradio.ggz.ovh');
 assert.equal(r.headers['x-frame-options'],undefined);assert.match(r.headers['content-security-policy'],/frame-ancestors 'self' https:\/\/cockpit.ggz.ovh/);
 assert.match((await send('/',{...auth,host:'openradio.ggz.ovh'})).headers['content-security-policy'],/script-src 'self' 'unsafe-inline'/);
 backend.close();backend.closeAllConnections();
 const down=await send('/',{...auth,host:'openradio.ggz.ovh'});
 assert.equal(down.status,502);assert.match(JSON.parse(down.body).error,/OpenRadio/);
});
