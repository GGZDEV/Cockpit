const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { main, parse, memAvailableMb } = require('../scripts/visual-check.cjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
function bench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-visual-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tmpRoot = path.join(dir, 'tmp'), out = path.join(dir, 'out'), pids = path.join(dir, 'pids'); fs.mkdirSync(tmpRoot); fs.mkdirSync(pids);
  // Faux Chromium : note ses arguments, vérifie son profil, écrit un PNG (ou se bloque en mode « hang »).
  const chromium = path.join(dir, 'fake-chromium.js');
  fs.writeFileSync(chromium, `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);fs.writeFileSync(path.join(${JSON.stringify(pids)},'chromium-'+process.pid),JSON.stringify(a));
const get=k=>(a.find(x=>x.startsWith(k+'='))||'').slice(k.length+1);if(!fs.existsSync(get('--user-data-dir')))process.exit(4);
if(process.env.FAKE_CHROMIUM==='hang'){setInterval(()=>{},1000);}else{fs.writeFileSync(get('--screenshot'),Buffer.from(${JSON.stringify(PNG.toString('hex'))},'hex'));}`);
  // Petit serveur de projet : écoute sur PORT, note son pid, lance un enfant (doit être arrêté avec lui).
  const server = path.join(dir, 'server.js');
  fs.writeFileSync(server, `const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');fs.writeFileSync(path.join(${JSON.stringify(pids)},'server-'+process.pid),process.env.HOST||'');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(${JSON.stringify(pids)},'child-'+child.pid),'');
http.createServer((q,s)=>s.end('<h1>ok</h1>')).listen(Number(process.env.PORT),'127.0.0.1');`);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const spawned = prefix => fs.readdirSync(pids).filter(f => f.startsWith(prefix + '-')).map(f => Number(f.split('-')[1]));
  const settle = async () => { for (let i = 0; i < 50 && [...spawned('server'), ...spawned('child'), ...spawned('chromium')].some(alive); i++) await new Promise(r => setTimeout(r, 50)); };
  return { dir, tmpRoot, out, chromium, server, pids, alive, spawned, settle };
}

