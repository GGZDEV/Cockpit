'use strict';
// Dossier local des projets : clone du dépôt GitHub sur ce PC, pour que Claude Code travaille directement dedans.
// Seules les adresses https://github.com/<compte>/<dépôt> sont acceptées. Un dossier existant n'est jamais écrasé.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i;

function githubRepo(value) {
  const m = GITHUB.exec(String(value || '').trim());
  if (!m || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], name: m[2], web: `https://github.com/${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git` };
}
const sameRepo = (a, b) => String(a || '').trim().toLowerCase().replace(/\.git$|\/$/g, '') === String(b || '').trim().toLowerCase().replace(/\.git$|\/$/g, '');

function gitRunner(args, options = {}) {
  return new Promise((resolve, reject) => {
    // Aucune invite : sans accès déjà enregistré sur ce PC, le clonage échoue au lieu d'attendre.
    execFile('git', args, { timeout: 10 * 60000, windowsHide: true, maxBuffer: 1024 * 1024, ...options,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => {
      if (error) { error.stderr = String(stderr || ''); return reject(error); }
      resolve(String(stdout || ''));
    });
  });
}

function createWorkspaces({ root = process.env.COCKPIT_WORKSPACES || path.dirname(__dirname), git = gitRunner } = {}) {
  const busy = new Set();
  const target = repo => path.join(root, repo.name);
  const reason = error => (String(error.stderr || error.message || '').split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/^Cloning into/i.test(l)).at(-1) || 'Le clonage a échoué.').slice(0, 400);

  async function clone(repository) {
    const repo = githubRepo(repository); if (!repo) throw new Error('Adresse GitHub invalide : https://github.com/<compte>/<dépôt> attendue.');
    const dest = target(repo), key = dest.toLowerCase();
    if (busy.has(key)) throw new Error('Un clonage est déjà en cours vers ' + dest + '.');
    busy.add(key);
    try {
      if (fs.existsSync(dest)) {
        // Dossier déjà présent : réutilisé seulement s'il s'agit déjà de ce dépôt.
        const origin = await git(['-C', dest, 'remote', 'get-url', 'origin']).catch(() => '');
        if (sameRepo(origin, repo.url)) return { path: dest, reused: true };
        throw new Error('Le dossier ' + dest + ' existe déjà et ne contient pas ce dépôt : rien n’a été modifié. Renommez-le ou choisissez un autre dépôt.');
      }
      // Dépôt déjà présent sous un autre nom de dossier (ex. GGZDEV/Cockpit dans MetaDashBoard) : on le réutilise.
      let folders = [];
      try { folders = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, '.git'))).map(d => path.join(root, d.name)); } catch { /* dossier racine absent */ }
      for (const folder of folders) {
        const origin = await git(['-C', folder, 'remote', 'get-url', 'origin']).catch(() => '');
        if (sameRepo(origin, repo.url)) return { path: folder, reused: true };
      }
      try { await git(['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--', repo.url, dest]); }
      catch (error) { throw new Error(reason(error)); }
      return { path: dest, reused: false };
    } finally { busy.delete(key); }
  }
  return { clone, target: repository => { const repo = githubRepo(repository); return repo ? target(repo) : ''; }, root };
}

module.exports = { createWorkspaces, githubRepo, sameRepo };
