const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

// Charge core.js puis task-chat.js (modules du navigateur) dans un contexte isolé.
function load() {
  const c = { location: { href: 'http://localhost/' }, URL };
  vm.createContext(c);
  const source = file => fs.readFileSync('public/' + file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(source('core.js') + '\n' + source('task-chat.js') + '\nthis.api = { chatItems, composerMode, canClose, richText };', c);
  return c.api;
}
const { chatItems, composerMode, canClose, richText } = load();
const agent = { connectionId: 'c1', agentId: 'cockpit', name: 'cockpit' };
const run = (kind, extra) => ({ id: kind + Math.random(), kind, note: '', agent, status: 'succeeded', outcome: 'result', result: 'Fait', createdAt: '2026-10-30T10:00:00Z', endedAt: '2026-10-30T10:05:00Z', events: [], ...extra });

test('the task thread reads like a conversation: brief, agent replies and your messages in order', () => {
  const task = { id: 't', status: 'review', agent, instructions: 'Faire la version iPhone', createdAt: '2026-10-30T09:00:00Z', attachments: [{ id: 'a', name: 'capture.png', size: 2048 }], runs: [
    run('initial', { outcome: 'question', result: 'Quel écran ?' }),
    run('answer', { note: 'Celui de l’accueil', accepted: '2026-10-30T11:00:00Z' }),
    run('reprise', { note: 'Ajoute le mode sombre', status: 'failed', outcome: undefined, error: 'Build cassé' }),
    run('retry', { note: '' }),
  ] };
  const items = JSON.parse(JSON.stringify(chatItems(task).map(i => [i.role, i.type, i.text])));
  assert.deepEqual(items, [
    ['user', 'brief', 'Faire la version iPhone'],
    ['system', 'launch', 'Confiée à cockpit'],
    ['agent', 'question', 'Quel écran ?'],
    ['user', 'answer', 'Celui de l’accueil'],
    ['agent', 'result', 'Fait'],
    ['system', 'accepted', 'Résultat accepté · tâche close'],
    ['user', 'reprise', 'Ajoute le mode sombre'],
    ['agent', 'error', 'Build cassé'],
    ['system', 'retry', 'Relance envoyée à cockpit'],
    ['agent', 'result', 'Fait'],
  ]);
  assert.equal(chatItems(task)[0].attachments[0].name, 'capture.png', 'attachments stay visible with the brief');
});

test('files added during the conversation appear with the message that sent them', () => {
  const att = (id, at) => ({ id, name: id + '.png', size: 10, at });
  const task = { id: 't', status: 'review', agent, instructions: 'X', createdAt: '2026-10-30T09:00:00Z',
    attachments: [att('a', '2026-10-30T09:30:00Z'), att('b', '2026-10-30T10:30:00Z'), att('c', '2026-10-30T11:30:00Z'), att('d', '2026-10-30T12:30:00Z')], runs: [
      run('initial', { createdAt: '2026-10-30T10:00:00Z' }),
      run('reprise', { note: 'Voici la capture', createdAt: '2026-10-30T11:00:00Z' }),
      run('retry', { createdAt: '2026-10-30T12:00:00Z' }),
    ] };
  const items = chatItems(task).filter(i => i.attachments?.length).map(i => [i.type, i.attachments.map(a => a.id).join(), !!i.waiting]);
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [['brief', 'a', false], ['reprise', 'b', false], ['files', 'c', false], ['files', 'd', true]]);
});

test('a running execution shows a live agent message, and a closed task ends the thread', () => {
  const live = chatItems({ status: 'doing', agent, instructions: 'X', runs: [run('initial', { status: 'started', outcome: undefined, liveText: 'Je regarde…' })] }).at(-1);
  assert.equal(live.type, 'live'); assert.equal(live.text, 'Je regarde…');
  const closed = chatItems({ status: 'done', agent, instructions: 'X', acceptedAt: '2026-10-30T12:00:00Z', runs: [run('initial', { outcome: 'question' })] }).at(-1);
  assert.equal([closed.role, closed.type, closed.text].join('|'), 'system|closed|Tâche close');
  assert.equal(chatItems({ status: 'done', agent, instructions: 'X', runs: [run('initial', { accepted: '2026-10-30T12:00:00Z' })] }).filter(i => i.role === 'system' && /close/.test(i.text)).length, 1, 'no duplicate closing line');
});

