const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const pub = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(pub, file), 'utf8');
const rules = css => css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean);

test('the settings offer a Téléphone layout next to Bureau, Tablette and Compact', () => {
  const app = read('app.js');
  assert.match(app, /const profiles = \{ desktop: \['Bureau', 'monitor'\], tablet: \['Tablette', 'tablet'\], phone: \['Téléphone', 'phone'\], compact: \['Compact', 'panel'\] \};/);
  assert.match(app, /<select data-layout-profile[^`]*Object\.entries\(profiles\)/, 'le menu Disposition liste tous les profils');
  assert.match(app, /defaultProfile\(\{ phone: isPhoneScreen\(\)/, 'un téléphone ouvre la disposition Téléphone par défaut');
  assert.ok(app.indexOf('<h3>Affichage sur cet appareil</h3>') > app.indexOf('<h3>Onglets visibles par écran</h3>'), 'la Disposition est insérée en dernier, donc affichée en tête des réglages');
  assert.match(read('core.js'), /\n  phone: '<rect/);
});

test('on the phone every module is one column wide and only its height can be stretched', () => {
  const app = read('app.js');
  assert.match(app, /widget: profile === 'phone' \? \{ \.\.\.widget, width: 1, size: 'normal' \} : widget/);
  assert.match(app, /const width = profile === 'phone' \? 1 : spanWidth\(widget\);/);
  assert.match(app, /profile === 'phone' \? \[\['s','Hauteur'\]\]/);
  assert.match(app, /profile === 'phone' && layouts\.tablet\?\.\[page\]\) layouts\[profile\]\[page\] = phoneWidgets\(layouts\.tablet\[page\]\)/);
  assert.match(read('shell.js'), /profile === 'phone' \? 'étirez son bord bas pour changer sa hauteur'/);
});

test('phone.css only styles the phone layout, after the safe-area sheet, with a full-width bottom tab bar', () => {
  const html = read('index.html'), css = read('phone.css');
  assert.ok(html.indexOf('href="phone.css"') > html.indexOf('href="pwa.css"'), 'les règles du téléphone passent après pwa.css');
  for (const rule of rules(css)) for (const selector of rule.slice(0, rule.indexOf('{')).split(',')) assert.match(selector.trim(), /^body\[data-profile="phone"\]/, selector);
  const rail = rules(css).find(r => /^body\[data-profile="phone"\] \.rail\{/.test(r));
  assert.match(rail, /position:fixed/); assert.match(rail, /left:0;right:0;bottom:0/); assert.match(rail, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.rail>\.cockpit-rail-brand,[^{]*\.rail>\.native-rail-mode[^{]*\{display:none\}/, 'logo et libellé de connexion masqués : la barre tient en largeur');
  assert.match(css, /body\[data-profile="phone"\]::before\{[^}]*position:fixed[^}]*height:env\(safe-area-inset-top\)/, 'bandeau sous la barre d’état');
  assert.match(css, /body\[data-profile="phone"\] #app\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.mods>\.mod\.type-rooms\{height:auto\}/, 'toutes les pièces restent visibles');
});

test('the weather card no longer clips its title with its rounded corner', () => {
  assert.match(read('styles.css'), /\.native-home-panel \.hero-weather-content\{border-radius:0\}/);
});
