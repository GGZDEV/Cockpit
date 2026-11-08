const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { buildTablet } = require('../scripts/export-tablet');

test('module identifiers work on LAN HTTP without crypto.randomUUID', () => {
  const source = fs.readFileSync(require.resolve('../public/core.js'), 'utf8').replace(/export /g, '');
  const context = { crypto: { getRandomValues: values => webcrypto.getRandomValues(values) } };
  vm.runInNewContext(source, context);
  const ids = Array.from({ length: 500 }, () => context.uid());
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/));
});

test('tablet entry point versions the startup loader and all static module imports', () => {
  // keepRuntime : le test ne doit pas réécrire public/runtime.json (fichier suivi, propre à chaque machine).
  const build = buildTablet({ keepRuntime: true }), root = build.target;
  const html = fs.readFileSync(root + '/index.html', 'utf8');
  assert.match(html, new RegExp('startup.js\\?v=' + build.version));
  const app = fs.readFileSync(root + '/app.js', 'utf8');
  for (const match of app.matchAll(/from ['"]([^'"]+)['"]/g)) assert.ok(match[1].endsWith('?v=' + build.version));
  assert.match(fs.readFileSync(root + '/startup.js', 'utf8'), /MB_ASSET_VERSION/);
});

test('startup guard reports a script failure and clears recovery after successful startup', () => {
  const listeners = {}, timers = [], nodes = Object.fromEntries(['boot-recovery','boot-error','boot-browser','boot-reload'].map(id => [id, { hidden: true }]));
  const attributes = {};
  const document = { readyState: 'loading', body: { setAttribute: (key, value) => attributes[key] = value }, getElementById: id => nodes[id], addEventListener: (type, fn) => listeners['document:' + type] = fn };
  const window = { addEventListener: (type, fn) => listeners[type] = fn };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/boot-guard.js'), 'utf8'), { window, document, navigator: { userAgent: 'Tablet browser' }, setTimeout: fn => timers.push(fn) });
  listeners.error({ message: 'structuredClone is not defined' });
  document.readyState = 'interactive'; listeners['document:DOMContentLoaded']();
  assert.equal(nodes['boot-recovery'].hidden, false);
  assert.equal(nodes['boot-error'].textContent, 'structuredClone is not defined');
  assert.equal(attributes['data-design-ready'], 'true');
  window.MB_BOOT.ready(); timers.forEach(fn => fn());
  assert.equal(nodes['boot-recovery'].hidden, true);
});

test('startup guard times out visibly even when no script error was delivered', () => {
  const listeners = {}, timers = [], nodes = Object.fromEntries(['boot-recovery','boot-error','boot-browser','boot-reload'].map(id => [id, { hidden: true }]));
  const document = { readyState: 'interactive', body: { setAttribute() {} }, getElementById: id => nodes[id], addEventListener: (type, fn) => listeners[type] = fn };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/boot-guard.js'), 'utf8'), { window: { addEventListener() {} }, document, navigator: { userAgent: 'Tablet' }, setTimeout: fn => timers.push(fn) });
  listeners.DOMContentLoaded(); timers.forEach(fn => fn());
  assert.equal(nodes['boot-recovery'].hidden, false);
  assert.match(nodes['boot-error'].textContent, /chargement prend trop de temps/);
});

test('application always starts with real empty sources even when a previous browser saved demo mode', () => {
  const source = fs.readFileSync(require.resolve('../public/data.js'), 'utf8').replace(/^import .*;\r?\n/, '').replace(/export /g, '')+'\nthis.makeSources=()=>new Sources();';
  const saved=new Map([['mb.demo',true]]),context={EventTarget,read:(k,f)=>saved.has(k)?saved.get(k):f,write:(k,v)=>saved.set(k,v)};
  vm.runInNewContext(source,context); const first=context.makeSources();
  assert.equal(first.demo,false); assert.equal(first.data.states.length,0); assert.equal(saved.get('mb.demo'),false);
  assert.equal(first.data.articles,undefined); assert.doesNotMatch(source,/export const demoStates|function demoData/);
});
test('embedded FeedMe documents are versioned too so tablet updates cannot reuse an old iframe entry point',()=>{
  const context={window:{MB_ASSET_VERSION:'release-42',addEventListener(){}},URLSearchParams,selectedTheme:()=> 'home',read:(_key,fallback)=>fallback,esc:String};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/feedme-components.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,''),context);
  const html=context.feedmeComponent({widget:{type:'rss',id:'rss-one'},sources:{status:{feedme:'connected'}}});
  assert.match(html,/index\.html\?v=release-42&widget=rss/);
});
test('tablet API timeouts also work on Android without AbortSignal.timeout',()=>{
  let abort,delay;
  const context={globalThis:{},AbortController:class {constructor(){this.signal={aborted:false};}abort(){this.signal.aborted=true;}},setTimeout:(fn,ms)=>{abort=fn;delay=ms;}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/core.js','utf8').replace(/\bexport /g,''),context);
  const signal=context.timeoutSignal(22000);assert.equal(signal.aborted,false);assert.equal(delay,22000);abort();assert.equal(signal.aborted,true);
});
