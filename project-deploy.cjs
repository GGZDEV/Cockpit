'use strict';
// Déploiement d'un projet : réglages (project.deployment), validation des entrées et corps envoyé au service de déploiement.
// Rétrocompatible : un projet sans `deployment` se lit avec les valeurs par défaut ci-dessous, sans rien écrire ni migrer.
// Rien ici n'exécute de commande : ce sont des données validées, transmises telles quelles au service (qui les exécute chez lui).
const { githubRepo } = require('./workspace.cjs');

class InputError extends Error { constructor(message) { super(message); this.status = 400; } }

const TYPES = {
  'ha-static': { label: 'Site statique dans Home Assistant', fields: [
    { key: 'src_dir', label: 'Dossier à publier (dans le dépôt)', kind: 'path', required: true, def: 'dist' },
    { key: 'ha_subdir', label: 'Sous-dossier dans Home Assistant', kind: 'path', required: true, help: 'ex. maison/mon-site → /local/maison/mon-site/' }] },
  'static-ssh': { label: 'Site statique sur un serveur (SSH)', fields: [
    { key: 'host', label: 'Serveur', kind: 'host', required: true }, { key: 'user', label: 'Utilisateur', kind: 'user', required: true },
    { key: 'src_dir', label: 'Dossier à publier (dans le dépôt)', kind: 'path', required: true, def: 'dist' }, { key: 'dest_dir', label: 'Dossier sur le serveur', kind: 'abs', required: true }] },
  'systemd-ct': { label: 'Application sur un conteneur (service systemd)', fields: [
    { key: 'host', label: 'Serveur', kind: 'host', required: true }, { key: 'user', label: 'Utilisateur', kind: 'user', required: true },
    { key: 'dest_dir', label: 'Dossier sur le serveur', kind: 'abs', required: true }, { key: 'service', label: 'Nom du service', kind: 'service', required: true },
    { key: 'src_dir', label: 'Dossier à copier (dans le dépôt)', kind: 'path', required: true, def: '.' }] },
  custom: { label: 'Cas particulier (commandes)', fields: [
    { key: 'deploy_cmd', label: 'Commande de déploiement', kind: 'cmd', required: true }, { key: 'rollback_cmd', label: 'Commande de retour arrière', kind: 'cmd', required: false }] },
};
const PATTERN = {
  path: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.\/-]{1,200}$/, abs: /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.\/-]{1,200}$/,
  host: /^[A-Za-z0-9]([A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/, user: /^[a-z_][a-z0-9_-]{0,31}$/, service: /^[\w@.:-]{1,100}$/,
};
const NO_CONTROL = /[\u0000-\u001f\u007f]/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const PUBLIC_SUFFIX = () => String(process.env.COCKPIT_PUBLIC_DOMAIN_SUFFIX || '.ggz.ovh').toLowerCase();
const DOMAIN = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const DEFAULTS = Object.freeze({ url: '', auto: false, branch: 'main', type: '', config: {}, buildCmd: '', testCmd: '', publicDomain: '', publicUpstream: '' });
const settingsOf = project => ({ ...DEFAULTS, ...(project?.deployment || {}), config: { ...(project?.deployment?.config || {}) } });
const stateOf = project => project?.deployState || {};

function cleanUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { throw new InputError('L’URL de déploiement n’est pas une adresse valide : elle doit commencer par https://'); }
  if (u.protocol !== 'https:') throw new InputError('L’URL de déploiement doit commencer par https://');
  if (u.username || u.password) throw new InputError('L’URL de déploiement ne doit contenir ni identifiant ni mot de passe.');
  if (raw.length > 300 || /\s/.test(raw) || !/^[a-z0-9.-]+$/i.test(u.hostname)) throw new InputError('L’URL de déploiement est trop longue ou contient des caractères non permis.');
  u.hash = '';
  return u.pathname === '/' && !u.search ? u.href.replace(/\/$/, '') : u.href;
}
function cleanCommand(value, label) {
  const raw = String(value ?? '').trim();
  if (NO_CONTROL.test(raw) || raw.length > 300) throw new InputError(`${label} : une seule ligne de 300 caractères au plus.`);
  return raw;
}
function cleanConfig(type, value, previous = {}) {
  if (!type) return {};
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}, out = {};
  for (const f of TYPES[type].fields) {
    const raw = f.key in input ? String(input[f.key] ?? '').trim() : previous[f.key] ?? '';
    if (!raw) continue;
    if (f.kind === 'cmd') { if (NO_CONTROL.test(raw) || raw.length > 300) throw new InputError(`${f.label} : une seule ligne de 300 caractères au plus.`); }
    else if (!PATTERN[f.kind].test(raw)) throw new InputError(`${f.label} : valeur non valide (lettres, chiffres, « . _ - / » seulement${f.kind === 'path' ? ', chemin relatif sans « .. »' : f.kind === 'abs' ? ', chemin absolu sans « .. »' : ''}).`);
    out[f.key] = raw;
  }
  return out;
}

