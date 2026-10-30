'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildTablet } = require('./export-tablet');
const project = path.resolve(__dirname, '..'), config = require('../deploy/config.json');
const sourceRepo = path.resolve(project, config.sourceRepository);
// --serveur : publication lancée depuis le serveur OpenClaw, qui héberge le dépôt de déploiement.
const fromServer = process.argv.includes('--serveur');
let lastGitStderr = '';
function git(args, cwd = sourceRepo, ssh = '') {
  const result = spawnSync('git', [...(ssh ? ['-c', 'core.sshCommand=' + ssh] : []), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  lastGitStderr = result.stderr || '';
  if (result.error) throw result.error;
  if (result.status) throw Object.assign(new Error('La commande Git a échoué.'), { stderr: lastGitStderr });
  return (result.stdout || '').trim();
}
function optional(args) { try { return git(args); } catch { return ''; } }
async function digest(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' : ' + url);
  return crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}
async function main() {
  if (!/^[a-z0-9-]+$/.test(config.subdirectory) || !/^[a-zA-Z0-9/_-]+$/.test(config.branch)) throw new Error('Configuration de déploiement invalide.');
  const remote = git(['remote', 'get-url', 'origin']), ssh = optional(['config', '--get', 'core.sshCommand']);
  const originalHead = git(['rev-parse', 'HEAD']), originalClean = !git(['status', '--porcelain']), originalBranch = git(['branch', '--show-current']);
  const build = buildTablet({ keepRuntime: fromServer });
  for (const file of Object.keys(build.files).filter(f => f.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(build.target, file)], { windowsHide: true, stdio: 'pipe' });
  console.log(`Publication de Cockpit ${build.version}. L’ancien dashboard garde son adresse.`);
  const deployRoot = path.join(project, '.deploy'); fs.mkdirSync(deployRoot, { recursive: true });
  if (fs.realpathSync(deployRoot) !== path.join(fs.realpathSync(project), '.deploy')) throw new Error('Le dossier de publication sort du projet.');
  const checkout = path.join(deployRoot, 'publish-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
  git(['clone', '--single-branch', '--branch', config.branch, remote, checkout], project, ssh);
  const baseCommit = git(['rev-parse', 'HEAD'], checkout), site = path.join(checkout, config.subdirectory);
  if (fs.existsSync(site)) {
    if (path.dirname(site) !== checkout || fs.realpathSync(checkout) !== checkout || fs.lstatSync(site).isSymbolicLink()) throw new Error('Dossier de publication inattendu.');
    fs.rmSync(site, { recursive: true });
  }
  fs.cpSync(build.target, site, { recursive: true });
  const script = path.join(checkout, 'deploy', 'deploy.sh');
  let deployment = fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
  const marker = '# MetaBoard: a separate URL, existing HomeDashboard files unchanged.';
  const block = `${marker}\nif [[ -d ${config.subdirectory} ]]; then FILES+=(${config.subdirectory}); fi`;
  deployment = deployment.replace('\n\n' + block, '').replace(block + '\n', '');
  const changeDirectory = 'cd "$(dirname "$0")/.."';
  if (!/^FILES=\([^\n]+\)$/m.test(deployment) || !deployment.includes(changeDirectory)) throw new Error('Le script de publication existant a changé. Aucun push effectué.');
  deployment = deployment.replace(changeDirectory, changeDirectory + '\n\n' + block);
  // QEMU guest-agent stdin is capped at 1 MiB; compress both dashboards in transit.
  deployment = deployment.replace('tar -C "$STAGE" -cf "$STAGE.tar"', 'tar -C "$STAGE" -czf "$STAGE.tar.gz"')
    .replace('base64 -w0 "$STAGE.tar" > "$STAGE.b64"; rm -f "$STAGE.tar"', 'base64 -w0 "$STAGE.tar.gz" > "$STAGE.b64"; rm -f "$STAGE.tar.gz"')
    .replace('base64 -d | tar -xf - -C $DEST.new', 'base64 -d | tar -xzf - -C $DEST.new');
  fs.writeFileSync(script, deployment);
  const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (fs.existsSync(bash)) execFileSync(bash, ['-n', script.replaceAll('\\', '/')], { windowsHide: true, stdio: 'pipe' });
  git(['add', '--', config.subdirectory, 'deploy/deploy.sh'], checkout);
  if (!git(['diff', '--cached', '--name-only'], checkout)) { console.log('Cette version est déjà publiée.'); return; }
  const changed = git(['diff', '--cached', '--name-only'], checkout).split('\n');
  if (changed.some(f => f !== 'deploy/deploy.sh' && !f.startsWith(config.subdirectory + '/'))) throw new Error('La publication contient des changements inattendus. Aucun push effectué.');
  const user = optional(['config', 'user.name']) || 'GGZ', email = optional(['config', 'user.email']) || 'ggz@local';
  git(['-c', 'user.name=' + user, '-c', 'user.email=' + email, 'commit', '-m', 'Publie Cockpit à une URL tablette distincte'], checkout);
  const revision = git(['rev-parse', 'HEAD'], checkout);
  console.log('Envoi au circuit de déploiement Cockpit…');
  const output = git(['push', 'origin', 'HEAD:refs/heads/' + config.branch], checkout, ssh);
  if (output) console.log(output);
  if (lastGitStderr) console.log(lastGitStderr);
  fs.writeFileSync(path.join(deployRoot, 'latest.json'), JSON.stringify({ version: build.version, revision, baseCommit, url: config.url, checkout, publishedAt: new Date().toISOString(), verified: false }, null, 2));
  // Keep the existing one-click Cockpit publisher usable. Never touch an edited checkout.
  if (originalClean && originalBranch === config.branch && originalHead === baseCommit && !git(['status', '--porcelain']) && git(['rev-parse', 'HEAD']) === originalHead) {
    try { git(['fetch', 'origin', config.branch], sourceRepo, ssh); git(['merge', '--ff-only', 'origin/' + config.branch]); console.log('Le circuit de publication existant est synchronisé.'); }
    catch { console.log('Publication envoyée. Le dossier Cockpit local devra être synchronisé avant son prochain push.'); }
  }
  console.log('Vérification de la version servie à la tablette…');
  const entries = Object.entries(build.files), failed = [];
  for (let offset = 0; offset < entries.length; offset += 4) await Promise.all(entries.slice(offset, offset + 4).map(async ([file, expected]) => {
    try { const url = new URL(file, config.url); url.searchParams.set('v', build.version); if (await digest(url) !== expected) failed.push(file); }
    catch { failed.push(file); }
  }));
  if (failed.length) throw new Error('Le push a été effectué, mais la vérification HTTP a échoué pour : ' + failed.join(', ') + '. La dernière publication est décrite dans .deploy/latest.json.');
  fs.writeFileSync(path.join(deployRoot, 'latest.json'), JSON.stringify({ version: build.version, revision, baseCommit, url: config.url, checkout, publishedAt: new Date().toISOString(), verified: true }, null, 2));
  console.log('Tablette publiée et vérifiée : ' + config.url + 'index.html');
  console.log('Ancien dashboard : ' + new URL('../index.html', config.url).href);
}
if (require.main === module) main().catch(error => { console.error(error.stderr?.toString() || error.message); process.exitCode = 1; });
module.exports = { main };
