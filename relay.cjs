'use strict';
const http=require('node:http'),crypto=require('node:crypto'),{Readable}=require('node:stream');
function haAdministrator(haOrigin,WebSocketImpl=WebSocket) {
  const cache=new Map();
  return async token=>{
    if (!token || token.length>8192) return false;
    const key=crypto.createHash('sha256').update(token).digest('hex'),old=cache.get(key);
    if (old && old.expires>Date.now()) return old.result;
    const result=new Promise(resolve=>{
      const socket=new WebSocketImpl(haOrigin.replace(/^http/,'ws')+'/api/websocket');
      let settled=false;
      const finish=ok=>{if (settled) return;settled=true;clearTimeout(timer);socket.close();resolve(ok);};
      const timer=setTimeout(()=>finish(false),7000);
      socket.addEventListener('message',event=>{
        try {
          const message=JSON.parse(event.data);
          if (message.type==='auth_required') socket.send(JSON.stringify({type:'auth',access_token:token}));
          else if (message.type==='auth_ok') socket.send(JSON.stringify({id:1,type:'auth/current_user'}));
          else if (message.type==='auth_invalid') finish(false);
          else if (message.type==='result' && message.id===1) finish(!!message.success && message.result?.is_admin===true);
        } catch {finish(false);}
      });
      socket.addEventListener('error',()=>finish(false));socket.addEventListener('close',()=>finish(false));
    });
    if (cache.size>=256) cache.delete(cache.keys().next().value);
    cache.set(key,{expires:Date.now()+15000,result});return result;
  };
}
function createRelay({haOrigin,localOrigin,allowed,projectsAllowed=()=>false,authorize=haAdministrator(haOrigin)}) {
  return http.createServer(async(req,res)=>{
    const cors={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if (req.headers.origin===haOrigin) Object.assign(cors,{'Access-Control-Allow-Origin':haOrigin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS','Access-Control-Allow-Private-Network':'true'});
    const reply=(status,message)=>{res.writeHead(status,{...cors,'Content-Type':'application/json'});res.end(JSON.stringify({error:message}));};
    if (req.headers.origin && req.headers.origin!==haOrigin) return reply(403,'Origine non autorisée.');
    if (req.method==='OPTIONS') {res.writeHead(204,cors);return res.end();}
    const token=/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!await Promise.resolve().then(()=>authorize(token)).catch(()=>false)) return reply(401,'Connectez votre compte administrateur Home Assistant pour accéder aux services du PC.');
    const url=new URL(req.url,'http://localhost'),route='/api/'+url.pathname.slice('/api/feedme/'.length);
    const projectRoute=url.pathname.startsWith('/api/projects/');
    if (url.pathname!=='/api/status' && (projectRoute ? !projectsAllowed(req.method,url.pathname) : !url.pathname.startsWith('/api/feedme/') || !allowed(req.method,route))) return reply(405,'Opération indisponible.');
    if (url.pathname==='/api/status' && req.method!=='GET') return reply(405,'Opération indisponible.');
    const abort=new AbortController();res.on('close',()=>abort.abort());
    try {
      const response=await fetch(localOrigin+url.pathname+url.search,{method:req.method,headers:req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{},...(['POST','PATCH','DELETE'].includes(req.method)?{body:req,duplex:'half'}:{}),signal:abort.signal,redirect:'error'});
      res.writeHead(response.status,{...cors,'Content-Type':response.headers.get('content-type') || 'application/json'});res.flushHeaders();
      if (!response.body) return res.end();const stream=Readable.fromWeb(response.body);stream.on('error',()=>res.destroy());stream.pipe(res);
    } catch {if (!res.headersSent) reply(502,'Service du PC indisponible.');else res.end();}
  });
}
module.exports={createRelay,haAdministrator};
