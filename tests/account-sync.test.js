const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(remote) {
  const stored=new Map(),timers=new Map(),polls=[];let next=0,applied=null,snapshot={notes:{one:'note'}},resolveWrite;
  const sources=new EventTarget();Object.assign(sources,{ha:{baseUrl:'http://ha.test',setUserData:(key,value)=>{sources.sent.push({key,value});return new Promise(resolve=>{resolveWrite=resolve;});},getUserData:async()=>remote},status:{ha:'connected'},registries:{},remoteMeta:remote,sent:[]});sources.emit=()=>sources.dispatchEvent(new Event('change'));
  const c={read:(key,fallback)=>stored.has(key)?stored.get(key):fallback,write:(key,value)=>stored.set(key,value),setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),setInterval:fn=>polls.push(fn),window:{addEventListener(){}},document:{querySelector:()=>null,activeElement:null}};
  vm.createContext(c);vm.runInContext(fs.readFileSync('public/account-sync.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,''),c);
  const save=c.accountSync(sources,()=>snapshot,value=>{applied=value;},message=>{throw Error(message);});
  return {sources,save,stored,timers,polls,applied:()=>applied,setSnapshot:v=>snapshot=v,resolve:()=>resolveWrite(),run:()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);return fn();}};
}
test('account sync reads MetaBoard data without overwriting the original HomeDashboard key',()=>{
  const remote={version:1,updated:123,layouts:{tablet:{}}},x=setup(remote);x.sources.emit();
  assert.equal(x.applied(),remote);assert.equal(x.sources.sent.length,0);assert.equal(x.timers.size,0);
});
test('an edit made during an ongoing account write is queued again and is not lost',async()=>{
  const x=setup(null);x.sources.emit();const first=x.run();assert.equal(x.sources.sent[0].key,'metaboard_dashboard_v1');
  x.setSnapshot({notes:{one:'edited'}});x.save();x.resolve();await first;
  assert.ok(x.timers.size);const second=x.run();assert.equal(x.sources.sent[1].value.notes.one,'edited');x.resolve();await second;
  assert.equal(x.sources.syncStatus,'synced');
});
