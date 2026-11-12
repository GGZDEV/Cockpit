const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
// CO-36 : dock éditable — ordre, icônes d’une large bibliothèque, liens et séparateurs.
function dock() {
  const context = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), iconNames: ['home','grid','rss','chat','kanban','server','link','settings'], icon: name => `<svg data-icon="${name}"></svg>`, HD: { IC: { gear: 'M1 1h2' } } };
  context.globalThis = context;
  const source = fs.readFileSync(require.resolve('../public/dock.js'), 'utf8').replace(/^import .*;\r?\n/m, '').replace(/export /g, '');
  vm.runInNewContext(source + '\nthis.api={sanitizeDock,defaultDock,visibleDock,moveDockItem,iconLibrary,dockIcon,validIcon,validHref,builtinLinks};', context);
  return context.api;
}
const pages = ['overview','home','news','agents','projects'];
const plain = value => JSON.parse(JSON.stringify(value));

test('the default dock lists the pages, plus the server links only in server mode', () => {
  const api = dock();
  assert.deepEqual(plain(api.defaultDock(pages)).map(i => i.id), [...pages, 'sep-settings', 'settings']);
  assert.deepEqual(plain(api.defaultDock(pages, true)).map(i => i.id), [...pages, 'godseye', 'worldmonitor', 'radio', 'sep-settings', 'settings']);
  assert.deepEqual(plain(api.sanitizeDock(null, pages, true)), plain(api.defaultDock(pages, true)));
});

// CO-40 : OpenRadio remplace Radio Garden, y compris dans les docks déjà enregistrés.
test('the radio link opens OpenRadio and a saved Radio Garden entry is migrated', () => {
  const api = dock();
  assert.equal(api.builtinLinks.radio.href, '/openradio.html');
  const saved = [{ kind: 'link', id: 'radio', label: 'Radio Garden', href: 'https://radio.garden/', icon: 'e:📻', newTab: true }, { kind: 'link', id: 'mine', label: 'Garden', href: 'https://radio.garden/', newTab: true }];
  const out = plain(api.sanitizeDock(saved, pages, true));
  assert.deepEqual(out.find(i => i.id === 'radio'), { kind: 'link', id: 'radio', label: 'OpenRadio', href: '/openradio.html', icon: 'e:📻', newTab: false });
  assert.equal(out.find(i => i.id === 'mine').href, 'https://radio.garden/');
});

test('a saved dock keeps its order, icons and separators, drops invalid entries and appends new pages', () => {
  const api = dock();
  const saved = [
    { kind: 'page', id: 'news', icon: 'e:🚀', label: ' Actus ' },
    { kind: 'sep', id: 'sep-1' },
    { kind: 'page', id: 'overview', icon: 'not-an-icon' },
    { kind: 'link', id: 'link-1', label: 'Wiki', href: 'https://wiki.example/', icon: 'x:globe', newTab: true },
    { kind: 'link', id: 'link-2', label: 'Piège', href: 'javascript:alert(1)' },
    { kind: 'page', id: 'news' }, { kind: 'page', id: 'ghost' }, { kind: 'sep', id: 'bad id!' },
    { kind: 'link', id: 'godseye', label: 'God', href: '/godseye.html' },
  ];
  const out = plain(api.sanitizeDock(saved, pages, false));
  assert.deepEqual(out.map(i => i.id), ['news', 'sep-1', 'overview', 'link-1', 'home', 'agents', 'projects', 'sep-settings', 'settings']);
  assert.deepEqual(out[0], { kind: 'page', id: 'news', icon: 'e:🚀', label: 'Actus' });
  assert.equal(out[2].icon, undefined);
  assert.deepEqual(out[3], { kind: 'link', id: 'link-1', label: 'Wiki', href: 'https://wiki.example/', icon: 'x:globe', newTab: true });
  assert.ok(plain(api.sanitizeDock(saved, pages, true)).some(i => i.id === 'godseye'));
});

test('the settings entry is part of the dock: it keeps its place and icon, and cannot be lost or impersonated', () => {
  const api = dock();
  const saved = [{ kind: 'link', id: 'settings', label: 'Faux', href: '/x' }, { kind: 'settings', id: 'settings', icon: 'x:wrench' }, { kind: 'page', id: 'news' }];
  const out = plain(api.sanitizeDock(saved, pages, false));
  assert.deepEqual(out[0], { kind: 'settings', id: 'settings', icon: 'x:wrench' });
  assert.equal(out.filter(i => i.id === 'settings').length, 1);
  assert.ok(!out.some(i => i.id === 'sep-settings'), 'pas de séparateur ajouté quand l’entrée est déjà placée');
  assert.deepEqual(plain(api.visibleDock(out, ['news'])).map(i => i.id), ['settings', 'news']);
});

test('hidden pages, empty links and stray separators do not show in the rail', () => {
  const api = dock();
  const items = [{ kind: 'sep', id: 's0' }, { kind: 'page', id: 'overview' }, { kind: 'sep', id: 's1' }, { kind: 'page', id: 'news' }, { kind: 'sep', id: 's2' }, { kind: 'link', id: 'l', href: '' }, { kind: 'page', id: 'agents' }, { kind: 'sep', id: 's3' }];
  assert.deepEqual(plain(api.visibleDock(items, ['overview', 'agents'])).map(i => i.id), ['overview', 's1', 'agents']);
});

test('moving an entry places it at the target position', () => {
  const api = dock(), items = ['a','b','c','d'].map(id => ({ kind: 'sep', id }));
  assert.deepEqual(plain(api.moveDockItem(items, 'a', 2)).map(i => i.id), ['b','c','a','d']);
  assert.deepEqual(plain(api.moveDockItem(items, 'd', 0)).map(i => i.id), ['d','a','b','c']);
  assert.deepEqual(plain(api.moveDockItem(items, 'c', 99)).map(i => i.id), ['a','b','d','c']);
});

test('the icon library is large, every entry renders and unsafe references are refused', () => {
  const api = dock(), library = plain(api.iconLibrary());
  assert.ok(library.length > 300, `${library.length} icônes`);
  assert.equal(new Set(library.map(e => e.ref)).size, library.length);
  for (const e of library) { assert.ok(api.validIcon(e.ref), e.ref); assert.match(api.dockIcon(e.ref), /^<(svg|span)/); }
  assert.ok(library.some(e => e.ref === 'h:gear') && library.find(e => e.ref === 'x:car').search.includes('voiture'));
  assert.match(api.dockIcon('e:📻'), /dock-emoji[^>]*>📻</);
  for (const bad of ['e:<b>', 'e:', 'x:nope', 'nope', 42]) assert.equal(api.validIcon(bad), false, String(bad));
  assert.match(api.dockIcon('nope'), /data-icon="grid"/);
  for (const href of ['https://a.b/', 'http://x', '/godseye.html']) assert.ok(api.validHref(href), href);
  for (const href of ['javascript:alert(1)', '//evil.example', 'https://', 'https://a b', '']) assert.equal(api.validHref(href), false, href);
});
