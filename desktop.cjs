const { app, BrowserWindow, shell } = require('electron');
const { createServer } = require('./server');
const path = require('node:path');
let ownedServer, win;
const origin = 'http://127.0.0.1:' + Number(process.env.PORT || 3888);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    let existing = false;
    try { const r = await fetch(origin + '/api/status', { signal: AbortSignal.timeout(2500), redirect: 'error' }); existing = r.ok && (await r.json()).app === 'metaboard'; } catch { /* Start our own local service. */ }
    if (!existing) {
      ownedServer = createServer();
      await new Promise((resolve, reject) => { ownedServer.once('error', reject); ownedServer.listen(Number(process.env.PORT || 3888), '127.0.0.1', resolve); });
    }
    win = new BrowserWindow({ width: 1510, height: 1000, minWidth: 390, minHeight: 640, title: 'Cockpit', icon: path.join(__dirname, 'public', 'brand', 'icon.png'), backgroundColor: '#0c0c0d', autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload:path.join(__dirname,'desktop-preload.cjs') } });
    win.webContents.setWindowOpenHandler(({ url }) => { try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {} return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) e.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    require('./desktop-features.cjs')({app,win,origin});
    await win.loadURL(origin);
  }).catch(err => { console.error(err.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => ownedServer?.close());
}
