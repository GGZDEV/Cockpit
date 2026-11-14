const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalize,createCatalog}=require('../claude-models.cjs');
const {setup}=require('./helpers/direct-setup.js');
test('model metadata uses canonical IDs, deduplicates aliases and rejects invalid values',()=>{
 assert.deepEqual(normalize([{value:'default',resolvedModel:'claude-opus-5-5'},{value:'fable',resolvedModel:'claude-fable-5-2',displayName:'Fable 5.2'},{value:'claude-fable-5-2'},{value:'--bad'}]),[{id:'claude-fable-5-2',name:'Fable 5.2',description:''}]);
});
test('native catalogue discovery costs no model turn and leaves the selected model intact',async t=>{
 const s=await setup(t),p=await s.project('alpha',{direct:{model:'claude-opus-5-5'}});
 const results=await Promise.all([s.engine.refreshModels(),s.engine.refreshModels()]);
 assert.equal(results[0].source,'claude-code');assert.ok(results[0].models.some(m=>m.id==='claude-fable-5-2'));
 assert.equal(s.calls().length,0);
 const state=(await s.ui('state')).body;
 assert.equal(state.projects.find(x=>x.id===p.id).direct.model,'claude-opus-5-5');
 assert.ok(state.capabilities.claudeModels.models.some(m=>m.id==='claude-fable-5-2'));
});
test('unavailable CLI keeps safe cached choices without unhandled rejection',async()=>{
 const c=createCatalog({command:'/does-not-exist'});assert.equal((await c.refresh()).source,'fallback');c.close();
});
