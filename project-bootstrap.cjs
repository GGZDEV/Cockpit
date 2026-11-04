'use strict';
// Projet NOUVEAU : squelette minimal, premier commit, premier push. Le dépôt GitHub est créé et cloné avant (voir projects.cjs).
// Reprenable sans risque : un fichier existant n'est jamais réécrit, un commit déjà fait n'est pas refait, seul le push est retenté.
// Les noms de fichiers sont fixes et les commandes Git reçoivent des arguments en tableau (jamais de shell).
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./direct-harness.cjs');

const GITIGNORE = 'node_modules/\n.env\n.env.*\n*.log\n.DS_Store\n';
const MESSAGE = 'Squelette initial (créé par Cockpit)';
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

function skeleton(project) {
  const about = clip(project.description, 300);
  return { 'README.md': `# ${clip(project.name, 120).replace(/\n/g, ' ')}\n\n${about ? about + '\n\n' : ''}Projet créé avec Cockpit.\n`, '.gitignore': GITIGNORE };
}
// Message lisible pour les échecs Git courants (identité absente, droits de push…).
function reason(error) {
  const out = redact(String(error.stderr || error.message || ''));
  if (/tell me who you are|empty ident|unable to auto-detect email/i.test(out)) return 'Git n’a pas d’identité sur ce PC : lancez « git config --global user.name » et « git config --global user.email », puis « Réessayer ».';
  if (/could not read Username|Authentication failed|\b403\b|Permission to .*denied|Invalid username or password|Repository not found|remote rejected|failed to push some refs|declined/i.test(out)) return 'Le push vers GitHub a été refusé : ce PC n’a pas d’accès en écriture enregistré pour ce dépôt (connexion Git ou GitHub CLI : « gh auth setup-git »). Les fichiers sont prêts dans le dossier local ; « Réessayer » relance le push.';
  return (out.split('\n').map(l => l.trim()).filter(Boolean).at(-1) || 'Opération Git échouée.').slice(0, 300);
}

// dir : copie locale (clone du dépôt vide). Renvoie ce qui a été fait.
async function seed({ project, dir, branch = 'main', git }) {
  const done = { written: [], committed: false, pushed: false };
  try {
    const hasHead = await git(['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
    if (!hasHead) await git(['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/' + branch]); // branche non encore née : on la nomme sans l'écrire
    const files = skeleton(project);
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(dir, name);
      if (fs.existsSync(target)) continue; // jamais d'écrasement
      fs.writeFileSync(target, body); done.written.push(name);
    }
    await git(['-C', dir, 'add', '--', ...Object.keys(files)]);
    const staged = await git(['-C', dir, 'diff', '--cached', '--name-only']);
    if (staged.trim() || !hasHead) { await git(['-C', dir, 'commit', '-m', MESSAGE]); done.committed = true; }
    const current = (await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(['-C', dir, 'push', '-u', 'origin', current]);
    done.pushed = true; done.branch = current;
  } catch (error) { throw Object.assign(new Error(reason(error)), { status: 409, done }); }
  return done;
}

module.exports = { seed, skeleton, reason, MESSAGE };
