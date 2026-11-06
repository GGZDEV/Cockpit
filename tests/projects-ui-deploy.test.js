const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { setup, settle, until, TOKEN } = require('./helpers/deploy-setup.js');

// Charge l'onglet Projets (modules du navigateur) dans un contexte isolé, branché sur le vrai service de projets et le faux service de déploiement.
function loadUI(api) {
  const listeners = {}, toasts = [], confirms = [];
  class FakeFormData { constructor(form) { this.rows = form.fields; } get(k) { return this.rows.find(([x]) => x === k)?.[1] ?? null; } has(k) { return this.rows.some(([x]) => x === k); } entries() { return this.rows[Symbol.iterator](); } [Symbol.iterator]() { return this.rows[Symbol.iterator](); } }
  const c = { location: { href: 'http://localhost/' }, URL, FormData: FakeFormData, console, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: f => f(), CSS: { escape: x => x },
    localStorage: { getItem: () => null, setItem() {} }, confirm: message => { confirms.push(message); return c.answer; }, answer: true, AbortSignal, crypto: { randomUUID: () => 'u' } };
  c.document = { hidden: false, activeElement: null, addEventListener: (n, f) => { listeners[n] = f; }, querySelector: () => null, querySelectorAll: () => [] };
  vm.createContext(c);
  const source = file => fs.readFileSync('public/' + file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=function|const)/g, '');
  vm.runInContext('(function () {' + source('core.js') + '\n' + source('task-chat.js') + '\nthis.libs = { esc, icon, read, write, uid, safeUrl, timeoutSignal, chatItems, composerMode, canClose, richText }; }).call(this);', c);
  vm.runInContext('(function (libs) { const { esc, icon, read, write, uid, safeUrl, timeoutSignal, chatItems, composerMode, canClose, richText } = libs;' + source('projects.js').replace('export function createProjectsUI', 'function createProjectsUI') + '\nthis.make = createProjectsUI; }).call(this, this.libs);', c);
  const modal = { open: false, querySelector: () => null, addEventListener() {}, classList: { add() {}, remove() {} }, showModal() {}, close() {} };
  let shown = '';
  const sources = { feedmeFetch: async (route, options) => { const r = await api(route.replace(/^\/api\/projects\//, ''), options.method || 'GET', options.body && JSON.parse(options.body)); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } };
  const ui = c.make({ sources, modal, showModal: (title, sub, html) => { shown = html; }, toast: m => toasts.push(m), render() {}, isActive: () => true });
  const click = async (pj, id, extra = {}) => { await listeners.click({ target: { closest: () => ({ dataset: { pj, id, ...extra }, disabled: false }) }, preventDefault() {} }); await new Promise(r => setImmediate(r)); };
  const submit = async (kind, fields, id = '') => { await listeners.submit({ target: { closest: () => ({ dataset: { pjForm: kind, id }, fields, querySelector: () => null, elements: {} }) }, preventDefault() {} }); await settle(60); };
  const page = async () => { ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await settle(30); return ui.html(); };
  return { ui, shown: () => shown, c, click, submit, page, toasts, confirms };
}
const open = async (view, id) => { await view.click('open-project', id); return view.ui.html(); };

test('board: a configured project shows its link, mode, last deployment and an enabled Déployer button', async t => {
  const s = await setup(t); const p = (await s.create('Alpha')).body;
  const view = loadUI(s.ui); await view.page(); let html = await open(view, p.id);
  assert.match(html, /class="pj-deploy"/); assert.match(html, /href="https:\/\/site\.ggz\.ovh\/?"/); assert.match(html, /Manuel/); assert.match(html, /Jamais déployé/);
  assert.match(html, /data-pj="deploy"[^>]*data-id="[^"]+"\s*title="Déployer maintenant"/); assert.doesNotMatch(html, /data-pj="deploy"[^>]*disabled/);
  assert.doesNotMatch(html, /Redéployer/);
  assert.ok(!html.includes(TOKEN));
});

test('board: with automatic deployment on, the button reads Redéployer and the mode is explained', async t => {
  const s = await setup(t); const p = (await s.create('Beta', {}, { ...s.SETTINGS, auto: true })).body;
  const view = loadUI(s.ui); await view.page(); const html = await open(view, p.id);
  assert.match(html, /Automatique/); assert.match(html, /Redéployer/); assert.doesNotMatch(html, /dès qu’un nouveau commit arrive/); assert.doesNotMatch(html, /data-pj="deploy"[^>]*disabled/);
});

test('board: Déployer is disabled with a clear message when the URL or the repository is missing, or the service has no token', async t => {
  const s = await setup(t);
  const noUrl = (await s.create('Gamma', {}, { type: 'ha-static', config: { src_dir: 'dist', ha_subdir: 'g' } })).body;
  const view = loadUI(s.ui); await view.page(); let html = await open(view, noUrl.id);
  assert.match(html, /data-pj="deploy"[^>]*disabled/); assert.match(html, /Pour déployer, renseignez : l’URL de déploiement\./);
  const noRepo = (await s.ui('projects', 'POST', { name: 'Delta', deployment: s.SETTINGS })).body;
  await view.ui.enter?.(); await view.page(); html = await open(view, noRepo.id);
  assert.match(html, /data-pj="deploy"[^>]*disabled/); assert.match(html, /dépôt GitHub du projet/);
  const bare = await setup(t, { client: { token: '' } }); const q = (await bare.create('Epsilon')).body;
  const v2 = loadUI(bare.ui); await v2.page(); html = await open(v2, q.id);
  assert.match(html, /data-pj="deploy"[^>]*disabled/); assert.match(html, /COCKPIT_DEPLOYER_TOKEN/); assert.match(html, /Non enregistré auprès du service/); assert.ok(!html.includes(TOKEN));
});

test('board: all five statuses are shown in French, the short journal is escaped, step and commit are visible', async t => {
  const s = await setup(t); const p = (await s.create('Zeta')).body; const view = loadUI(s.ui);
  await view.page(); await open(view, p.id); await s.ui('projects/' + p.id + '/deploy', 'POST');
  const labels = { pending: 'En attente', running: 'En cours', succeeded: 'Réussi', failed: 'Échoué', rolled_back: 'Revenu en arrière' };
  for (const [status, label] of Object.entries(labels)) {
    s.service.set('zeta', { status, message: 'Message ' + status, log_tail: 'ligne 1\n<script>alert(1)</script>', step: 'build' });
    await s.ui('projects/' + p.id + '/deploy'); await view.click('reload'); const html = view.ui.html();
    assert.match(html, new RegExp('pj-ws s-[a-z]+">' + label + '</span>'), status); assert.match(html, /a1b2c3d/); assert.doesNotMatch(html, /<script>alert/);
    if (status === 'succeeded') assert.doesNotMatch(html, /Message succeeded|Journal court/, 'a successful deployment needs no message nor journal');
    else { assert.match(html, new RegExp('Message ' + status)); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.match(html, /Journal court \(2 lignes\)/); }
    if (['pending', 'running'].includes(status)) assert.match(html, /data-pj="deploy"[^>]*disabled/, 'no second launch while one is active');
    else assert.doesNotMatch(html, /data-pj="deploy"[^>]*disabled/);
  }
});

test('click Déployer: confirmation, call, status shown; service errors become a readable message and nothing breaks', async t => {
  const s = await setup(t, { client: { timeoutMs: 300 } }); const p = (await s.create('Eta')).body; const view = loadUI(s.ui);
  await view.page(); await open(view, p.id);
  view.c.answer = false; await view.click('deploy', p.id); assert.match(view.confirms[0], /Déployer « Eta » en production sur https:\/\/site\.ggz\.ovh/);
  assert.equal(s.service.state.calls.filter(c => /\/deploy$/.test(c.route)).length, 0, 'declining the confirmation calls nothing');
  view.c.answer = true; await view.click('deploy', p.id); await settle(50);
  assert.equal(s.service.state.calls.filter(c => c.method === 'POST' && /\/deploy$/.test(c.route)).length, 1); assert.match(view.toasts.at(-1), /Déploiement lancé/);
  assert.match(view.ui.html(), /En attente/);
  s.service.set('eta', { status: 'succeeded' }); await s.ui('projects/' + p.id + '/deploy'); s.service.state.down = true;
  await view.click('deploy', p.id); assert.match(view.toasts.at(-1), /injoignable/);
  s.service.state.down = false; s.service.state.mode.reject422 = true;
  await view.click('deploy-register', p.id); assert.ok(view.toasts.length > 2);
});

test('public name: the validation button names the domain, asks for confirmation and calls the service once', async t => {
  const s = await setup(t); const p = (await s.create('Pi', {}, { ...s.SETTINGS, publicDomain: 'pi.ggz.ovh', publicUpstream: 'http://192.168.1.194:7000' })).body;
  const view = loadUI(s.ui); await view.page(); await s.ui('projects/' + p.id + '/deploy'); await view.page();
  let html = await open(view, p.id); assert.match(html, /Valider la mise en ligne publique de pi\.ggz\.ovh/); assert.match(html, /Le service ne publie rien sur Internet sans votre accord/);
  view.c.answer = false; await view.click('deploy-public', p.id, { name: 'pi.ggz.ovh' });
  assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 0, 'refusing the confirmation approves nothing');
  view.c.answer = true; await view.click('deploy-public', p.id, { name: 'pi.ggz.ovh' }); await settle(40);
  assert.match(view.confirms.at(-1), /Valider la mise en ligne publique de pi\.ggz\.ovh \?/); assert.equal(s.service.state.calls.filter(c => /approve/.test(c.route)).length, 1);
  html = view.ui.html(); assert.match(html, /En ligne publiquement/); assert.doesNotMatch(html, /Valider la mise en ligne publique/);
});

test('project form is simplified: Deployer only needs URL, automatic mode and branch; technical fields are hidden', async t => {
  const s = await setup(t); const p = (await s.create('Theta', {}, { ...s.SETTINGS, auto: true })).body; const view = loadUI(s.ui);
  await view.page(); await view.click('edit-project', p.id); const edit = view.shown();
  assert.match(edit, /name="deployUrl" maxlength="300" value="https:\/\/site\.ggz\.ovh"/); assert.match(edit, /name="deployAuto" checked/); assert.match(edit, /name="deployBranch"[^>]*value="main"/);
  assert.doesNotMatch(edit, /name="deployType"|name="cfg_|name="deployBuild"|name="deployTest"|name="deployDomain"|name="deployUpstream"/);
  assert.doesNotMatch(edit, /Préfixe des tâches|name="priority"|name="due"|name="objective"|name="resources"|name="environment"|name="publishing"|name="autoPublish"/);
  assert.match(edit, /Modèle Claude Code<select name="model">/);
  assert.match(edit, /class="pj-deploy"/); assert.doesNotMatch(edit, /name="repoMode"/); assert.ok(!edit.includes(TOKEN));
  await view.click('new-project'); const fresh = view.shown();
  assert.match(fresh, /name="repoMode" value="existing" checked/); assert.match(fresh, /name="repoMode" value="new"/); assert.match(fresh, /data-pj-ghstatus/); assert.match(fresh, /name="deployUrl"/); assert.doesNotMatch(fresh, /class="pj-deploy"/);
});

test('project form submit: an existing repository with deployment settings, and a NEW repository (created, pushed, registered)', async t => {
  const s = await setup(t); const view = loadUI(s.ui); await view.page();
  const common = [['description', 'Site'], ['status', 'prep'], ['color', '#3dd68c'], ['engine', 'claude'], ['model', 'claude-sonnet-5-5'], ['fallback', ''], ['agent', ''],
    ['instructions', 'Rester simple.'], ['links', ''], ['deployUrl', 'https://iota.ggz.ovh'], ['deployBranch', 'main']];
  await view.submit('project', [['name', 'Iota'], ['repository', 'https://github.com/ggzdev/iota'], ['repoMode', 'existing'], ...common, ['deployAuto', 'on']]);
  const iota = (await s.state()).projects.find(p => p.name === 'Iota');
  assert.equal(iota.context.repository, 'https://github.com/ggzdev/iota'); assert.equal(iota.context.instructions, 'Rester simple.'); assert.equal(iota.deployment.auto, true); assert.equal(iota.deployment.url, 'https://iota.ggz.ovh'); assert.deepEqual(iota.deployment.config, {});
  assert.equal(iota.bootstrap, undefined);
  await view.submit('project', [['name', 'Kappa Neuf'], ['repository', ''], ['repoMode', 'new'], ['newRepoName', ''], ['newRepoOwner', ''], ...common]);
  const kappa = await until(async () => { const p = (await s.state()).projects.find(x => x.name === 'Kappa Neuf'); return p?.bootstrap?.status === 'done' && p; });
  assert.deepEqual(s.github.created, [{ owner: 'ggzdev', name: 'kappa-neuf', isPrivate: true }]); assert.equal(kappa.deployState.registered.status, 'pending');
  assert.match(view.toasts.join('|'), /Projet créé\. Le dépôt GitHub/);
  // Erreur de validation : message du serveur affiché, rien n'est créé.
  await view.submit('project', [['name', 'Lambda'], ['repository', 'https://github.com/ggzdev/lambda'], ...common.filter(([k]) => k !== 'deployUrl'), ['deployUrl', 'http://pas-https.example.com']]);
  assert.match(view.toasts.at(-1), /https:\/\//); assert.equal((await s.state()).projects.some(p => p.name === 'Lambda'), false);
});

test('creation progress and failure are visible, with a Réessayer button that restarts it', async t => {
  const s = await setup(t, { github: { available: false } }); const view = loadUI(s.ui); await view.page();
  const r = await s.ui('projects', 'POST', { name: 'Mu', newRepository: { name: 'mu' }, deployment: s.SETTINGS }); await settle(80);
  await view.click('reload'); const html = await open(view, r.body.id);
  assert.match(html, /Création interrompue/); assert.match(html, /GitHub CLI n’est pas connecté/); assert.match(html, /data-pj="retry-bootstrap"/);
  s.github.available = true; await view.click('retry-bootstrap', r.body.id); await until(async () => (await s.state()).projects[0].bootstrap.status === 'done');
  assert.equal(s.github.created.length, 1);
});

test('backward compatible display: an old project without deployment fields renders (board and cards) without any deployment line', async t => {
  const s = await setup(t); const p = (await s.ui('projects', 'POST', { name: 'Ancien', context: { repository: 'https://github.com/ggzdev/ancien' } })).body; await settle();
  assert.equal(p.deployment, undefined);
  const view = loadUI(s.ui); await view.page(); const html = await open(view, p.id);
  assert.match(html, /Aucune URL de déploiement/); assert.match(html, /data-pj="deploy"[^>]*disabled/); assert.match(html, /Manuel/);
  await view.click('view'); assert.doesNotMatch(view.ui.html(), /Pas déployé/, 'the card stays unchanged without a URL');
});
