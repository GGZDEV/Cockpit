const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');

test('the local bridge serves the interface, isolates source files and blocks unsafe proxy operations', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /Cockpit/);
  const source = await fetch(origin + '/server.js'); assert.equal(source.status, 404);
  const traversal = await fetch(origin + '/%2e%2e%5cserver.js'); assert.equal(traversal.status, 403);
  for (const [method, route] of [['POST', 'agents/exec'], ['DELETE', 'agents/files/secrets'], ['GET', 'spotify/authorize'], ['POST', 'todos/unrecognized/exec'], ['GET', 'agents/processes']]) {
    const r = await fetch(origin + '/api/feedme/' + route, { method }); assert.equal(r.status, 405, route);
  }
  const crossOrigin = await fetch(origin + '/api/feedme/agents/', { headers: { Origin: 'https://other.example' } }); assert.equal(crossOrigin.status, 403);
  const frameDocument = await fetch(origin, { headers: { 'sec-fetch-site': 'cross-site' } }); assert.equal(frameDocument.status, 200);
  const crossSiteAPI = await fetch(origin + '/api/feedme/agents/', { headers: { 'sec-fetch-site': 'cross-site' } }); assert.equal(crossSiteAPI.status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.get(origin, { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
});
