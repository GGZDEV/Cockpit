#!/usr/bin/env node
'use strict';
// Vérification visuelle sans dépendance : démarre le serveur du projet (ou utilise --url), puis fait des captures séquentielles
// avec Chromium headless en ligne de commande, en mobile (390×844, iPhone) et en bureau (1440×900).
//   node scripts/visual-check.cjs [--path /] [--path /autre] [--out dossier] [--wait 60] -- npm start
//   node scripts/visual-check.cjs --url http://127.0.0.1:3000 --path /
// Le serveur reçoit PORT (libre) et HOST=127.0.0.1. Sortie : JSON (fichiers produits). Serveur, Chromium et profils temporaires
// sont toujours supprimés, même en erreur ou en délai dépassé. Abandon propre si la mémoire disponible est trop faible.
// Inspection (--inspect, implicite avec une étape) : Chromium piloté par le protocole DevTools (WebSocket de Node, sans dépendance) ;
// relève les erreurs JavaScript et de console, les débordements horizontaux, et rejoue des étapes, chacune suivie d'une capture :
//   node scripts/visual-check.cjs --inspect --click "#menu" --type "#q=bonjour" --eval "window.scrollTo(0, 400)" -- npm start
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { name: 'bureau', width: 1440, height: 900 }
];
const MIN_MB = 350, CAPTURE_TIMEOUT = 60000, PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function parse(argv) {
  const at = argv.indexOf('--'), own = at < 0 ? argv : argv.slice(0, at), command = at < 0 ? [] : argv.slice(at + 1);
  const options = { paths: [], command, url: '', out: '', wait: 60, inspect: false, steps: [] };
  for (let i = 0; i < own.length; i++) {
    const [key, inline] = own[i].split(/=(.*)/s), value = () => { const v = inline ?? own[++i]; if (v === undefined) throw new Error(key + ' : valeur attendue.'); return v; };
    if (key === '--path') options.paths.push(value());
    else if (key === '--url') options.url = value();
    else if (key === '--out') options.out = value();
    else if (key === '--wait') options.wait = Number(value());
    else if (key === '--inspect' && inline === undefined) options.inspect = true;
    else if (key === '--click') options.steps.push({ click: value() });
    else if (key === '--type') { const [selector, text] = value().split(/=(.*)/s); if (text === undefined) throw new Error('--type : « sélecteur=texte » attendu.'); options.steps.push({ type: selector, text }); }
    else if (key === '--eval') options.steps.push({ eval: value() });
    else throw new Error('Option inconnue : ' + own[i]);
  }
  if (options.steps.length) options.inspect = true;
  if (options.steps.length > 10) throw new Error('10 étapes au plus.');
  if (!options.paths.length) options.paths.push('/');
  if (!options.url && !command.length) throw new Error('Indiquez la commande du serveur après « -- » ou --url.');
  if (!(options.wait > 0 && options.wait <= 600)) throw new Error('--wait : entre 1 et 600 secondes.');
  return options;
}
// Mémoire disponible (Mo) d'après /proc/meminfo ; inconnue ailleurs.
function memAvailableMb(file = '/proc/meminfo') {
  try { const kb = Number(/^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync(file, 'utf8'))?.[1]); return Number.isFinite(kb) && kb > 0 ? Math.floor(kb / 1024) : null; } catch { return null; }
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// Programme : un script .js passe par node (faux Chromium des tests, serveurs Node).
const program = (file, args) => /\.[cm]?js$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args];
function launch(file, args, options) {
  const [bin, list] = program(file, args);
  const child = spawn(bin, list, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, ...options });
  child.output = ''; const take = chunk => { child.output = (child.output + chunk).slice(-4000); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.exited = new Promise(resolve => { child.on('exit', (code, signal) => resolve({ code, signal })); child.on('error', error => resolve({ code: null, error: error.message })); });
  return child;
}
// Arrêt du groupe de processus (serveur et ses enfants, Chromium et ses processus), puis SIGKILL si besoin.
async function stopTree(child, graceMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const signal = sig => { try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* déjà arrêté */ } } };
  signal('SIGTERM');
  const timer = new Promise(resolve => setTimeout(resolve, graceMs, 'late'));
  if (await Promise.race([child.exited, timer]) === 'late') { signal('SIGKILL'); await Promise.race([child.exited, new Promise(r => setTimeout(r, 2000))]); }
  else signal('SIGKILL'); // enfants restés dans le groupe
}
function respond(url, timeoutMs = 2000) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(0));
  });
}
// ----- Inspection par le protocole DevTools ----------------------------------------------------------
// Client minimal : commandes numérotées, événements transmis à on().
function devtools(wsUrl) {
  if (typeof WebSocket !== 'function') throw new Error('--inspect demande Node 22 ou plus récent (WebSocket intégré).');
  const ws = new WebSocket(wsUrl), pending = new Map(), handlers = [];
  let seq = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else if (m.method) for (const h of handlers) h(m.method, m.params || {});
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('connexion DevTools impossible')); });
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('connexion DevTools fermée')); pending.clear(); };
  return { opened, on: h => handlers.push(h), close: () => { try { ws.close(); } catch { /* fermée */ } },
    send: (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Éléments qui dépassent à droite de la fenêtre (3 au plus), décrits par balise#id.classe.
const OVERFLOW = `(() => { const w = document.documentElement.clientWidth, extra = document.documentElement.scrollWidth - w; if (extra <= 1) return null;
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const wide = [...document.body.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > w + 1 && ![...e.children].some(c => c.getBoundingClientRect().right > w + 1)).slice(0, 3).map(name);
  return { extra, elements: wide }; })()`;
const STEP = step => step.eval ?? `(() => { const el = document.querySelector(${JSON.stringify(step.click ?? step.type)}); if (!el) throw new Error('élément introuvable : ' + ${JSON.stringify(step.click ?? step.type)});
  el.scrollIntoView({ block: 'center' }); ${step.click ? 'el.click();' : `el.focus(); el.value = ${JSON.stringify(step.text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));`} })()`;
const stepLabel = step => step.click ? 'clic ' + step.click : step.type ? 'saisie ' + step.type : 'eval';

// Une page, une dimension : chargement, erreurs, débordement, capture, puis étapes (capture après chacune). Remplit result.
async function inspectPage({ browser, profile, view, target, file, steps, result, settleMs }) {
  const where = `${target.path} ${view.name}`, portFile = path.join(profile, 'DevToolsActivePort');
  let port = '';
  while (!port) { if (browser.exitCode !== null) return {}; try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); } catch { await sleep(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), page = pages.find(p => p.type === 'page');
  if (!page) throw new Error('aucun onglet DevTools');
  const cdp = devtools(page.webSocketDebuggerUrl);
  try {
    await cdp.opened;
    const seen = new Set(), note = text => { const line = `${where} : ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`; if (!seen.has(line) && result.console.length < 50) { seen.add(line); result.console.push(line); } };
    let loaded = () => {};
    cdp.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') note(p.exceptionDetails?.exception?.description?.split('\n')[0] || p.exceptionDetails?.text);
      else if (method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(p.type)) note('console.' + p.type + ' ' + (p.args || []).map(a => a.value ?? a.description ?? '').join(' '));
      else if (method === 'Log.entryAdded' && p.entry?.level === 'error' && !/\/favicon\.ico$/.test(p.entry.url || '')) note(p.entry.text + (p.entry.url ? ' (' + p.entry.url + ')' : ''));
      else if (method === 'Page.loadEventFired') loaded();
    });
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable'].map(m => cdp.send(m)));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: !!view.userAgent });
    if (view.userAgent) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const load = new Promise(resolve => { loaded = resolve; });
    await cdp.send('Page.navigate', { url: target.url });
    await load; await sleep(settleMs);
    const evaluate = async expression => { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0].replace(/^Error: /, '')); return r.result.value; };
    let lastOverflow = 'null'; // débordement noté à la capture initiale puis seulement s'il change après une étape
    const capture = async (name, label) => {
      const over = await evaluate(OVERFLOW), key = JSON.stringify(over);
      if (over && key !== lastOverflow) result.overflow.push({ path: target.path, viewport: view.name, ...(label ? { step: label } : {}), extraPx: over.extra, elements: over.elements });
      const data = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      lastOverflow = key; fs.writeFileSync(name, data);
      result.files.push({ path: target.path, viewport: view.name, width: view.width, height: view.height, ...(label ? { step: label } : {}), file: name, bytes: data.length });
    };
    await capture(file, '');
    for (const [i, step] of steps.entries()) {
      try { await evaluate(STEP(step)); } catch (error) { result.errors.push(`${where} · étape ${i + 1} (${stepLabel(step)}) : ${error.message}`); }
      await sleep(settleMs);
      await capture(file.replace(/\.png$/, '-etape' + (i + 1) + '.png'), (i + 1) + ' · ' + stepLabel(step));
    }
    return {};
  } finally { cdp.close(); }
}
const slug = value => (value.replace(/^\/+|\/+$/g, '').replace(/[^\w-]+/g, '_') || 'accueil').slice(0, 60);

