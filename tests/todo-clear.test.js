const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const clean=file=>fs.readFileSync('public/'+file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export \{[^\n]+\};?\r?\n/gm,'').replace(/\bexport /g,'');
function setup(items){
 const HD={},c={HD,window:{HD},feedmeComponent:()=>'',read:()=>null,esc:String,num:String,icon:()=>'',safeUrl:s=>s,spark:()=>''};vm.createContext(c);
 for(const file of ['vendor/home-icons.js','vendor/home-model.js','vendor/home-modules.js','rooms.js','native-renderers.js'])vm.runInContext(clean(file),c);
 const list={entity_id:'todo.courses',state:String(items.length),attributes:{friendly_name:'Courses'}};
 const sources={status:{ha:'connected'},ha:{baseUrl:'http://ha'},revision:1,data:{states:[list]},registries:{areas:[],devices:[],entities:[]},states:d=>[list].filter(s=>s.entity_id.startsWith(d+'.')),todoFor:()=>({items})};
 return {c,sources,widget:{id:'courses',type:'ha-todos',entities:['todo.courses'],width:1,height:3}};
}
test('Home Assistant shopping list offers to clear checked items only when some are checked',()=>{
 const {c,sources,widget}=setup([{uid:'1',summary:'Beurre',status:'completed'},{uid:'2',summary:'Chocolat',status:'needs_action'},{uid:'3',summary:'Pâtes',status:'completed'}]);
 const html=c.nativeContent({widget,sources,home:true},()=>'');
 assert.match(html,/data-action="ha-todo-clear" data-id="todo.courses">Vider les articles cochés \(2\)/);
 const none=setup([{uid:'2',summary:'Chocolat',status:'needs_action'}]);
 assert.doesNotMatch(none.c.nativeContent({widget:none.widget,sources:none.sources,home:true},()=>''),/ha-todo-clear/);
});
test('Local shopping list offers to clear checked items',()=>{
 const {c,sources}=setup([]);
 const html=c.nativeContent({widget:{id:'t',type:'todos'},sources,home:true,todos:[{id:'a',title:'Lait',done:true},{id:'b',title:'Pain',done:false}]},()=>'');
 assert.match(html,/data-action="todo-clear">Vider les articles cochés \(1\)/);
});
test('Clear actions call HA remove_completed_items and drop local done items',()=>{
 const app=fs.readFileSync('public/app.js','utf8');
 assert.match(app,/case 'ha-todo-clear':[^\n]*sources\.action\('todo', 'remove_completed_items', id\)/);
 assert.match(app,/case 'todo-clear': todos = todos\.filter\(t => !t\.done\)/);
});