test('the composer adapts to the task: first message, answer, retry, follow-up, busy, manual', () => {
  assert.equal(composerMode({ agent: null, runs: [] }).mode, 'manual');
  const first = composerMode({ agent, instructions: '', runs: [] });
  assert.equal(first.kind, 'initial'); assert.equal(first.setsInstructions, true, 'a task without instructions takes the first message as its instructions');
  const ready = composerMode({ agent, instructions: 'X', runs: [] });
  assert.equal(ready.kind, 'initial'); assert.equal(ready.needsText, false);
  assert.equal(composerMode({ agent, status: 'blocked', runs: [run('initial', { outcome: 'question' })] }).kind, 'answer');
  assert.equal(composerMode({ agent, status: 'blocked', runs: [run('initial', { status: 'failed' })] }).kind, 'retry');
  const follow = composerMode({ agent, status: 'review', runs: [run('initial')] });
  assert.equal(follow.kind, 'reprise'); assert.equal(follow.quick, true);
  assert.equal(composerMode({ agent, status: 'done', runs: [run('initial', { status: 'failed' })] }).kind, 'reprise', 'a closed task can be continued');
  assert.equal(composerMode({ agent, status: 'doing', runs: [run('initial', { status: 'pending' })] }).mode, 'busy');
  assert.equal(composerMode({ agent, status: 'review', runs: [run('initial')] }, { busy: true }).mode, 'busy', 'no double send while launching');
});

test('a task can be closed unless it is already done or an agent is working on it', () => {
  assert.equal(canClose({ status: 'review', runs: [run('initial')] }), true);
  assert.equal(canClose({ status: 'todo', runs: [] }), true);
  assert.equal(canClose({ status: 'done', runs: [] }), false);
  assert.equal(canClose({ status: 'doing', runs: [run('initial', { status: 'started' })] }), false);
});

test('agent replies get light formatting and stay escaped', () => {
  const html = richText('Il reste :\n\n- **GitHub** : `main` à jour\n- voir https://github.com/GGZDEV/Cockpit.\n\n2. Partager\n3. Ajouter\n\n```\nnpm test\n```');
  assert.match(html, /<ul><li><strong>GitHub<\/strong> : <code>main<\/code> à jour<\/li>/);
  assert.match(html, /<a href="https:\/\/github.com\/GGZDEV\/Cockpit" target="_blank" rel="noopener noreferrer">https:\/\/github.com\/GGZDEV\/Cockpit<\/a>\./, 'final punctuation is not part of the link');
  assert.match(html, /<ol start="2"><li>Partager<\/li><li>Ajouter<\/li><\/ol>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
  const evil = richText('<img src=x onerror=alert(1)> **<b>x</b>** `<script>` javascript:alert(1) https://a.b/"onmouseover="x');
  assert.doesNotMatch(evil, /<img|<script|<b>|href="javascript/);
  assert.doesNotMatch(evil, /href="[^"]*"onmouseover/);
  assert.match(richText('ligne 1\nligne 2\n\nautre'), /^<p>ligne 1<br>ligne 2<\/p><p>autre<\/p>$/);
});

test('lists in agent replies keep their bullets even where the home design resets list styles', () => {
  const css = fs.readFileSync(__dirname + '/../public/projects.css', 'utf8');
  assert.match(css, /\.pj-bubble ul\{list-style:disc\}/);
  assert.match(css, /\.pj-bubble ol\{list-style:decimal\}/);
});

test('direct engines (Claude Code, Codex): no agent to choose, optional plan with its own actions, plan and execution in the thread', () => {
  const claude = { name: 'Claude Code' };
  assert.equal(composerMode({ agent: null, runs: [] }).mode, 'manual', 'an OpenClaw task with no agent is still manual');
  const first = composerMode({ agent: null, instructions: 'X', runs: [] }, { direct: true });
  assert.deepEqual([first.mode, first.kind, first.needsText, first.label], ['send', 'initial', false, 'Lancer']);
  const runPlan = (kind, extra) => ({ ...run(kind, { agent: claude, outcome: 'plan', result: '1. Faire' }), ...extra });
  const planned = composerMode({ agent: null, status: 'review', instructions: 'X', runs: [runPlan('initial')] }, { direct: true });
  assert.deepEqual([planned.kind, planned.label, planned.needsText, planned.alt.kind, planned.alt.label], ['execute', 'Exécuter le plan', false, 'reprise', 'Réviser le plan']);
  const items = JSON.parse(JSON.stringify(chatItems({ id: 't', status: 'review', agent: null, instructions: 'X', createdAt: '2026-10-30T09:00:00Z', runs: [
    runPlan('initial'), { ...run('execute', { agent: claude }), note: '' }] }).map(i => [i.role, i.type, i.text])));
  assert.deepEqual(items, [['user', 'brief', 'X'], ['system', 'launch', 'Confiée à Claude Code'], ['agent', 'plan', '1. Faire'], ['user', 'execute', 'Plan accepté : exécute-le.'], ['agent', 'result', 'Fait']]);
  assert.equal(composerMode({ agent: null, status: 'doing', runs: [run('initial', { status: 'started' })] }, { direct: true }).mode, 'busy');
});
