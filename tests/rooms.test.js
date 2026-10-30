const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

function setup() {
  const HD={}, c={feedmeComponent:()=>'',HD,window:{HD},read:()=>null,esc:s=>String(s ?? '').replace(/</g,'&lt;'),num:(v)=>String(v),icon:()=>'',safeUrl:s=>s,spark:()=>''};
  vm.createContext(c);
  for (const file of ['vendor/home-icons.js','vendor/home-model.js','vendor/home-modules.js','rooms.js','native-renderers.js']) {
    const source=fs.readFileSync('public/'+file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export \{[^\n]+\};?\r?\n/gm,'').replace(/\bexport /g,'');
    vm.runInContext(source,c);
  }
  const entity=(entity_id,state,attributes={})=>({entity_id,state,attributes:{friendly_name:entity_id,...attributes}});
  const sources={demo:false,revision:1,ha:{baseUrl:'http://test.local:8123'},data:{states:[
    entity('light.office','on',{brightness:255,supported_color_modes:['brightness']}),entity('light.bedroom','off',{brightness:0,supported_color_modes:['brightness']}),
    entity('sensor.office_temperature','19',{device_class:'temperature',unit_of_measurement:'°C'}),entity('sensor.office_humidity','61',{device_class:'humidity'}),
    entity('scene.evening','2026-01-01'),entity('light.hidden','on')
  ]},registries:{areas:[{area_id:'office',name:'Bureau'},{area_id:'bedroom',name:'Chambre'}],devices:[{id:'thermometer',area_id:'office'}],entities:[
    {entity_id:'light.office',area_id:'office'},{entity_id:'light.bedroom',area_id:'bedroom'},
    {entity_id:'sensor.office_temperature',device_id:'thermometer'},{entity_id:'sensor.office_humidity',device_id:'thermometer'},
    {entity_id:'light.hidden',area_id:'office',hidden_by:'user'}
  ]}};
  return {c,sources};
}
test('room registries, visibility and ordering match HomeDashboard; grouped actions cannot include another room',()=>{
  const {c,sources}=setup(); sources.originalLayout={rooms:{order:['bedroom','office'],hidden:{}},names:{}};
  const rooms=c.roomModel(sources).rooms;
  assert.equal(rooms[0].name,'Chambre');
  const office=c.activeRoom(sources,'office'); assert.equal(office.temp,19); assert.equal(office.active,1);
  assert.deepEqual(Array.from(c.statesForWidget(sources,{type:'lights',scope:'room'},office).filter(s=>s.entity_id.startsWith('light.')),s=>s.entity_id),['light.office']);
  assert.deepEqual(Array.from(c.statesForWidget(sources,{type:'lights',scope:'all'},office).filter(s=>s.entity_id.startsWith('light.')),s=>s.entity_id),['light.office','light.bedroom']);
  assert.deepEqual(Array.from(c.statesForWidget(sources,{type:'scenes',scope:'room'},office),s=>s.entity_id),['scene.evening']);
  sources.originalLayout.rooms.hidden.bedroom=true; sources.revision++;
  assert.equal(c.roomModel(sources).rooms.some(r=>r.id==='bedroom'),false);
});
test('custom room pages retain the original order, dimensions, notes, entity selection and temperature options without mutating the original',()=>{
  const {c,sources}=setup(); const original={pages:{'room:office':{modules:[
    {id:'temp',type:'temperature',w:1,h:1,scope:'room',entities:['sensor.office_temperature'],options:{tLo:18,tHi:24}},
    {id:'note',type:'notes',w:2,h:4,scope:'room',options:{text:'Code invités\nRappel'}},
    {id:'tiles',type:'devices',w:1,h:4,scope:'room',entities:['light.office'],options:{accent:'#FFD900'}},
    {id:'music',type:'media',w:1,h:1,scope:'room',entities:[],options:{}}
  ]}}}; sources.originalLayout=original; const before=JSON.stringify(original),room=c.activeRoom(sources,'office');
  const widgets=c.importedRoomWidgets(sources,room,'tablet');
  assert.deepEqual(Array.from(widgets,w=>[w.type,w.width,w.height]),[['temperature',1,1],['notes',2,4],['devices',1,4],['ha-media',1,1]]);
  assert.equal(widgets[1].importedNote,'Code invités\nRappel'); assert.equal(widgets[0].options.tLo,18);
  const html=c.nativeContent({widget:widgets[0],sources,room,home:true},()=>{throw Error('fallback');});
  assert.match(html,/Hum\. 61/); assert.match(html,/19/);
  const note=c.nativeContent({widget:widgets[1],sources,room,home:true,note:widgets[1].importedNote},()=>{throw Error('fallback');});
  assert.match(note,/data-note=/); assert.match(note,/Enregistrement auto/);
  assert.equal(c.statesForWidget(sources,widgets[3],room).length,0);
  assert.equal(JSON.stringify(original),before);
  assert.notEqual(c.roomLayoutKey(sources,room),c.roomLayoutKey({...sources,demo:true},room));
});
test('generated room layout follows HomeDashboard defaults and remains isolated per room and surface',()=>{
  const {c,sources}=setup(), office=c.activeRoom(sources,'office'), bedroom=c.activeRoom(sources,'bedroom');
  const a=c.defaultRoomWidgets(sources,office,'tablet');
  assert.deepEqual(Array.from(a,w=>[w.type,w.width,w.height]),[['temperature',1,4],['lights',2,2],['devices',2,2],['scenes',1,4]]);
  assert.equal(new Set([...a,...c.defaultRoomWidgets(sources,bedroom,'tablet'),...c.defaultRoomWidgets(sources,office,'compact')].map(w=>w.id)).size,a.length+c.defaultRoomWidgets(sources,bedroom,'tablet').length+c.defaultRoomWidgets(sources,office,'compact').length);
});
test('manual device choices survive save and reload and replace the previous automatic or single selection',()=>{
  const {c,sources}=setup();
  vm.runInContext(fs.readFileSync('public/module-settings.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,''),c);
  const widget={id:'configured',type:'lights',scope:'room',entity:'light.office',height:2,width:1};
  const form=new FormData();form.set('entityPicker','1');form.append('entities','light.bedroom');
  c.commitEntityChoice(widget,form);
  const saved=JSON.parse(JSON.stringify(widget));assert.equal(saved.entity,undefined);assert.deepEqual(saved.entities,['light.bedroom']);
  const room=c.activeRoom(sources,'office');
  const html=c.nativeContent({widget:saved,sources,room,home:true},()=>{throw Error('fallback');});
  assert.match(html,/light.bedroom/);assert.doesNotMatch(html,/light.office/);
  const automatic=new FormData();automatic.set('entityPicker','1');automatic.set('automatic','on');automatic.append('entities','light.bedroom');
  c.commitEntityChoice(saved,automatic);assert.equal(saved.entities,null);
  assert.deepEqual(Array.from(c.statesForWidget(sources,saved,room).filter(s=>s.entity_id.startsWith('light.')),s=>s.entity_id),['light.office']);
  const empty=new FormData();empty.set('entityPicker','1');c.commitEntityChoice(saved,empty);
  assert.equal(c.statesForWidget(sources,saved,room).length,0);
});
test('wide room overview uses the original two-column cards, counters and all-off action instead of a narrow list',()=>{
  const {c,sources}=setup(),html=c.nativeContent({widget:{id:'rooms',type:'rooms',width:2,height:3},sources,home:true},()=>{throw Error('fallback');});
  assert.match(html,/rooms-grid is-rows/);assert.match(html,/repeat\(2,minmax\(0,1fr\)\)/);assert.match(html,/1\/1 allumée/);assert.match(html,/Moy\./);assert.match(html,/data-action="all-off"/);
  assert.doesNotMatch(html,/data-action="room" data-id="__autres"/);
});
test('moving a configured module through the header preserves its native room and display settings',()=>{
  const {c}=setup();c.modules={rooms:{}};c.write=()=>true;c.Event=Event;c.window.dispatchEvent=()=>{};
  vm.runInContext(fs.readFileSync('public/home-display.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,''),c);
  const result=c.sanitizeDisplay({header:[{id:'room-header',type:'rooms',zone:'right',entities:['light.office'],options:{rooms:['office'],tempColors:false,fmt:'short',hFont:'outfit'}}]});
  assert.deepEqual(Array.from(result.header[0].options.rooms),['office']);assert.equal(result.header[0].options.tempColors,false);assert.equal(result.header[0].options.hFont,'outfit');
  assert.deepEqual(Array.from(result.header[0].entities),['light.office']);
});
