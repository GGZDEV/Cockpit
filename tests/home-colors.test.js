const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const pub = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(pub, file), 'utf8');
const source = file => read(file).replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');

// CO-6 : refonte « polish Apple » — accent réglable, fond à halos dont la base et les trois halos se règlent chacun.
function display() {
  const props = {}, style = { setProperty: (k, v) => { props[k] = v; }, removeProperty: () => {} };
  const c = { read: () => null, write: () => true, esc: String, icon: String, num: String, uid: () => 'x', modules: {}, window: {}, document: { body: { style } } };
  vm.createContext(c); vm.runInContext(source('home-display.js') + ';this.set = v => { homeDisplay = v; };', c);
  return { c, style, props };
}

test('a fresh display uses the blue accent and the halo background', () => {
  const { c } = display(), d = c.sanitizeDisplay(null);
  assert.equal(d.accent, '#0A84FF');
  assert.equal(d.bg.preset, 'halo');
  assert.equal(d.header.filter(m => m.zone === 'center').map(m => m.type).join(), 'h-clock,h-date', 'heure au centre, date dessous');
});

test('settings saved before the redesign move to the new defaults, real choices are kept', () => {
  const { c } = display();
  const old = c.sanitizeDisplay({ accent: '#F5C542', bg: { preset: 'chaud' } });
  assert.equal(old.accent, '#0A84FF'); assert.equal(old.bg.preset, 'halo');
  const chosen = c.sanitizeDisplay({ accent: '#FF375F', bg: { preset: 'nuit' } });
  assert.equal(chosen.accent, '#FF375F'); assert.equal(chosen.bg.preset, 'nuit');
  const kept = c.sanitizeDisplay({ look: 2, accent: '#F5C542', bg: { preset: 'chaud' } });
  assert.equal(kept.accent, '#F5C542', 'après la refonte, le jaune est un vrai choix'); assert.equal(kept.bg.preset, 'chaud');
});

test('the base color and each of the three halos are applied separately', () => {
  const { c, style, props } = display();
  c.set(c.sanitizeDisplay({ look: 2, accent: '#30D158', bg: { preset: 'halo', halo: { base: '#101020', h1: '#ff0000', h2: '#00ff00', h3: '#0000ff', bad: 'x' } } }));
  c.applyDisplay(true);
  assert.match(style.background, /rgba\(255,0,0,0\.34\).*rgba\(0,255,0,0\.2\).*rgba\(0,0,255,0\.18\).* #101020 fixed$/);
  assert.equal(props['--accent'], '#30D158');
  assert.equal(props['--accent-glow'], 'rgba(48,209,88,0.45)');
  assert.equal(Object.keys(c.sanitizeDisplay({ bg: { halo: { bad: '#000000' } } }).bg.halo).join(), 'base,h1,h2,h3');
});

test('the colors dialog offers the accent plus the base and three halo pickers', () => {
  const app = read('app.js');
  assert.match(app, /pick\('home-accent','Accentuation'/);
  assert.match(app, /haloParts\.map\(\(\[k,label\]\) => pick\('halo-'\+k/);
  assert.match(app, /data-action="background">\$\{icon\('sun'\)\} Couleurs et fond/, 'accessible depuis les Paramètres');
  const html = read('index.html');
  assert.ok(html.indexOf('polish.css') > html.indexOf('themes.css') && html.indexOf('polish.css') < html.indexOf('phone.css'));
});
