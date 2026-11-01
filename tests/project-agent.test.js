const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MODEL, CODE, GENERAL, RULES, agentSettings, configCommand, workspaceFiles } = require('../project-agent.cjs');
const { skill } = require('../scripts/openclaw-skill.js');

const batch = command => JSON.parse(/--batch-json '(.+)'$/.exec(command)[1]);

test('a code project agent keeps Opus 5.5 with GPT-5.6 Sol as fallback and only the tools needed to develop', () => {
  const settings = agentSettings({ context: { repository: 'https://github.com/ggzdev/vitrine' } });
  assert.equal(settings.kind, 'code');
  assert.deepEqual(settings.model, { primary: 'anthropic/claude-opus-5-5', fallbacks: ['openai/gpt-5.6-sol'] });
  assert.equal(settings.tools.profile, 'minimal');
  for (const tool of ['group:fs', 'exec', 'process', 'web_search', 'web_fetch', 'browser', 'view_image']) assert.ok(settings.tools.alsoAllow.includes(tool), tool);
  for (const tool of ['message', 'automations', 'gateway', 'nodes', 'image_generate', 'video_generate', 'tts', 'dashboard', 'wiki_search']) assert.ok(!settings.tools.alsoAllow.includes(tool), tool);
  assert.ok(!('allow' in settings.tools), 'allow and alsoAllow cannot be combined');
  for (const name of ['github', 'browser-automation', 'cockpit-projets']) assert.ok(settings.skills.includes(name), name);
  assert.ok(settings.skills.length <= 5, 'few skills, loaded on demand');
});

test('a project without repository keeps a general profile and every skill', () => {
  const settings = agentSettings({ context: {} });
  assert.equal(settings.kind, 'general');
  assert.deepEqual(settings.model, MODEL);
  assert.equal(settings.tools.profile, 'coding'); assert.ok(settings.tools.alsoAllow.includes('browser'));
  assert.equal(settings.skills, undefined);
});

test('one config command touches only the new agent entry', () => {
  const ops = batch(configCommand('site-vitrine', agentSettings({ repository: 'x' })));
  assert.deepEqual(ops.map(op => op.path), ['agents.entries.site-vitrine.model', 'agents.entries.site-vitrine.tools', 'agents.entries.site-vitrine.skills']);
  assert.deepEqual(ops[0].value, MODEL); assert.deepEqual(ops[1].value, CODE.tools); assert.deepEqual(ops[2].value, CODE.skills);
  assert.deepEqual(batch(configCommand('notes', agentSettings({}))).map(op => op.path), ['agents.entries.notes.model', 'agents.entries.notes.tools']);
});

test('workspace files stay short and carry the efficiency and safety rules', () => {
  for (const rule of [/en une seule passe/, /au plus 2 cycles/, /suite complète une seule fois/, /même tour/, /ne pas relire/, /secret/, /git status/]) assert.match(RULES, rule);
  assert.ok(RULES.length < 1600);
  const files = workspaceFiles('site-vitrine', '2026-11-01');
  assert.deepEqual(Object.keys(files), ['USER.md', 'IDENTITY.md', 'SOUL.md']);
  assert.match(files['USER.md'], /observed: 2026-11-01 \| status: active/); assert.doesNotMatch(files['USER.md'], /YYYY|AAAA/);
  assert.match(files['IDENTITY.md'], /^- Name: site-vitrine$/m);
  for (const body of Object.values(files)) assert.ok(body.length < 400);
});

test('the generated OpenClaw skill creates project agents with the same settings', () => {
  const text = skill('http://100.64.0.1:3890/agent/v1/', 'TOKEN');
  assert.match(text, /anthropic\/claude-opus-5-5/); assert.match(text, /openai\/gpt-5\.6-sol/);
  assert.ok(text.includes(configCommand('<id>', agentSettings({ repository: true }))));
  assert.ok(text.includes(JSON.stringify(GENERAL.tools)), 'non-code projects stay possible');
  assert.ok(text.includes(RULES));
  for (const name of ['USER.md', 'IDENTITY.md', 'SOUL.md']) assert.ok(text.includes('`' + name + '`'), name);
});
