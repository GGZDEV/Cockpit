'use strict';
// Native model picker metadata, without a model request or API credential.
const {spawn}=require('node:child_process'), os=require('node:os');
const h=require('./direct-harness.cjs');
const FALLBACK=[['claude-sonnet-5-5','Sonnet 5.5'],['claude-opus-5-5','Opus 5.5'],['claude-haiku-5-5','Haiku 5.5']].map(([id,name])=>({id,name}));
function normalize(models){
 const seen=new Set();return (Array.isArray(models)?models:[]).filter(m=>m.value!=='default').flatMap(m=>{
  const id=m.resolvedModel||m.value;if(!/^claude-[\w.-]+$/.test(id||'')||seen.has(id))return [];
  seen.add(id);return [{id,name:String(m.value==='default'?id.replace(/^claude-/,''):m.displayName||id).slice(0,100),description:String(m.description||'').slice(0,300)}];
 }).slice(0,40);
}
function createCatalog({command='claude',prefixArgs=[],env=process.env,spawnImpl=spawn,ttlMs=3600000,timeoutMs=15000}={}){
 let cached={models:FALLBACK,source:'fallback',at:''},expires=0,pending,child,closed=false;
 function refresh(){
  if(closed)return Promise.resolve(cached);if(pending)return pending;if(Date.now()<expires)return Promise.resolve(cached);
  pending=new Promise(resolve=>{
   let timer,buffer='',done=false;
   const finish=models=>{if(done)return;done=true;clearTimeout(timer);if(models?.length)cached={models,source:'claude-code',at:new Date().toISOString()};expires=Date.now()+(models?.length?ttlMs:60000);child?.stdin.end();if(child)h.killTree(child);child=null;resolve(cached);};
   try{const program=h.resolveProgram(command,prefixArgs,{});if(program.refused)return finish();child=spawnImpl(program.file,[...program.args,'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence'],{env,cwd:os.tmpdir(),stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});}catch{return finish();}
   timer=setTimeout(()=>finish(),timeoutMs);timer.unref?.();child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
   child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>2*1024*1024)return finish();let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const m=JSON.parse(line);if(m.type==='control_response'&&m.response?.request_id==='cockpit-models')finish(normalize(m.response.response?.models));}catch{}}});
   child.on('error',()=>finish());child.on('close',()=>finish());
   child.stdin.write(JSON.stringify({type:'control_request',request_id:'cockpit-models',request:{subtype:'initialize'}})+'\n');
  }).finally(()=>pending=null);return pending;
 }
 return {snapshot:()=>{void refresh();return cached;},refresh,close:()=>{closed=true;if(child)h.killTree(child);}};
}
module.exports={createCatalog,normalize,FALLBACK};