test('starts the project server on a free port, captures mobile then desktop, and cleans everything up', async t => {
  const b = bench(t);
  const result = await main(['--path', '/', '--path', '/projets', '--out', b.out, '--', process.execPath, b.server], { env: { ...process.env, FAKE_CHROMIUM: '' }, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => 2000 });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual(result.files.map(f => [f.path, f.viewport, path.basename(f.file)]), [['/', 'mobile', 'accueil-mobile.png'], ['/', 'bureau', 'accueil-bureau.png'], ['/projets', 'mobile', 'projets-mobile.png'], ['/projets', 'bureau', 'projets-bureau.png']]);
  for (const f of result.files) assert.ok(fs.readFileSync(f.file).subarray(0, 4).equals(PNG.subarray(0, 4)));
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const calls = b.spawned('chromium').map(pid => JSON.parse(fs.readFileSync(path.join(b.pids, 'chromium-' + pid), 'utf8')));
  assert.equal(calls.length, 4);
  const mobile = calls.find(a => a.includes('--window-size=390,844')), desktop = calls.find(a => a.includes('--window-size=1440,900'));
  for (const flag of ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--hide-scrollbars']) assert.ok(mobile.includes(flag), flag);
  assert.ok(mobile.some(a => /^--user-agent=.*iPhone/.test(a))); assert.ok(!desktop.some(a => a.startsWith('--user-agent=')));
  assert.ok(mobile.some(a => a.startsWith('--virtual-time-budget='))); assert.equal(mobile.at(-1), result.url + '/');
  assert.equal(fs.readFileSync(path.join(b.pids, 'server-' + b.spawned('server')[0]), 'utf8'), '127.0.0.1');
  await b.settle();
  for (const pid of [...b.spawned('server'), ...b.spawned('child'), ...b.spawned('chromium')]) assert.equal(b.alive(pid), false, 'processus ' + pid + ' arrêté');
  assert.deepEqual(fs.readdirSync(b.tmpRoot), [], 'profils temporaires supprimés');
});

test('a hanging browser or low memory never leaves the server or a profile behind', async t => {
  const b = bench(t);
  const hung = await main(['--out', b.out, '--', process.execPath, b.server], { env: { ...process.env, FAKE_CHROMIUM: 'hang' }, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => 2000, captureTimeoutMs: 400 });
  assert.equal(hung.ok, false); assert.equal(hung.files.length, 0); assert.match(hung.errors.join(' '), /délai dépassé/);
  const low = await main(['--out', b.out, '--', process.execPath, b.server], { env: process.env, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => 120 });
  assert.equal(low.ok, false); assert.match(low.errors[0], /Mémoire disponible insuffisante \(120 Mo < 350 Mo\)/);
  const dead = await main(['--wait', '2', '--out', b.out, '--', process.execPath, '-e', 'process.exit(3)'], { env: process.env, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => 2000 });
  assert.match(dead.errors[0], /Le serveur s’est arrêté \(code 3\)/);
  await b.settle();
  for (const pid of [...b.spawned('server'), ...b.spawned('child'), ...b.spawned('chromium')]) assert.equal(b.alive(pid), false, 'processus ' + pid + ' arrêté');
  assert.deepEqual(fs.readdirSync(b.tmpRoot), []);
});

test('an already running server can be used with --url; paths stay on that server', async t => {
  const b = bench(t);
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const result = await main(['--url', url, '--path', '/a b', '--out', b.out], { env: process.env, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => null });
  assert.equal(result.ok, true, result.errors.join(' | ')); assert.equal(result.files.length, 2);
  const outside = await main(['--url', url, '--path', '//evil.example/', '--out', b.out], { env: process.env, chromium: b.chromium, tmpRoot: b.tmpRoot, memory: () => 2000 });
  assert.match(outside.errors[0], /Chemin refusé/);
  const missing = await main(['--url', url, '--out', b.out], { env: process.env, chromium: path.join(b.dir, 'absent'), tmpRoot: b.tmpRoot, memory: () => 2000 });
  assert.match(missing.errors.join(' '), /Chromium introuvable/);
  assert.throws(() => parse([]), /commande du serveur/); assert.throws(() => parse(['--bad']), /Option inconnue/);
  const meminfo = path.join(b.dir, 'meminfo'); fs.writeFileSync(meminfo, 'MemTotal: 4000000 kB\nMemAvailable:     512000 kB\n');
  assert.equal(memAvailableMb(meminfo), 500); assert.equal(memAvailableMb(path.join(b.dir, 'none')), null);
});

// Cockpit : dossier de captures propre à l'exécution, PNG joints à la tâche puis dossier supprimé, outil décrit dans le brief.
test('captures made during a Claude run are attached to the task and their folder removed', async t => {
  const { setup } = require('./helpers/direct-setup');
  const claude = require('../claude-direct.cjs');
  const { project, create, launch, lastDone, calls, mode } = await setup(t);
  const p = await project('alpha'), x = await create(p.id);
  mode('visual'); await launch(x.id);
  const done = await lastDone(x.id);
  assert.deepEqual(done.attachments.map(a => a.name).sort(), ['capture-accueil-bureau.png', 'capture-accueil-mobile.png'], 'les PNG seulement');
  assert.ok(done.attachments.every(a => a.type === 'image/png' && a.by === 'Claude Code'));
  assert.ok(done.runs[0].events.some(e => e.text === '2 captures jointes à la tâche'));
  assert.ok(done.attachments.every(a => done.direct.sent.includes(a.id)), 'déjà connues de la session : pas relistées au message suivant');
  const input = calls()[0].input;
  assert.ok(!input.includes('node ' + claude.VISUAL_CHECK), 'aucune procédure de capture imposée dans le prompt');
  assert.equal(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('cockpit-visual-') && fs.existsSync(path.join(os.tmpdir(), f, 'accueil-mobile.png'))).length, 0, 'dossier de captures supprimé');
});