async function main(argv, { env = process.env, chromium = env.COCKPIT_CHROMIUM || '/usr/bin/chromium', minMb = Number(env.COCKPIT_VISUAL_MIN_MB) || MIN_MB, memory = memAvailableMb,
  tmpRoot = os.tmpdir(), captureTimeoutMs = CAPTURE_TIMEOUT, budgetMs = 5000, track = new Set() } = {}) {
  const options = parse(argv), result = { ok: false, url: '', files: [], errors: [], ...(options.inspect ? { console: [], overflow: [] } : {}) };
  const out = options.out || env.COCKPIT_VISUAL_DIR || fs.mkdtempSync(path.join(tmpRoot, 'cockpit-visual-'));
  fs.mkdirSync(out, { recursive: true }); result.out = out;
  let server = null;
  try {
    if (options.url) { const u = new URL(options.url); if (!/^https?:$/.test(u.protocol)) throw new Error('--url : adresse http(s) attendue.'); result.url = u.origin; }
    else {
      const port = await freePort();
      server = launch(options.command[0], options.command.slice(1), { env: { ...env, PORT: String(port), HOST: '127.0.0.1' } }); track.add(server);
      result.url = 'http://127.0.0.1:' + port;
    }
    const targets = options.paths.map(p => { const u = new URL(p, result.url); if (u.origin !== result.url || !p.startsWith('/')) throw new Error('Chemin refusé : ' + p); return { path: p, url: u.href }; });
    // Attente du serveur : il répond (quel que soit le statut), ou il s'est arrêté, ou le délai est dépassé.
    const deadline = Date.now() + options.wait * 1000;
    for (;;) {
      if (await respond(targets[0].url)) break;
      if (server && server.exitCode !== null) throw new Error('Le serveur s’est arrêté (code ' + server.exitCode + ') : ' + server.output.trim().split('\n').slice(-5).join(' | '));
      if (Date.now() > deadline) throw new Error('Le serveur ne répond pas après ' + options.wait + ' s.');
      await new Promise(r => setTimeout(r, 300));
    }
    for (const target of targets) for (const view of VIEWPORTS) {
      const mb = memory();
      if (mb !== null && mb < minMb) throw new Error(`Mémoire disponible insuffisante (${mb} Mo < ${minMb} Mo) : captures abandonnées.`);
      const file = path.join(out, slug(target.path) + '-' + view.name + '.png'), profile = fs.mkdtempSync(path.join(tmpRoot, 'cockpit-chromium-'));
      const common = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
        '--user-data-dir=' + profile, '--window-size=' + view.width + ',' + view.height, ...(view.userAgent ? ['--user-agent=' + view.userAgent] : []), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];
      const args = options.inspect ? [...common, '--remote-debugging-port=0', 'about:blank'] : [...common, '--screenshot=' + file, '--virtual-time-budget=' + budgetMs, target.url];
      const browser = launch(chromium, args, { env }); track.add(browser);
      try {
        fs.rmSync(file, { force: true });
        const timer = new Promise(resolve => setTimeout(resolve, captureTimeoutMs, 'late'));
        if (options.inspect) {
          const done = await Promise.race([inspectPage({ browser, profile, view, target, file, steps: options.steps, result, settleMs: Math.min(budgetMs, 1500) }).catch(error => ({ failed: error.message })), browser.exited.then(e => ({ exited: e })), timer]);
          if (done === 'late') result.errors.push(`${target.path} ${view.name} : délai dépassé (${captureTimeoutMs / 1000} s).`);
          else if (done.failed) result.errors.push(`${target.path} ${view.name} : inspection impossible (${done.failed}).`);
          else if (done.exited?.error) throw new Error('Chromium introuvable (' + chromium + ') : indiquez son chemin dans COCKPIT_CHROMIUM.');
          else if (done.exited) result.errors.push(`${target.path} ${view.name} : Chromium s’est arrêté (${browser.output.trim().split('\n').at(-1) || 'code ' + done.exited.code}).`);
          continue;
        }
        const ended = await Promise.race([browser.exited, timer]);
        if (ended === 'late') { result.errors.push(`${target.path} ${view.name} : délai dépassé (${captureTimeoutMs / 1000} s).`); continue; }
        if (ended.error) throw new Error('Chromium introuvable (' + chromium + ') : indiquez son chemin dans COCKPIT_CHROMIUM.');
        const data = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (!data || !data.subarray(0, 4).equals(PNG)) { result.errors.push(`${target.path} ${view.name} : aucune capture (${browser.output.trim().split('\n').at(-1) || 'code ' + ended.code}).`); continue; }
        result.files.push({ path: target.path, viewport: view.name, width: view.width, height: view.height, file, bytes: data.length });
      } finally { await stopTree(browser, 1000); track.delete(browser); fs.rmSync(profile, { recursive: true, force: true }); }
    }
    result.ok = result.files.length === targets.length * VIEWPORTS.length * (1 + options.steps.length) && !result.errors.length;
  } catch (error) { result.errors.push(error.message); }
  finally { if (server) { await stopTree(server); track.delete(server); } }
  return result;
}

if (require.main === module) {
  const track = new Set();
  // Interrompu (délai de l'agent, Ctrl+C) : on n'abandonne ni serveur ni Chromium.
  const bail = () => { for (const child of track) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* arrêté */ } } } process.exit(130); };
  process.on('SIGINT', bail); process.on('SIGTERM', bail);
  main(process.argv.slice(2), { track }).then(result => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.ok ? 0 : 1; },
    error => { process.stdout.write(JSON.stringify({ ok: false, files: [], errors: [error.message] }) + '\n'); process.exitCode = 2; });
}
module.exports = { main, parse, memAvailableMb, VIEWPORTS };
