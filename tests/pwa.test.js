const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createServer } = require('../server');
const { decode, buildIcons, SIZES } = require('../scripts/pwa-icons');
const { buildTablet } = require('../scripts/export-tablet');
const pub = path.join(__dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.json'), 'utf8'));

test('the page declares an installable iPhone app: manifest, home screen icon and full-screen mode', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.json">/);
  assert.match(html, /<link rel="apple-touch-icon" href="brand\/apple-touch-icon.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Cockpit">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /viewport-fit=cover/);
  assert.ok(html.indexOf('pwa.css') > html.indexOf('themes.css'), 'les zones sûres passent après les thèmes');
});

test('the manifest opens index.html (Home Assistant refuses a bare folder) in standalone mode', () => {
  assert.equal(manifest.name, 'Cockpit');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, 'index.html');
  assert.equal(manifest.scope, './');
  for (const { src, sizes } of manifest.icons) {
    const image = decode(fs.readFileSync(path.join(pub, src)));
    assert.equal(`${image.width}x${image.height}`, sizes, src);
  }
});

test('home screen icons are square, opaque and in sync with the brand icon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-icons-'));
  try {
    for (const file of buildIcons(dir)) {
      const name = path.basename(file), committed = fs.readFileSync(path.join(pub, 'brand', name));
      assert.ok(committed.equals(fs.readFileSync(file)), name + ' : relancer node scripts/pwa-icons.js');
      const image = decode(committed);
      assert.equal(image.width, SIZES[name]); assert.equal(image.height, SIZES[name]);
      for (let i = 3; i < image.rgba.length; i += 4) assert.equal(image.rgba[i], 255);
      assert.deepEqual([...image.rgba.subarray(0, 3)], [10, 10, 10], 'coins remplis avec le fond de la marque');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('safe-area padding applies only to the home screen app', () => {
  const css = fs.readFileSync(path.join(pub, 'pwa.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.match(css, /^@media \(display-mode: standalone\) \{[\s\S]*\}$/);
  for (const inset of ['top', 'right', 'bottom', 'left']) assert.match(css, new RegExp('env\\(safe-area-inset-' + inset + '\\)'));
});

test('the local server and the tablet export both serve the manifest and icons', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const served = await fetch(origin + '/manifest.json');
  assert.equal(served.status, 200); assert.match(served.headers.get('content-type'), /json/);
  assert.deepEqual(await served.json(), manifest);
  const icon = await fetch(origin + '/brand/apple-touch-icon.png');
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png');

  const build = buildTablet({ keepRuntime: true });
  for (const file of ['manifest.json', 'pwa.css', 'phone.css', ...manifest.icons.map(i => i.src)]) assert.ok(build.files[file], file);
  const html = fs.readFileSync(path.join(build.target, 'index.html'), 'utf8');
  assert.match(html, new RegExp('pwa.css\\?v=' + build.version));
  assert.match(html, /href="manifest.json"/);
});

test('publishing from the OpenClaw server keeps the PC relay address instead of the server address', t => {
  const relay = require('../scripts/relay-runtime'), original = relay.writeRuntime;
  let calls = 0; relay.writeRuntime = () => { calls++; return {}; };
  t.after(() => { relay.writeRuntime = original; });
  buildTablet({ keepRuntime: true }); assert.equal(calls, 0);
  buildTablet(); assert.equal(calls, 1);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish-tablet.js'), 'utf8'), /buildTablet\(\{ keepRuntime: fromServer \}\)/);
});
