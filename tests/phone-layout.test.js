const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const pub = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(pub, file), 'utf8');
const source = file => read(file).replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const rules = css => css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean);

test('the settings offer a Téléphone layout next to Bureau, Tablette and Compact', () => {
  const app = read('app.js');
  assert.match(app, /const profiles = \{ desktop: \['Bureau', 'monitor'\], tablet: \['Tablette', 'tablet'\], phone: \['Téléphone', 'phone'\], compact: \['Compact', 'panel'\] \};/);
  assert.match(app, /<select data-layout-profile[^`]*Object\.entries\(profiles\)/, 'le menu Disposition liste tous les profils');
  assert.match(app, /defaultProfile\(\{ phone: isPhoneScreen\(\)/, 'un téléphone ouvre la disposition Téléphone par défaut');
  assert.match(app, /settings-grid"><div class="settings-col">\$\{device\}/, 'la carte « Sur cet appareil » et sa Disposition ouvrent les réglages');
  assert.match(read('core.js'), /\n  phone: '<rect/);
});

test('on the phone every module is one column wide and only its height can be stretched', () => {
  const app = read('app.js');
  assert.match(app, /widget: profile === 'phone' \? \{ \.\.\.widget, width: 1, size: 'normal' \} : widget/);
  assert.match(app, /const width = profile === 'phone' \? 1 : spanWidth\(widget\);/);
  assert.match(app, /profile === 'phone' \? \[\['s','Hauteur'\]\]/);
  assert.match(app, /profile === 'phone' && layouts\.tablet\?\.\[page\]\) layouts\[profile\]\[page\] = phoneWidgets\(layouts\.tablet\[page\]\)/);
  assert.match(read('shell.js'), /profile === 'phone' \? 'Maintenez un module pour le déplacer · étirez son bord bas pour changer sa hauteur\.'/, 'consigne courte sur le téléphone');
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

// CO-5 : retours sur iPhone (chevauchements, modules limités à 1×4, Kanban rogné).
function header({ fullscreen = false, phone = true, editing = false } = {}) {
  const c = { read: () => null, write: () => true, esc: String, icon: name => `<i data-icon="${name}"></i>`, num: String, uid: () => 'x', modules: {}, window: {},
    document: { documentElement: {}, fullscreenEnabled: fullscreen } };
  vm.createContext(c); vm.runInContext(source('home-display.js'), c);
  return c.homeHeader({ editing, phone, sources: { states: () => [] }, nativeTitle: () => '' });
}

test('on the phone the pencil and the edit buttons sit outside the scrolling right zone, and the useless fullscreen chip is hidden', () => {
  const html = header();
  const right = html.slice(html.indexOf('hz-right'), html.lastIndexOf('<span class="head-fixed">'));
  assert.doesNotMatch(right, /head-fixed/, 'les boutons fixes ne défilent plus avec les pastilles');
  assert.match(html, /<\/div><span class="head-fixed"><button[^>]*data-action="edit"[^<]*<i data-icon="edit"><\/i><\/button><\/span><\/header>$/);
  assert.doesNotMatch(html, /Plein écran/, 'iPhone : pas de plein écran possible, pas de pastille');
  assert.match(header({ editing: true }), /Plein écran/, 'en personnalisation, la pastille reste visible pour pouvoir la retirer');
  assert.match(header({ fullscreen: true }), /data-action="fullscreen"/, 'un téléphone qui sait passer en plein écran garde le bouton');
  const tablet = header({ phone: false });
  assert.match(tablet, /<span class="head-fixed">[\s\S]*<\/span><\/div><\/header>$/, 'tablette et bureau inchangés');
  assert.match(tablet, /Plein écran/);
});

test('the phone header is a fixed grid, so an empty centre zone can no longer put the chips on top of the date and clock', () => {
  const css = rules(read('phone.css')), find = re => css.find(r => re.test(r)) || '';
  assert.match(find(/\.page-head\.is-home\{display:grid/), /grid-template-areas:"l c f" "r r r"/);
  assert.match(find(/\.page-head\.is-home>\.hz-right\{/), /grid-area:r/);
  assert.match(find(/\.page-head\.is-home>\.head-fixed\{/), /grid-area:f/);
  assert.match(find(/\.page-head\.is-home\.is-editing\{/), /grid-template-areas:"f" "l" "c" "r"/, 'en personnalisation, une ligne par zone');
  assert.match(find(/\.is-editing \.hitem-tools\{/), /position:static/, 'les boutons d’un élément ne recouvrent plus son texte');
  assert.match(find(/\.native-home-panel\.is-editing \.mods>\.mod:not\(\.add-tile\)\{/), /padding-top:56px/, 'la barre du module ne recouvre plus son titre');
  assert.doesNotMatch(read('phone.css'), /hz-right\{flex:1 0 100%/, 'l’ancienne règle (passage à la ligne annulé par la marge négative) a disparu');
});

test('phone modules go up to eight rows high; the other layouts keep four', () => {
  const c = { read: () => null, write: () => true, location: { pathname: '/' }, globalThis: {} };
  vm.createContext(c); vm.runInContext(source('preferences.js') + '\nthis.maxHeight = maxHeight;', c);
  assert.equal(c.maxHeight('phone'), 8); assert.equal(c.maxHeight('tablet'), 4); assert.equal(c.maxHeight('desktop'), 4);
  const app = read('app.js');
  assert.match(app, /Number\(w\.height\) <= maxHeight\(p\) \? Number\(w\.height\) : 2/, 'une hauteur de 8 enregistrée sur le téléphone survit au rechargement');
  assert.match(app, /maxHeight: \(\) => maxHeight\(profile\)/, 'l’étirement suit la limite de la disposition');
  assert.match(app, /Math\.min\(maxHeight\(profile\),Math\.round\(Number\(fd\.get\('height'\)\)\)/);
  const m = { esc: String, row: (l, html) => `<${l}>${html}`, spanWidth: () => 1 };
  const settings = read('module-settings.js').match(/export function moduleSettingsHTML[\s\S]*?const dimensions[^\n]*\n/)[0].replace('export ', '') + 'return dimensions; }';
  vm.createContext(m); vm.runInContext(source('module-settings.js').match(/function choiceButtons[\s\S]*?\n}\n/)[0] + settings, m);
  const phone = m.moduleSettingsHTML({ height: 6 }, {}, [], true, '', null, [], { phone: true }), tablet = m.moduleSettingsHTML({ height: 2 }, {}, [], true, '');
  assert.equal((phone.match(/data-setting="height"/g) || []).length, 8); assert.match(phone, /data-value="6" class="is-on"/);
  assert.doesNotMatch(phone, /data-setting="width"/, 'une seule colonne : pas de largeur à choisir');
  assert.equal((tablet.match(/data-setting="height"/g) || []).length, 4); assert.match(tablet, /data-setting="width"/);
});

test('on the phone the Kanban is a swipeable carousel of full columns and the project filters scroll on one line', () => {
  const css = rules(read('phone.css')), find = re => css.find(r => re.test(r)) || '';
  assert.match(find(/\.pj-board-scroll\{/), /scroll-snap-type:x mandatory/);
  assert.match(find(/\.pj-board-scroll\{/), /margin:0 -14px;padding:0 14px/, 'les colonnes ne sont plus rognées par la double marge');
  assert.match(find(/\.pj-col\{/), /scroll-snap-align:start/);
  assert.match(find(/\.pj-board\{/), /repeat\(5,calc\(min\(100vw,560px\) - 56px\)\)/, 'une colonne par écran, la suivante dépasse');
  assert.match(find(/\.pj-filters,/), /flex-wrap:nowrap[^}]*overflow-x:auto/);
  assert.match(find(/\.pj-search input\{/), /font-size:16px/, 'pas de zoom automatique d’iOS sur le champ');
  assert.match(find(/\.pj-actions \.pj-cta\{/), /font-size:0/, '« Nouvelle tâche » devient un bouton + à côté de la recherche');
});

test('the Messages module fits a phone-width card: + instead of « Nouveau », no keyboard shortcut on touch screens', () => {
  const css = read('integrations/feedme/embedded.css');
  assert.match(css, /@media\(hover:none\) and \(pointer:coarse\)\{\.kbd,\.messenger-search kbd\{display:none\}\}/);
  assert.match(css, /@media\(max-width:420px\)\{[^\n]*\.messenger-top \.messenger-new\{[^}]*font-size:0/);
});

test('the weather card lists every upcoming day and clips the ones that do not fit', () => {
  const js = read('native-renderers.js'), css = read('design/home.css');
  assert.match(js, /const next = nDays \? upcoming : \[\];/);
  assert.match(js, /wh-day\$\{i >= nDays \? ' is-extra' : ''\}/);
  assert.match(css, /\.wh-days \{[^}]*flex-wrap: wrap;[^}]*overflow: hidden;/);
  assert.match(css, /@media \(max-width: 860px\), \(max-height: 620px\) \{ \.wh-day\.is-extra \{ display: none; \} \}/, 'les cartes à hauteur naturelle gardent leur nombre de jours');
});