// Applique les champs reçus sur les réglages précédents (mise à jour partielle) et valide chacun.
function cleanSettings(body, previous) {
  const out = settingsOf({ deployment: previous });
  if ('url' in body) out.url = cleanUrl(body.url);
  if ('auto' in body) out.auto = body.auto === true;
  if ('branch' in body) {
    const b = String(body.branch ?? '').trim() || 'main';
    if (!BRANCH.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) throw new InputError('Branche de production non valide (lettres, chiffres, « . _ - / »).');
    out.branch = b;
  }
  if ('type' in body) {
    const type = String(body.type ?? '').trim();
    if (type && !TYPES[type]) throw new InputError('Type de déploiement inconnu. Types : ' + Object.keys(TYPES).join(', ') + '.');
    if (type !== out.type) out.config = {};
    out.type = type;
  }
  if ('config' in body || 'type' in body) out.config = cleanConfig(out.type, body.config, out.config);
  if ('buildCmd' in body) out.buildCmd = cleanCommand(body.buildCmd, 'Commande de construction');
  if ('testCmd' in body) out.testCmd = cleanCommand(body.testCmd, 'Commande de tests');
  if ('publicDomain' in body) {
    const name = String(body.publicDomain ?? '').trim().toLowerCase();
    if (name && (!DOMAIN.test(name) || !name.endsWith(PUBLIC_SUFFIX()) || name === PUBLIC_SUFFIX().slice(1))) throw new InputError(`Le nom public doit être un nom de domaine en « ${PUBLIC_SUFFIX()} » (ex. mon-site${PUBLIC_SUFFIX()}).`);
    out.publicDomain = name;
  }
  if ('publicUpstream' in body) {
    const raw = String(body.publicUpstream ?? '').trim();
    if (raw) {
      let u; try { u = new URL(raw); } catch { u = null; }
      if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !/^\/?$/.test(u.pathname) || !/^[a-z0-9.-]+$/i.test(u.hostname)) throw new InputError('L’adresse interne du site doit être de la forme http://192.168.1.x:port (sans chemin ni identifiant).');
      out.publicUpstream = u.origin;
    } else out.publicUpstream = '';
  }
  return out;
}

// Ce qui manque pour pouvoir déployer (messages affichés tels quels).
function missing(project) {
  const d = settingsOf(project), list = [];
  if (!githubRepo(project?.context?.repository)) list.push('le dépôt GitHub du projet');
  if (!d.url) list.push('l’URL de déploiement');
  if (!d.type) list.push('le type de déploiement');
  else for (const f of TYPES[d.type].fields) if (f.required && !d.config[f.key]) list.push(f.label.charAt(0).toLowerCase() + f.label.slice(1));
  if (d.publicDomain && !d.publicUpstream) list.push('l’adresse interne du site (pour le nom public)');
  return list;
}
const missingText = project => { const m = missing(project); return m.length ? 'Pour déployer, renseignez : ' + m.join(', ') + '.' : ''; };

// Corps du PUT /projects/<slug> (contrat v1). Les options vides sont omises.
function payload(project) {
  const d = settingsOf(project), repo = githubRepo(project.context?.repository);
  return { repo: repo.owner + '/' + repo.name, branch: d.branch, type: d.type, public_url: d.url, auto: d.auto === true, deploy: d.config,
    ...(d.buildCmd ? { build_cmd: d.buildCmd } : {}), ...(d.testCmd ? { test_cmd: d.testCmd } : {}),
    ...(d.publicDomain ? { subdomain: { name: d.publicDomain, upstream: d.publicUpstream } } : {}) };
}
const sameRepoName = (a, b) => { const norm = v => String(v || '').trim().toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''); return norm(a) === norm(b); };

module.exports = { TYPES, DEFAULTS, InputError, settingsOf, stateOf, cleanSettings, cleanUrl, missing, missingText, payload, sameRepoName, PUBLIC_SUFFIX };
