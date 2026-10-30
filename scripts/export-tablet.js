'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const project = path.resolve(__dirname, '..'), source = path.join(project, 'public');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]).sort(); }
function buildTablet() {
  require('./relay-runtime').writeRuntime();
  const files = walk(source), hash = crypto.createHash('sha256');
  for (const file of files) { hash.update(path.relative(source, file).replaceAll('\\', '/')); hash.update(fs.readFileSync(file)); }
  const version = hash.digest('hex').slice(0, 12), target = path.join(project, 'dist', 'tablet');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realProject = fs.realpathSync(project), realParent = fs.realpathSync(path.dirname(target));
  if (realParent !== path.join(realProject, 'dist') || (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.realpathSync(target).startsWith(realProject + path.sep)))) throw new Error('Le dossier d’export sort du projet.');
  // Only this checked, generated export directory is replaced.
  fs.rmSync(target, { recursive: true, force: true }); fs.mkdirSync(target);
  for (const file of files) {
    const dest = path.join(target, path.relative(source, file)); fs.mkdirSync(path.dirname(dest), { recursive: true });
    let content = fs.readFileSync(file);
    if (/\.(js|css|html|svg|json)$/.test(file)) content = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'));
    if (file.endsWith('.js')) content = Buffer.from(content.toString('utf8').replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"\n]+\.js)(['"])/g, `$1$2?v=${version}$3`));
    if (file.endsWith('.html')) {
      let html = content.toString('utf8').replace(/((?:src|href)=["'])(?!https?:|#|data:)([^"']+\.(?:js|css|svg))(["'])/g, `$1$2?v=${version}$3`);
      html = html.replace('</head>', `<script>window.MB_ASSET_VERSION=${JSON.stringify(version)};</script>\n</head>`);
      content = Buffer.from(html);
    }
    fs.writeFileSync(dest, content);
  }
  fs.writeFileSync(path.join(target, 'version.json'), JSON.stringify({ version }));
  const manifest = Object.fromEntries(walk(target).map(file => [path.relative(target, file).replaceAll('\\', '/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  return { target, version, files: manifest };
}
if (require.main === module) { const result = buildTablet(); console.log(`Version tablette ${result.version} préparée : ${result.target}`); }
module.exports = { buildTablet };
