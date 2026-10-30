const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const app = fs.readFileSync('public/app.js', 'utf8');
const renderSource = app.slice(app.indexOf('function widgetHTML('), app.indexOf('function fitHomeGrid('));
function renderer(embedded, connectedHA = false) {
  const c = {
    usesGrid: () => false, profile: 'compact', nativeTitle: type => type,
    context: widget => ({ widget }),
    nativeContent: () => embedded ? '<iframe data-native-feedme="todo"></iframe>' : '<p>Content</p>',
    spanWidth: () => 1, esc: String, icon: () => '', feedmeOverlayOpen: () => false,
    sources: { data: {}, status: { ha: connectedHA ? 'connected' : 'offline' } }, editing: false,
  };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('public/modules.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '') + '\nthis.modules = modules;', c);
  vm.runInContext(renderSource, c);
  return c;
}

test('every compact module exposes host settings, including embedded and collapsed modules', () => {
  for (const embedded of [false, true]) for (const connectedHA of [false, true]) {
    const c = renderer(embedded, connectedHA);
    for (const type of Object.keys(c.modules)) for (const collapsed of [false, true]) {
      const html = c.widgetHTML({ id: 'module-1', type, collapsed });
      assert.equal((html.match(/data-action="configure" data-id="module-1"/g) || []).length, 1, `${type}, embedded=${embedded}, collapsed=${collapsed}`);
      if (embedded) assert.ok(html.indexOf('data-action="configure"') < html.indexOf('<iframe'), 'Settings must be outside the embedded frame');
    }
  }
});

test('compact settings contain the removal action and detail content has no extra toolbar', () => {
  const c = renderer(true);
  vm.runInContext(fs.readFileSync('public/module-settings.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, ''), c);
  assert.match(c.settingsFooter('module-1', false), /data-action="remove" data-id="module-1"/);
  assert.doesNotMatch(c.widgetHTML({ id: 'module-1', type: 'todos' }, true), /data-action="configure"|embedded-module-tools/);
});
