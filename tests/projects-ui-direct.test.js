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
  assert.match(page, /CLAUDE\.md généré par Cockpit · \d+ car\./); assert.match(page, /Régénérer/);
  // Fiche du projet : moteur (Claude Code choisi, recommandé), modèle (valeur par défaut en indication), secours.
  await click('edit-project', p.id);
  assert.match(shown(), /<option value="claude" selected>Claude Code · recommandé<\/option>/); assert.match(shown(), /<option value="openclaw" >OpenClaw<\/option>/);
  assert.match(shown(), /name="model"[^>]*placeholder="claude-sonnet-5-5"/); assert.match(shown(), /Secours automatique<select name="fallback"><option value="">Aucun<\/option>/);
  // Tâche : moteur, modèle, plan d'abord ; le plan coché est restitué.
  await click('new-task'); assert.match(shown(), /Moteur<select name="engine"><option value="">Celui du projet<\/option>/); assert.match(shown(), /Plan d’abord \(lecture seule\)/); assert.doesNotMatch(shown(), /name="planFirst" checked/);
  await click('open-task', task.id); assert.match(shown(), /name="planFirst" checked/); assert.match(shown(), /Claude Code reçoit les consignes de la tâche et commence par un plan en lecture seule ; les consignes du projet sont dans le CLAUDE\.md/);
  assert.doesNotMatch(shown(), /Tâche manuelle/);
});

test('Projects tab: an OpenClaw task keeps its agent line and manual wording', async t => {
  const { ui: api, project, create } = await setup(t);
  const p = await project('alpha', { engine: 'openclaw' }), task = await create(p.id);
  const { ui, shown, click } = loadUI(api);
  ui.html(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.match(ui.html(), /Manuelle/, 'no agent and OpenClaw engine: still a manual task');
  await click('open-task', task.id); assert.match(shown(), /Tâche manuelle : aucun agent ne répond ici/);
});
