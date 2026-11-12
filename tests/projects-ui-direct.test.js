const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { setup } = require('./helpers/direct-setup.js');

// Charge l'onglet Projets (modules du navigateur) dans un contexte isolé, branché sur le vrai service de projets.
function loadUI(api) {
  const listeners = {};
  const c = { location: { href: 'http://localhost/' }, URL, FormData, console, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: f => f(), CSS: { escape: x => x },
    localStorage: { getItem: () => null, setItem() {} }, confirm: () => true, AbortSignal, crypto: { randomUUID: () => 'u' } };
  c.document = { hidden: false, activeElement: null, addEventListener: (n, f) => { listeners[n] = f; }, querySelector: () => null, querySelectorAll: () => [] };
  vm.createContext(c);
  const source = file => fs.readFileSync('public/' + file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=function|const)/g, '');
  // Chaque module dans sa propre fonction : task-chat.js et projects.js déclarent tous deux OPEN.
  vm.runInContext('(function () {' + source('core.js') + '\n' + source('task-chat.js') + '\nthis.libs = { esc, icon, read, write, uid, safeUrl, timeoutSignal, chatItems, composerMode, canClose, richText }; }).call(this);', c);
  vm.runInContext('(function (libs) { const { esc, icon, read, write, uid, safeUrl, timeoutSignal, chatItems, composerMode, canClose, richText } = libs;' + source('projects.js').replace('export function createProjectsUI', 'function createProjectsUI') + '\nthis.make = createProjectsUI; }).call(this, this.libs);', c);
  const modal = { open: false, querySelector: () => null, addEventListener() {}, classList: { add() {}, remove() {} }, showModal() {} };
  let shown = '';
  const sources = { feedmeFetch: async (route, options) => { const r = await api(route.replace(/^\/api\/projects\//, ''), options.method || 'GET', options.body && JSON.parse(options.body)); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } };
  const ui = c.make({ sources, modal, showModal: (title, sub, html) => { shown = html; }, toast() {}, render() {}, isActive: () => true });
  const click = async (pj, id, extra = {}) => { await listeners.click({ target: { closest: () => ({ dataset: { pj, id, ...extra }, disabled: false }) }, preventDefault() {} }); await new Promise(r => setImmediate(r)); };
  return { ui, shown: () => shown, c, click };
}

test('Projects tab: engine labels, task form and project form show the direct engines without an OpenClaw agent', async t => {
  const { ui: api, project, create } = await setup(t);
  const p = await project('alpha'), task = await create(p.id, { planFirst: true });
  const { ui, shown, click } = loadUI(api);
  ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  let page = ui.html();
  assert.match(page, /Claude Code/, 'the card names the engine instead of « Manuelle »'); assert.doesNotMatch(page, /Manuelle/); assert.match(page, new RegExp(task.code));
  await click('open-project', p.id); page = ui.html();
  assert.match(page, /pj-card-foot"><span class="pj-who">\d+ \S+ \d+:\d+<\/span>/, 'the board card shows its date, not the engine'); assert.doesNotMatch(page, /pj-av/);
  assert.match(page, /CLAUDE\.md généré par Cockpit · \d+ car\./); assert.match(page, /Régénérer/);
  // Fiche du projet : moteur (Claude Code choisi, recommandé), modèle (valeur par défaut en indication), secours.
  await click('edit-project', p.id);
  assert.match(shown(), /<option value="claude" selected>Claude Code · recommandé<\/option>/); assert.match(shown(), /<option value="openclaw" >OpenClaw<\/option>/);
  assert.match(shown(), /Modèle Claude Code<select name="model">/); assert.match(shown(), /claude-sonnet-5-5[^>]* selected>Sonnet 5.5/); assert.match(shown(), /claude-opus-5-5[^>]*>Opus 5.5/); assert.match(shown(), /claude-haiku-5-5[^>]*>Haiku 5.5/); assert.match(shown(), /Secours automatique<select name="fallback"><option value="">Aucun<\/option>/);
  // Tâche : moteur, modèle, plan d'abord ; le plan coché est restitué.
  await click('new-task'); assert.match(shown(), /Moteur<select name="engine"><option value="">Celui du projet<\/option>/); assert.match(shown(), /Plan d’abord \(lecture seule\)/); assert.doesNotMatch(shown(), /name="planFirst" checked/);
  await click('open-task', task.id); assert.match(shown(), /name="planFirst" checked/); assert.doesNotMatch(shown(), /reçoit les consignes de la tâche/);
  assert.doesNotMatch(shown(), /Tâche manuelle/);
});

test('Projects tab: an OpenClaw task keeps its agent line and manual wording', async t => {
  const { ui: api, project, create } = await setup(t);
  const p = await project('alpha', { engine: 'openclaw' }), task = await create(p.id);
  const { ui, shown, click } = loadUI(api);
  ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.match(ui.html(), /Manuelle/, 'no agent and OpenClaw engine: still a manual task');
  await click('open-task', task.id); assert.match(ui.html(), /Tâche manuelle : aucun agent ne répond ici/);
  await click('view-set', 'board'); await click('open-task', task.id); assert.match(shown(), /Tâche manuelle : aucun agent ne répond ici/);
});

test('Projects tab: the default view is a chat — tasks as conversations, new task as an empty chat', async t => {
  const { ui: api, project, create } = await setup(t);
  const p = await project('alpha'), task = await create(p.id, { title: 'Corriger le déploiement' });
  const { ui, shown, click } = loadUI(api);
  ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  let page = ui.html();
  assert.match(page, /class="pj-root is-chat /); assert.match(page, /<h2 style="--gc:[^"]+">Brouillons<span>1<\/span><\/h2>/);
  assert.match(page, new RegExp('data-pj="open-task" data-id="' + task.id + '"[^]*Corriger le déploiement[^]*' + task.code + ' · Non lancé · Claude Code'));
  assert.match(page, /Que doit faire Claude Code sur alpha \?/); assert.match(page, /data-pj-form="new-chat"/); assert.match(page, /Garder en brouillon/); assert.match(page, /Reprendre un brouillon/);
  await click('open-task', task.id); page = ui.html();
  assert.match(page, /<h1>Corriger le déploiement<\/h1><span class="pj-pill is-draft"><i><\/i>Brouillon<\/span>/); assert.match(page, /aria-current="step"[^>]*>[^]*Brouillon<\/li>/);
  assert.match(page, /class="pj-chat-thread"/); assert.match(page, /data-pj-form="chat"/); assert.match(page, /aria-label="Contexte de la tâche"/); assert.match(page, /<dt>Moteur<\/dt><dd>Claude Code<\/dd>/);
  assert.match(page, /data-pj="close-task"/); assert.doesNotMatch(page, /pj-chatbox-foot[^]*data-pj="close-task"/, 'Clore lives in the header only');
  await click('task-details', task.id); assert.match(shown(), /data-pj-form="edit-task"/);
  await click('chat-new'); assert.match(ui.html(), /data-pj-form="new-chat"/);
});

test('Projects tab: a task with a work branch offers « Clore » and « Clore et déployer »; « Clore » publishes nothing', async t => {
  const { ui: api, project, create, launch, lastDone, task: get } = await setup(t);
  const p = await project('alpha'), task = await create(p.id);
  await launch(task.id); assert.ok((await lastDone(task.id)).direct.branch);
  const { ui, click } = loadUI(api);
  ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  await click('open-task', task.id); const page = ui.html();
  assert.match(page, /data-pj="close-task" data-publish="0"[^>]*>[^<]*<svg[^]*?Clore<\/button>/); assert.match(page, /Clore et déployer/);
  await click('close-task', task.id, { publish: '0' });
  const closed = await get(task.id);
  assert.equal(closed.status, 'done'); assert.equal(closed.published, undefined);
});
