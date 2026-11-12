'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
test('hosted auth shim restores same-origin cookies without attaching them to external fetches', () => {
  const calls = [], window = { location: { href: 'https://worldmonitor.ggz.ovh/', origin: 'https://worldmonitor.ggz.ovh' }, fetch: (input, init) => calls.push({ input, init }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/hosted-auth.js'), 'utf8'), { window, URL, document: { addEventListener() {} } });
  window.fetch('/api/bootstrap?public=1', { credentials: 'omit' });
  window.fetch({ url: 'https://worldmonitor.ggz.ovh/api/news' }, { method: 'POST' });
  window.fetch('https://external.example/api', { credentials: 'omit' });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[1].init.credentials, 'same-origin'); assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[2].init.credentials, 'omit');
});
