const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function connection() {
  const context = { AbortSignal, fetch: () => { throw new Error('A test must provide its own local fetcher'); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extensions/brave/connection.js'), 'utf8'), context);
  return context.MetaBoardConnection;
}
test('the panel discovers MetaBoard through localhost, rejects unrelated apps and handles an offline service', async () => {
  const client = connection(), seen = [];
  const fetcher = async (url, options) => {
    seen.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return { ok: true, json: async () => ({ app: url.includes('localhost') ? 'metaboard' : 'another-app', browserPanel: 1 }) };
  };
  assert.equal(await client.discover(fetcher), 'http://localhost:3888');
  assert.equal(seen.length, 2);
  assert.equal(await client.probe('http://127.0.0.1:3888', fetcher), false);
  assert.equal(await client.discover(async () => { throw new Error('offline'); }), null);
});
test('the bridge marker is public and contains no account or service credentials', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/browser-status.json'), 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['app', 'browserPanel', 'version']);
});