test('inspection options: steps in order imply --inspect, malformed steps refused', () => {
  const o = parse(['--click', '#menu', '--type=#q=a=b', '--eval', 'scrollTo(0, 400)', '--url', 'http://127.0.0.1:1']);
  assert.equal(o.inspect, true);
  assert.deepEqual(o.steps, [{ click: '#menu' }, { type: '#q', text: 'a=b' }, { eval: 'scrollTo(0, 400)' }]);
  assert.equal(parse(['--inspect', '--url', 'http://127.0.0.1:1']).inspect, true); assert.equal(parse(['--url', 'http://127.0.0.1:1']).inspect, false);
  assert.throws(() => parse(['--type', '#q', '--url', 'http://x']), /sélecteur=texte/);
  assert.throws(() => parse(['--url', 'http://x', '--click']), /valeur attendue/);
  assert.throws(() => parse(['--url', 'http://x', ...Array(11).fill(['--click', 'a']).flat()]), /10 étapes/);
});

// Vrai Chromium (ignoré s'il est absent) : erreurs de console et JavaScript, débordement, étapes rejouées avec une capture chacune.
const chromium = process.env.COCKPIT_CHROMIUM || '/usr/bin/chromium';
test('--inspect reports console errors and horizontal overflow, replays steps and captures after each', { skip: !fs.existsSync(chromium) && 'Chromium absent' }, async t => {
  const b = bench(t);
  const page = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="margin:0">
<div id=large class="bloc rouge" style="width:600px;height:20px;background:red"></div><button id=b onclick="this.textContent='ok';document.title='cliqué'">Bouton</button><input id=q oninput="document.title='saisi:'+this.value">
<script>console.error('boum console'); setTimeout(() => { throw new Error('boum js'); }, 10);</script>`;
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const result = await main(['--url', url, '--click', '#b', '--type', '#q=salut', '--eval', 'if (document.title !== "saisi:salut") throw new Error("titre " + document.title)', '--click', '#absent', '--out', b.out],
    { env: process.env, chromium, tmpRoot: b.tmpRoot, memory: () => null, budgetMs: 300 });
  assert.equal(result.files.length, 10, result.errors.join(' | '));
  assert.deepEqual(result.files.filter(f => f.viewport === 'mobile').map(f => path.basename(f.file)), ['accueil-mobile.png', 'accueil-mobile-etape1.png', 'accueil-mobile-etape2.png', 'accueil-mobile-etape3.png', 'accueil-mobile-etape4.png']);
  assert.equal(result.files[1].step, '1 · clic #b');
  for (const f of result.files) assert.ok(fs.readFileSync(f.file).subarray(0, 4).equals(PNG.subarray(0, 4)));
  assert.equal(result.ok, false, 'a failed step fails the check');
  assert.deepEqual(result.errors, ['/ mobile · étape 4 (clic #absent) : élément introuvable : #absent', '/ bureau · étape 4 (clic #absent) : élément introuvable : #absent'], 'the eval step saw the typed text');
  for (const view of ['mobile', 'bureau']) {
    assert.ok(result.console.includes(`/ ${view} : console.error boum console`), view);
    assert.ok(result.console.some(l => l.startsWith(`/ ${view} : `) && /boum js/.test(l)), view);
  }
  assert.deepEqual(result.overflow, [{ path: '/', viewport: 'mobile', extraPx: 210, elements: ['div#large.bloc.rouge'] }], 'mobile only, noted once while unchanged');
  await b.settle();
  assert.deepEqual(fs.readdirSync(b.tmpRoot), [], 'profils temporaires supprimés');
});
