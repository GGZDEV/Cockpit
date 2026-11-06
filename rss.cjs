'use strict';
// Veille autonome : Cockpit lit lui-même les flux RSS/Atom, sans l'application PC.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FEEDS = [
  { url: 'https://www.lemonde.fr/rss/une.xml', category: 'Actualité' },
  { url: 'https://www.numerama.com/feed/', category: 'Tech' },
  { url: 'https://korben.info/feed', category: 'Tech' },
  { url: 'https://hnrss.org/frontpage', category: 'Tech' }
];
const MAX_FEEDS = 100, MAX_BYTES = 4 * 1024 * 1024, PER_FEED = 60, STALE = 15 * 60 * 1000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };

class RssError extends Error { constructor(status, message) { super(message); this.status = status; } }
function decode(text) {
  return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => code[0] === '#' ? (n => Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '')(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ENTITIES[code.toLowerCase()] ?? all)
    .trim();
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
// Le HTML échappé des résumés laisse souvent des entités doublées (&amp;nbsp;) : second décodage après les balises.
const text = html => decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function atomLink(entry) {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map(m => m[1]);
  const pick = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a)) || links[0] || '';
  return decode((pick.match(/href=["']([^"']+)["']/i) || [])[1] || '');
}
// Lecture volontairement tolérante : RSS 2.0, RSS 1.0 (RDF) et Atom.
function parseFeed(xml, feed) {
  const atom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const source = feed.title || text(tag(head, 'title')) || new URL(feed.url).hostname;
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map(m => m[0]).slice(0, PER_FEED);
  return { title: source, articles: blocks.map(block => {
    const link = atom ? atomLink(block) : tag(block, 'link') || (block.match(/<guid[^>]*>([^<]+)<\/guid>/i) || [])[1] || '';
    const title = text(tag(block, 'title')) || 'Sans titre';
    const date = new Date(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'));
    const description = text(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content')).slice(0, 600);
    const key = tag(block, 'guid') || tag(block, 'id') || link || title;
    return { id: crypto.createHash('sha1').update(feed.url + '\n' + key).digest('hex').slice(0, 20), title, link: /^https?:\/\//i.test(link) ? link : '', description, pubDate: Number.isNaN(date.getTime()) ? null : date.toISOString(), source, category: feed.category || '' };
  }) };
}
function feedUrl(value) {
  let url; try { url = new URL(String(value || '').trim()); } catch { throw new RssError(400, 'Adresse du flux invalide.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RssError(400, 'Utilisez une adresse HTTP ou HTTPS.');
  url.hash = ''; return url.href;
}

function createRss({ dataDir = path.join(__dirname, 'data'), fetchImpl = fetch, defaults = DEFAULT_FEEDS, log = () => {} } = {}) {
  const file = path.join(dataDir, 'feeds.json');
  let feeds;
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); feeds = Array.isArray(saved.feeds) ? saved.feeds : null; }
  catch (error) { if (error.code !== 'ENOENT') log('Veille : fichier des flux illisible.'); }
  feeds ||= defaults.map(f => ({ ...f }));
  const cache = new Map(); // url -> { at, articles, error }
  let refreshing = null;
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, feeds }));
    fs.renameSync(temp, file);
  }
  async function load(feed) {
    try {
      const response = await fetchImpl(feed.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'User-Agent': 'Cockpit/1.0 (+lecteur RSS)' }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const body = await response.text();
      if (body.length > MAX_BYTES) throw new Error('flux trop volumineux');
      if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(body)) throw new Error('ce n’est pas un flux RSS ou Atom');
      const parsed = parseFeed(body, feed);
      if (!feed.title && parsed.title) feed.title = parsed.title;
      cache.set(feed.url, { at: Date.now(), articles: parsed.articles });
    } catch (error) {
      cache.set(feed.url, { at: Date.now(), articles: cache.get(feed.url)?.articles || [], error: error.message || 'flux injoignable' });
    }
  }
  function refresh(force = false) {
    const due = feeds.filter(f => force || !cache.has(f.url) || Date.now() - cache.get(f.url).at > STALE);
    if (!due.length) return Promise.resolve();
    return refreshing ||= Promise.all(due.map(load)).finally(() => { refreshing = null; });
  }
  async function articles() {
    await refresh();
    const seen = new Set();
    return feeds.flatMap(f => cache.get(f.url)?.articles || []).filter(a => !seen.has(a.id) && seen.add(a.id))
      .sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  }
  const list = () => feeds.map(f => ({ ...f, count: cache.get(f.url)?.articles.length ?? null, error: cache.get(f.url)?.error || '' }));
  async function add({ url, category }) {
    const href = feedUrl(url);
    if (feeds.some(f => f.url === href)) throw new RssError(409, 'Ce flux est déjà suivi.');
    if (feeds.length >= MAX_FEEDS) throw new RssError(400, 'Trop de flux suivis.');
    const feed = { url: href, category: String(category || '').trim().slice(0, 40) };
    await load(feed);
    if (cache.get(href).error) { const message = cache.get(href).error; cache.delete(href); throw new RssError(422, 'Flux illisible : ' + message + '.'); }
    feeds.push(feed); save(); return list();
  }
  function remove({ url }) {
    const before = feeds.length; feeds = feeds.filter(f => f.url !== url); cache.delete(url);
    if (feeds.length === before) throw new RssError(404, 'Flux introuvable.');
    save(); return list();
  }
  const ROUTES = { 'GET /api/articles': () => articles(), 'POST /api/articles/refresh': async () => { await refresh(true); return { ok: true }; }, 'GET /api/feeds': async () => { await refresh(); return list(); }, 'POST /api/feeds': add, 'DELETE /api/feeds': remove };
  const handles = (method, pathname) => !!ROUTES[method + ' ' + pathname];
  async function handle(req, res, pathname, json) {
    try {
      let body = {};
      if (req.method !== 'GET') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new RssError(413, 'Requête trop longue.'); chunks.push(chunk); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw new RssError(400, 'Requête invalide.'); }
      }
      json(res, 200, await ROUTES[req.method + ' ' + pathname](body || {}));
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'La veille est indisponible.' }); }
  }
  return { handles, handle, articles, list, add, remove, refresh };
}
module.exports = { createRss, parseFeed, DEFAULT_FEEDS };
