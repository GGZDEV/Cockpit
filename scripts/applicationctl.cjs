#!/usr/bin/env node
'use strict';
// Local operator CLI. Credentials stay in memory, never in argv/output/recipes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDeployerClient } = require('../deployer-client.cjs');
const deployment = require('../project-deploy.cjs');
const CONFIG = path.join(os.homedir(), '.config/cockpit');
function recipe(id, manifest, previous = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error('Identifiant invalide.');
  const relative = manifest.recipe || 'deploy/application.json';
  if (!/^[\w./-]+\.json$/.test(relative) || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Chemin de recette relatif invalide.');
  const cmd = `/usr/local/bin/application-deploy ${id} . ${relative} "$DEPLOY_COMMIT"`;
  return { ...previous, repo: previous.repo || manifest.repository, branch: previous.branch || 'main', auto: previous.auto ?? false,
    type: 'custom', public_url: previous.public_url || manifest.url, build_cmd: '', test_cmd: '',
    deploy: { deploy_cmd: cmd, rollback_cmd: cmd },
    health: { url: manifest.healthUrl, expect_status: 200, expect_contains: manifest.expect || '', retries: 8, retry_delay_s: 3 },
    ...(manifest.domain && manifest.upstream ? { subdomain: { name: manifest.domain, upstream: manifest.upstream } } : {}) };
}
async function main(args) {
  const [command, id, file] = args;
  if (!command || command === 'help' || command === '--help') {
    console.log(`applicationctl (local, sans secret en argument)
state                                  projets et modes de publication
configure <id-projet-Cockpit> <recette>  prépare une recette Compose sans lancer de publication ; conserve auto/branche
register-app <slug-Deployer> <recette>   enregistre un compagnon ; conserve auto/branche existants
deploy <id-projet-Cockpit>              lance Deployer, uniquement si la demande autorise la publication
deploy-app <slug-Deployer>              idem pour un compagnon
status <slug-Deployer>                  dernières publications et santé
domain <slug-Deployer> <nom-exact>      publie le domaine explicitement demandé (DNS/proxy)
Recette : JSON avec compose, healthUrl, expect facultatif. Compagnon : ajouter repository, url, recipe (chemin dans dépôt), domain/upstream facultatifs.
Documentation : docs/APPLICATIONS.md. Ne jamais remplacer la validation utilisateur par un déploiement direct Docker.`);
    return;
  }
  const client = createDeployerClient({ token: fs.readFileSync(path.join(CONFIG, 'deployer-token'), 'utf8').trim() });
  async function api(route, method = 'GET', body) {
    const password = fs.readFileSync(path.join(CONFIG, 'web-password'), 'utf8').trim();
    const response = await fetch('http://192.168.1.236:3888/api/projects/' + route, {
      method, signal: AbortSignal.timeout(20000), headers: { Host: 'cockpit.ggz.ovh', Authorization: 'Basic ' + Buffer.from('cockpit:' + password).toString('base64'), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  if (command === 'state') {
    const data = await api('state');
    console.log(JSON.stringify(data.projects.map(p => ({ id: p.id, name: p.name, workspace: p.workspace?.path, deployment: p.deployment, deployState: p.deployState })), null, 2)); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await client.deployments(id), null, 2)); return; }
  if (command === 'deploy') { const data = await api(`projects/${encodeURIComponent(id)}/deploy`, 'POST', {}); console.log(JSON.stringify({ state: data.project?.deployState, warnings: data.warnings }, null, 2)); return; }
  if (command === 'deploy-app') { console.log(JSON.stringify(await client.deploy(id))); return; }
  if (command === 'domain') {
    const sub = await client.getSubdomain(id);
    if (!sub || sub.name !== file) throw new Error('Le nom exact ne correspond pas au domaine enregistré.');
    if (sub.status === 'awaiting_validation') await client.approveSubdomain(id);
    console.log(JSON.stringify(await client.getSubdomain(id))); return;
  }
  if (!['configure', 'register-app'].includes(command) || !id || !file) throw new Error('Commande inconnue : utiliser help.');
  const stat = fs.statSync(file); if (stat.size > 65536) throw new Error('Recette trop volumineuse.');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!manifest.compose || !/^http:\/\/(127\.0\.0\.1|192\.168\.1\.236):\d{2,5}\//.test(manifest.healthUrl || '')) throw new Error('compose et healthUrl local sont obligatoires.');
  if (command === 'register-app') {
    const previous = await client.getProject(id);
    // Existing settings are read through the raw API only internally; no credentials leave this process.
    const old = previous ? { repo: previous.repo, branch: previous.branch, auto: manifest.auto === true } : {};
    if (previous && manifest.auto !== undefined) throw new Error('Ne pas modifier le mode automatique d’un compagnon existant depuis une recette.');
    // GET recipe deliberately omits auto; obtain it without exposing the token.
    if (previous) {
      const token = fs.readFileSync(path.join(CONFIG, 'deployer-token'), 'utf8').trim();
      const response = await fetch('http://192.168.1.236:8080/projects/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('Lecture du mode de publication impossible.');
      const current = await response.json(); old.auto = current.auto; old.public_url = current.public_url;
    }
    console.log(JSON.stringify(await client.putProject(id, recipe(id, manifest, old)))); return;
  }
  const data = await api('state'), project = data.projects.find(p => p.id === id);
  if (!project) throw new Error('Projet Cockpit introuvable (utiliser state).');
  const d = deployment.settingsOf(project), slug = project.deployState?.slug;
  if (!slug) throw new Error('Renseigner l’URL du projet dans Cockpit avant de préparer sa recette.');
  const payload = recipe(slug, manifest, { repo: project.context.repository.replace('https://github.com/', '').replace(/\.git$/, ''), branch: d.branch, auto: d.auto, public_url: d.url });
  await api('projects/' + id, 'PATCH', { deployment: { ...d, type: 'custom', config: payload.deploy, health: payload.health } });
  console.log(JSON.stringify(await client.putProject(slug, payload)));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error('Applications : ' + error.message); process.exitCode = 1; });
module.exports = { recipe, main };
