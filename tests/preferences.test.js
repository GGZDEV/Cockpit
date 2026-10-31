const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { allowed } = require('../server');
function preferences() {
  const store = new Map();
  const context = { read:(key,otherwise)=>store.has(key) ? store.get(key) : otherwise, write:(key,value)=>{store.set(key,JSON.parse(JSON.stringify(value)));return true;}, location:{pathname:'/local/maison/metaboard/index.html'} };
  const source=fs.readFileSync(require.resolve('../public/preferences.js'),'utf8').replace(/^import .*;\r?\n/,'').replace(/export /g,'');
  vm.runInNewContext(source+'\nthis.api={usesGrid,selectedTheme,visibleTabs,setTabs,importTabs,sanitizeTabs,screenOrder,isPhoneScreen,defaultProfile,phoneWidgets};',context);
  return {api:context.api,store};
}
test('switching skins leaves each screen layout and its visible tabs unchanged',()=>{
  const {api,store}=preferences();
  for(const skin of ['home','feedme','home']) {
    store.set('mb.theme',skin); assert.equal(api.selectedTheme(),skin);
    assert.equal(api.usesGrid('tablet'),true); assert.equal(api.usesGrid('compact'),false); assert.equal(api.usesGrid('desktop'),false);
    assert.deepEqual(Array.from(api.visibleTabs('compact')),['overview','agents']);
  }
});
test('tab visibility is independent per screen, survives reimport and cannot hide every navigation destination',()=>{
  const {api,store}=preferences();
  assert.equal(api.setTabs('compact',['agents','news','invalid']),true);
  assert.deepEqual(Array.from(api.visibleTabs('compact')),['agents','news']);
  assert.ok(api.visibleTabs('tablet').includes('home'));
  assert.equal(api.setTabs('compact',[]),false);
  api.importTabs(store.get('mb.tabs.v1'));
  assert.deepEqual(Array.from(api.visibleTabs('compact')),['agents','news']);
  assert.equal(api.setTabs('unknown',['overview']),false);
});
test('the phone is its own screen: tablet look, separate tabs, chosen by default on a phone',()=>{
  const {api}=preferences();
  assert.deepEqual(Array.from(api.screenOrder),['desktop','tablet','phone','compact']);
  assert.equal(api.usesGrid('phone'),true);
  assert.deepEqual(Array.from(api.visibleTabs('phone')),['overview','agents','projects','home','news','system']);
  assert.equal(api.setTabs('phone',['home','overview']),true);
  assert.deepEqual(Array.from(api.visibleTabs('phone')),['overview','home']);
  assert.ok(api.visibleTabs('tablet').includes('news'),'masquer un onglet sur le téléphone ne touche pas la tablette');
  assert.equal(api.defaultProfile({phone:true,servedByHA:true}),'phone');
  assert.equal(api.defaultProfile({phone:false,servedByHA:true}),'tablet');
  assert.equal(api.defaultProfile({}),'desktop');
  assert.equal(api.isPhoneScreen(null),false);
});
test('a phone layout starts from a copy of the tablet modules, one column wide',()=>{
  const {api}=preferences();
  const tablet=[{id:'n1',type:'notes',width:3,size:'wide',height:2,options:{a:1}},{id:'r1',type:'rooms',size:'full'}];
  const phone=api.phoneWidgets(tablet);
  assert.deepEqual(JSON.parse(JSON.stringify(phone.map(w=>[w.id,w.type,w.width,w.size,w.height ?? null]))),[['n1','notes',1,'normal',2],['r1','rooms',1,'normal',null]]);
  phone[0].options.a=2; phone[0].height=4;
  assert.equal(tablet[0].options.a,1); assert.equal(tablet[0].width,3); assert.equal(tablet[0].height,2);
  assert.deepEqual(Array.from(api.phoneWidgets(undefined)),[]);
});
test('complete FeedMe components allow their known routes while rejecting unknown operations',()=>{
  for(const path of ['command/play','command/pause','command/next','command/previous','volume','authorize','transfer','saved','seek']) assert.equal(allowed('POST','/api/spotify/'+path),true,path);
  for(const path of ['command/delete','command/reboot','upload-secrets','callbacks']) assert.equal(allowed('POST','/api/spotify/'+path),false,path);
  assert.equal(allowed('GET','/api/agents/conversations/example/models'),true);
  assert.equal(allowed('POST','/api/agents/threads/open'),true);
  assert.equal(allowed('GET','/api/agents/events'),true);
  assert.equal(allowed('POST','/api/agents/exec'),false);
});
