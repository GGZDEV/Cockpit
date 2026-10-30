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
