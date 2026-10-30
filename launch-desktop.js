'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
let executable;
for (const root of [__dirname, path.join(__dirname, '..', 'FeedMe')]) {
  try { executable = require(require.resolve('electron', { paths: [root] })); break; } catch { /* Try the existing sibling installation. */ }
}
if (!executable) {
  console.error('Electron est introuvable. Lancez npm start pour la version web, ou installez Electron avec npm install --no-save electron.');
  process.exitCode = 1;
} else {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  require('./scripts/start-service').ensureService().then(() => {
    const child = spawn(executable, [path.join(__dirname, 'desktop.cjs')], { cwd: __dirname, stdio: 'inherit', windowsHide: true, env });
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
  }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
