const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=file=>fs.readFileSync('public/'+file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');

test('embedded dialogs survive a host redraw without replacing the normal module height, and reject unrelated senders',()=>{
  let receive;
  const classes=new Set(),parentClasses=new Set(),sender={};
  const toggle=set=>({toggle:(key,on)=>on?set.add(key):set.delete(key)});
  const frame={contentWindow:sender,classList:toggle(classes),style:{},closest:selector=>selector==='dialog'?null:{classList:toggle(parentClasses)}};
  const c={window:{addEventListener:(_type,fn)=>receive=fn},location:{origin:'http://host'},document:{getElementById:()=>frame},URLSearchParams,selectedTheme:()=> 'feedme',read:(_k,f)=>f,esc:String};
  vm.createContext(c);vm.runInContext(source('feedme-components.js'),c);
  const send=(data,origin=c.location.origin,from=sender)=>receive({data:{type:'metaboard:widget-size',id:'music',...data},origin,source:from});
  const render=()=>c.feedmeComponent({widget:{type:'spotify',id:'music'},sources:{status:{feedme:'connected'}}});
  send({height:310});send({height:720,overlay:true});
  assert.match(render(),/is-overlay-open/);assert.match(render(),/height:310px/);assert.ok(parentClasses.has('frame-overlay'));
  send({overlay:false,height:70},'http://untrusted');send({overlay:false,height:70},c.location.origin,{});
  assert.match(render(),/is-overlay-open/);
  send({overlay:false,height:310});assert.doesNotMatch(render(),/is-overlay-open/);assert.equal(parentClasses.has('frame-overlay'),false);
});

test('fullscreen remains available and removable in edit mode without a cosmetic settings form',()=>{
  const c={read:()=>null,write:()=>true,esc:String,icon:()=>'',num:String,uid:()=>'',modules:{},document:{documentElement:{requestFullscreen(){}},fullscreenEnabled:true},window:{},sources:{states:()=>[]}};
  vm.createContext(c);vm.runInContext(source('home-display.js'),c);vm.runInContext(source('module-settings.js'),c);
  const html=c.homeHeader({editing:true,sources:c.sources,nativeTitle:()=>''});
  assert.match(html,/data-action="fullscreen"/);
  assert.match(html,/data-action="header-remove" data-id="header-h-fullscreen"/);
  assert.doesNotMatch(html,/data-action="header-config" data-id="header-h-fullscreen"/);
  assert.match(html,/data-action="header-config" data-id="header-h-date"/);
  assert.equal(c.headerSettingsHTML({type:'h-fullscreen'}),'');
});

test('indoor temperature averages only the chosen rooms, leaving « Autres » out by default',()=>{
  const sensor=(entity_id,state)=>({entity_id,state,attributes:{device_class:'temperature'}});
  const states=[sensor('sensor.salon','20'),sensor('sensor.chambre','22'),sensor('sensor.frigo','4')];
  const c={read:()=>null,write:()=>true,esc:String,icon:()=>'',num:(v,d)=>String(v),uid:()=>'',modules:{},document:{},window:{},sources:{states:d=>d==='sensor' ? states : []}};
  vm.createContext(c);vm.runInContext(source('home-display.js'),c);vm.runInContext(source('module-settings.js'),c);
  const rooms=[{id:'salon',name:'Salon',ids:['sensor.salon'],temp:20},{id:'chambre',name:'Chambre',ids:['sensor.chambre'],temp:22},{id:'__autres',name:'Autres',ids:['sensor.frigo'],temp:4}];
  const ids=chosen=>c.indoorSensors(c.sources,rooms,chosen).map(s=>s.entity_id).join();
  assert.equal(ids(),'sensor.salon,sensor.chambre');
  assert.equal(ids(['chambre']),'sensor.chambre');
  assert.equal(ids([]),'');
  assert.equal(c.indoorSensors(c.sources,[],undefined).length,3);
  assert.match(c.homeHeader({editing:false,sources:c.sources,nativeTitle:()=>'',rooms}),/Int\.<\/span> 21°/);
  const form=c.headerSettingsHTML({id:'t',type:'h-temps',zone:'right',options:{rooms:['salon']}},new Date(),rooms);
  assert.match(form,/name="roomPicker"/);
  assert.match(form,/value="salon" checked/);
  assert.doesNotMatch(form,/value="chambre" checked/);
  assert.deepEqual([...c.sanitizeDisplay({look:2,header:[{id:'t',type:'h-temps',options:{rooms:['salon',3]}}]}).header[0].options.rooms],['salon','3']);
});
