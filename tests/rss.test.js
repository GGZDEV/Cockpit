const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRss, parseFeed } = require('../rss.cjs');
const { createServer } = require('../server');

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Le Blog &amp; Cie</title>
<item><title><![CDATA[Premier <b>article</b>]]></title><link>https://blog.test/1</link><guid>a1</guid><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Résumé&amp;nbsp;court&lt;/p&gt;</description></item>
<item><title>Second</title><link>javascript:alert(1)</link><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atome</title><entry><title>Entrée</title><link rel="alternate" href="https://atom.test/e"/><id>tag:e</id><updated>2026-11-06T12:00:00Z</updated><summary>Texte</summary></entry></feed>`;

test('parses RSS and Atom into Cockpit articles', () => {
  const rss = parseFeed(RSS, { url: 'https://blog.test/feed', category: 'Tech' });
  assert.equal(rss.title, 'Le Blog & Cie');
  assert.deepEqual(rss.articles.map(a => [a.title, a.link, a.category, a.source]), [['Premier article', 'https://blog.test/1', 'Tech', 'Le Blog & Cie'], ['Second', '', 'Tech', 'Le Blog & Cie']]);
  assert.equal(rss.articles[0].description, 'Résumé court');
  assert.equal(rss.articles[0].pubDate, '2026-11-06T10:00:00.000Z');
  const atom = parseFeed(ATOM, { url: 'https://atom.test/feed' });
  assert.deepEqual([atom.articles[0].title, atom.articles[0].link, atom.articles[0].description], ['Entrée', 'https://atom.test/e', 'Texte']);
});

test('serves articles and manages feeds without the PC service', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-rss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bodies = { 'https://blog.test/feed': RSS, 'https://atom.test/feed': ATOM, 'https://html.test/': '<html></html>' };
  const fetchImpl = async url => new Response(bodies[url] ?? '', { status: bodies[url] ? 200 : 404 });
  const rss = createRss({ dataDir: dir, fetchImpl, defaults: [{ url: 'https://blog.test/feed', category: 'Tech' }] });
  const server = createServer({ serverMode: true, allowedHosts: ['127.0.0.1'], webPassword: 'secret', rss, projects: { allowedRoute: () => false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port, headers = { Authorization: 'Basic ' + Buffer.from('cockpit:secret').toString('base64'), 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(origin + '/api/status', { headers })).json()).rss, true);
  const articles = await (await fetch(origin + '/api/feedme/articles', { headers })).json();
  assert.deepEqual(articles.map(a => a.title), ['Premier article', 'Second']);
  const added = await fetch(origin + '/api/feedme/feeds', { method: 'POST', headers, body: JSON.stringify({ url: 'https://atom.test/feed', category: 'Science' }) });
  assert.equal(added.status, 200); assert.equal((await added.json()).length, 2);
  assert.equal((await fetch(origin + '/api/feedme/feeds', { method: 'POST', headers, body: JSON.stringify({ url: 'https://html.test/' }) })).status, 422);
  assert.equal((await fetch(origin + '/api/feedme/feeds', { method: 'POST', headers, body: JSON.stringify({ url: 'file:///etc/passwd' }) })).status, 400);
  assert.deepEqual((await (await fetch(origin + '/api/feedme/articles', { headers })).json()).map(a => a.title), ['Entrée', 'Premier article', 'Second']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'feeds.json'), 'utf8')).feeds.length, 2);
  const removed = await fetch(origin + '/api/feedme/feeds', { method: 'DELETE', headers, body: JSON.stringify({ url: 'https://blog.test/feed' }) });
  assert.deepEqual((await removed.json()).map(f => f.url), ['https://atom.test/feed']);
  assert.equal((await fetch(origin + '/api/feedme/spotify/status', { headers })).status, 503);
});
