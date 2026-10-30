const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { allowed } = require('../server');
function preferences() {
  const store = new Map();
  const context = { read:(key,otherwise)=>store.has(key) ? store.get(key) : otherwise, write:(key,value)=>{store.set(key,JSON.parse(JSON.stringify(value)));return true;}, location:{pathname:'/local/maison/metaboard/index.html'} };
  const source=fs.readFileSync(require.resolve('../public/preferences.js'),'utf8').replace(/^import .*;\r?\n/,'').replace(/export /g,'');
  vm.runInNewContext(source+'\nthis.api={usesGrid,selectedTheme,visibleTabs,setTabs,importTabs,sanitizeTabs};',context);
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
test('complete FeedMe components allow their known routes while rejecting unknown operations',()=>{
  for(const path of ['command/play','command/pause','command/next','command/previous','volume','authorize','transfer','saved','seek']) assert.equal(allowed('POST','/api/spotify/'+path),true,path);
  for(const path of ['command/delete','command/reboot','upload-secrets','callbacks']) assert.equal(allowed('POST','/api/spotify/'+path),false,path);
  assert.equal(allowed('GET','/api/agents/conversations/example/models'),true);
  assert.equal(allowed('POST','/api/agents/threads/open'),true);
  assert.equal(allowed('GET','/api/agents/events'),true);
  assert.equal(allowed('POST','/api/agents/exec'),false);
});
