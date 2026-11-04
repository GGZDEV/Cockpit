'use strict';
// Création d'un dépôt GitHub pour un projet NOUVEAU. Cockpit n'a aucun identifiant GitHub à lui : le clonage et les pushs passent par
// les accès Git déjà enregistrés sur ce PC. La création d'un dépôt passe par le GitHub CLI (`gh`), connecté sur ce PC ; à défaut de
// connexion, `gh` lit le jeton COCKPIT_GITHUB_TOKEN de la configuration du serveur (transmis à `gh` seul, jamais affiché ni stocké).
// Aucune commande n'est lancée dans un shell : arguments en tableau, noms validés avant l'appel.
const { execFile } = require('node:child_process');
const { childEnv, redact } = require('./direct-harness.cjs');

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

function defaultRun(args, { env }) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) { error.stderr = String(stderr || ''); return reject(error); }
      resolve(String(stdout || '') + String(stderr || ''));
    });
  });
}
const lastLine = error => redact(String(error.stderr || error.message || '').split('\n').map(l => l.trim()).filter(Boolean).at(-1) || '').slice(0, 300);

function createGithub({ run = defaultRun, env = process.env, cacheMs = 30000 } = {}) {
  const token = String(env.COCKPIT_GITHUB_TOKEN || '').trim();
  const childEnvironment = () => childEnv(env, { set: token ? { GH_TOKEN: token } : {} });
  let cached = null;

  async function status({ fresh = false } = {}) {
    if (!fresh && cached && Date.now() - cached.at < cacheMs) return cached.value;
    const value = await probe(); cached = { at: Date.now(), value }; return value;
  }
  async function probe() {
    const e = childEnvironment();
    let auth;
    try { auth = await run(['auth', 'status'], { env: e }); }
    catch (error) {
      if (error.code === 'ENOENT') return { available: false, reason: 'Le GitHub CLI (gh) n’est pas installé sur ce PC. Installez-le puis lancez « gh auth login », ou définissez COCKPIT_GITHUB_TOKEN dans la configuration de Cockpit.' };
      return { available: false, reason: 'Le GitHub CLI n’est pas connecté à GitHub. Lancez « gh auth login » sur ce PC, ou définissez COCKPIT_GITHUB_TOKEN dans la configuration de Cockpit.' };
    }
    // Un jeton classique indique ses droits ; sans droit « repo », la création d'un dépôt échouerait.
    const scopes = /Token scopes:\s*(.+)/i.exec(auth)?.[1];
    if (scopes && !/\brepo\b/.test(scopes)) return { available: false, reason: 'Le jeton GitHub n’a pas le droit « repo » : il ne peut pas créer de dépôt. Reconnectez-vous avec « gh auth refresh -s repo ».' };
    let account = '';
    try { account = (await run(['api', 'user', '--jq', '.login'], { env: e })).trim().split('\n')[0]; } catch { /* le compte reste inconnu : la création dira s'il manque un droit */ }
    return { available: true, account: OWNER.test(account) ? account : '' };
  }

  // Crée le dépôt (vide). Renvoie ses adresses ; ne clone rien et ne pousse rien.
  async function createRepo({ owner, name, isPrivate = true }) {
    if (!OWNER.test(String(owner || ''))) throw Object.assign(new Error('Compte GitHub non valide.'), { status: 400 });
    if (!NAME.test(String(name || '')) || /\.git$/i.test(name)) throw Object.assign(new Error('Nom de dépôt non valide (lettres, chiffres, « . _ - », 100 caractères au plus).'), { status: 400 });
    const state = await status();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    try { await run(['repo', 'create', owner + '/' + name, isPrivate ? '--private' : '--public'], { env: childEnvironment() }); }
    catch (error) {
      const why = lastLine(error);
      throw Object.assign(new Error(/already exists|name already/i.test(why) ? `Le dépôt ${owner}/${name} existe déjà sur GitHub : rien n’a été créé. Choisissez un autre nom, ou créez le projet « à partir d’un dépôt existant ».`
        : 'GitHub a refusé la création du dépôt : ' + (why || 'erreur inconnue') + '.'), { status: 409 });
    }
    return { owner, name, web: `https://github.com/${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` };
  }
  return { status, createRepo };
}

module.exports = { createGithub, OWNER, NAME };
