const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

function setup() {
  const listeners = {}, classes = () => ({ add() {}, remove() {} });
  const grid = { clientWidth: 1200, clientHeight: 500, scrollTop: 0, scrollHeight: 500, getBoundingClientRect: () => ({top:100,bottom:600}) };
  const widgets = [{ id:'a',type:'weather',size:'normal',height:2 },{id:'b',type:'rooms',size:'normal',height:2}], header = [];
  const cards = widgets.map(m => ({ dataset: { mod:m.id }, isConnected:true, classList:classes(), className:'mod w1 h2', style:{setProperty() {}}, parentElement:grid, getBoundingClientRect: () => ({left:100,top:100,width:284,height:216}), querySelector: () => null, closest: selector => selector === '[data-scroll]' ? grid : null }));
  const zone = { dataset: { hzone:'center' }, classList:classes() };
  let under = cards[1], saved = 0, rendered = 0;
  const document = { body: { classList: classes(), appendChild() {} }, createElement: () => ({ style:{}, remove() {} }), elementFromPoint: () => ({ closest: selector => selector === '.mods [data-mod]' ? under : selector === '[data-hzone]' && under === zone ? zone : null }), addEventListener: (name,fn) => listeners['doc:'+name] = fn };
  const root = { addEventListener: (name,fn) => listeners[name] = fn };
  const context = { document, window:{scrollY:0,innerHeight:800,scrollBy() {}}, navigator:{}, getComputedStyle: () => ({ columnGap:'16',rowGap:'16',gridTemplateColumns:'284px 284px 284px 284px',gridAutoRows:'100px' }), setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/home-editor.js'),'utf8').replace('export function','function'),context);
  context.attachHomeEditor({root,isEditing:()=>true,isHome:()=>true,getWidgets:()=>widgets,getHeaderItems:()=>header,persist:()=>saved++,render:()=>rendered++,toast() {}});
  const pointer = (target, extra={}) => ({ target, pointerType:'touch',pointerId:1,button:0,clientX:100,clientY:100,preventDefault() {},...extra });
  const grip = { closest: selector => selector === '[data-mod]' ? cards[0] : selector === '[data-grip]' ? {} : null };
  const resize = { dataset:{rz:'se'},closest: selector => selector === '[data-rz]' ? resize : selector === '[data-mod]' ? cards[0] : null,setPointerCapture() {} };
  return { listeners, widgets, header, zone, grip, resize, pointer, setUnder: value => under=value, saved:()=>saved, rendered:()=>rendered };
}
test('HomeDashboard pointer editor swaps cards rather than shifting intermediate cards', () => {
  const x=setup(); x.listeners.pointerdown(x.pointer(x.grip));
  x.listeners['doc:pointermove'](x.pointer(x.grip,{clientX:500,clientY:250}));
  x.listeners['doc:pointerup'](x.pointer(x.grip));
  assert.deepEqual(x.widgets.map(m=>m.id),['b','a']); assert.equal(x.saved(),1);
});
test('HomeDashboard corner resize persists a three-column span and height, clamped to the four-row grid', () => {
  const x=setup(); x.listeners.pointerdown(x.pointer(x.resize));
  x.listeners['doc:pointermove'](x.pointer(x.resize,{clientX:700,clientY:216}));
  x.listeners['doc:pointerup'](x.pointer(x.resize));
  assert.equal(x.widgets[0].width,3); assert.equal(x.widgets[0].height,3); assert.equal(x.widgets[0].size,'wide'); assert.equal(x.saved(),1);
});
test('HomeDashboard can move a card to an editable header zone without losing its identity', () => {
  const x=setup(); x.setUnder(x.zone); x.listeners.pointerdown(x.pointer(x.grip));
  x.listeners['doc:pointerup'](x.pointer(x.grip));
  assert.equal(x.widgets.length,1); assert.equal(x.header[0].id,'a'); assert.equal(x.header[0].zone,'center'); assert.equal(x.saved(),1);
});
test('cancelling a touch resize keeps the saved layout intact', () => {
  const x=setup(); x.listeners.pointerdown(x.pointer(x.resize));
  x.listeners['doc:pointermove'](x.pointer(x.resize,{clientX:700,clientY:216}));
  x.listeners['doc:pointercancel'](x.pointer(x.resize));
  assert.equal(x.widgets[0].width,undefined); assert.equal(x.widgets[0].height,2); assert.equal(x.saved(),0);
});
