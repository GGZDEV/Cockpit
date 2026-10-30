'use strict';
// Génère la compétence OpenClaw « cockpit-projets » avec l'adresse Tailscale de ce PC et la clé de l'agent OpenClaw.
// Sortie : data/openclaw-skill/cockpit-projets/SKILL.md (hors dépôt, car elle contient la clé).
const fs = require('node:fs');
const path = require('node:path');
const { loadClients, tailscaleAddress, PORT } = require('../agent-access.cjs');

function skill(base, token) {
  const auth = `-H "Authorization: Bearer ${token}"`;
  const json = `${auth} -H "Content-Type: application/json"`;
  return `---
name: cockpit-projets
description: Créer, consulter et modifier les projets et tâches de l'utilisateur dans l'onglet Projets de Cockpit (son tableau de bord personnel). Chaque nouveau projet a un dépôt GitHub, un agent OpenClaw dédié avec son contexte, et une copie locale sur le PC pour Claude Code. À utiliser quand il demande de créer un projet, d'ajouter une tâche, de joindre un fichier, de réorganiser ou de faire le point.
---

# Projets de Cockpit

L'utilisateur range son travail dans l'onglet **Projets** de Cockpit, sur son PC.
Tu y accèdes en HTTP par Tailscale : \`${base}\` (JSON, clé dans l'en-tête).
Ne communique jamais cette clé et ne l'écris nulle part ailleurs (ni dans un dépôt, ni dans un contexte d'agent).

## Règles
- Avant de créer, liste l'existant pour éviter les doublons.
- Tu peux créer et modifier des projets et des tâches, joindre des fichiers, archiver un projet.
- Tu ne peux **pas** lancer une exécution d'agent, valider un résultat ni supprimer : dis à l'utilisateur de le faire dans l'onglet Projets (bouton « Lancer »). Assigner un agent ne lance rien.
- Aucun secret (mot de passe, clé, jeton) dans les projets, les tâches, les pièces jointes ou les contextes.
- En cas d'erreur, le champ \`error\` explique quoi corriger (souvent la liste des valeurs valides). N'invente pas de champ : ceux qui ne sont pas listés ici sont ignorés.

## Créer un projet (toujours dans cet ordre)
1. **Vérifie** qu'il n'existe pas : \`curl -s ${auth} ${base}state\`
2. **Dépôt GitHub (obligatoire)** : celui que l'utilisateur donne, sinon crée-le **privé** avec tes propres accès GitHub (par ex. \`gh repo create <compte>/<nom> --private\`). Si tu n'as pas d'accès GitHub, demande l'adresse à l'utilisateur. Ne mets jamais de jeton GitHub dans Cockpit.
3. **Agent dédié** : crée un agent OpenClaw pour ce projet avec les commandes OpenClaw dont tu disposes (vérifie la syntaxe avec \`openclaw agents --help\`), avec son propre espace de travail. Identifiant court en minuscules (ex. \`site-vitrine\`).
4. **Contexte de l'agent** : dans son espace de travail, écris le contexte du projet dans \`AGENTS.md\` (objectif, conventions, dépôt, ce qu'il doit demander avant d'agir) et clone-y le dépôt pour qu'il puisse travailler dessus. C'est l'équivalent, côté OpenClaw, d'un projet Claude avec son contexte.
5. **Projet Cockpit** (l'agent doit apparaître dans \`agents\` ; Cockpit relit la passerelle s'il est nouveau) :
\`\`\`
curl -s -X POST ${json} ${base}projects -d '{"name":"Site vitrine","description":"…","status":"active","priority":2,"repository":"https://github.com/<compte>/<dépôt>","agent":"site-vitrine","context":{"objective":"…","instructions":"…"}}'
\`\`\`
6. **Copie locale sur le PC** : Cockpit clone aussitôt le dépôt sur le PC de l'utilisateur, pour Claude Code. Vérifie \`localFolder\` dans la réponse ou dans \`state\` : \`cloning\`, puis \`ready\` (avec \`path\`) ou \`failed\` (avec \`error\`, souvent un dépôt privé auquel le PC n'a pas accès). Après correction : \`curl -s -X POST ${json} ${base}projects/<code>/clone -d '{}'\`
7. Résume à l'utilisateur : dépôt, agent créé, dossier local sur le PC, tâches ajoutées.

## Tâches
Une tâche = un titre, une description (\`instructions\`), un résultat attendu (\`expected\`). Le contexte du projet, son dépôt et son dossier local sont joints automatiquement au lancement. L'agent du projet est repris par défaut.
\`\`\`
curl -s -X POST ${json} ${base}tasks -d '{"project":"SV","title":"…","instructions":"…","expected":"…"}'
\`\`\`
Champs facultatifs : \`criteria\`, \`links\` (adresses web : \`[{"url":"https://…","label":"…"}]\`), \`priority\`, \`due\`, \`agent\` (\`null\` = tâche manuelle), \`status\`.
Modifier (colonne, consignes, agent…) : \`curl -s -X PATCH ${json} ${base}tasks/SV-3 -d '{"status":"blocked"}'\`
Détail d'une tâche : \`curl -s ${auth} ${base}tasks/SV-3\`

## Pièces jointes
Captures (png, jpg, gif, webp), PDF, zip, textes (txt, md, csv, json, log) ; 10 Mo par fichier, 20 par tâche. Le contenu est vérifié : un fichier renommé est refusé.
Joindre un fichier (contenu en base64 dans un fichier JSON) :
\`\`\`
{ printf '{"name":"capture.png","data":"'; base64 -w0 capture.png; printf '"}'; } > /tmp/pj.json
curl -s -X POST ${json} ${base}tasks/SV-3/attachments -d @/tmp/pj.json && rm /tmp/pj.json
\`\`\`
Récupérer une pièce jointe (chemin \`download\` donné dans le détail de la tâche) :
\`curl -s ${auth} -o capture.png ${base}tasks/SV-3/attachments/<id>\`

## Valeurs
- Statut de tâche : \`todo\` (À faire), \`doing\` (En cours, tâches manuelles seulement), \`blocked\` (Bloqué), \`review\` (À valider), \`done\` (Terminé).
- Statut de projet : \`prep\` (À préparer), \`active\`, \`paused\`, \`done\`.
- Priorité : 0 aucune, 1 basse, 2 moyenne, 3 haute, 4 urgent. Échéance : \`AAAA-MM-JJ\`.
- Projet : son nom, son code (ex. \`SV\`) ou son id. Tâche : son code (ex. \`SV-3\`).
- Agent : identifiant ou nom renvoyé par \`curl -s ${auth} ${base}agents\`.

## Autres appels
Lister (filtres facultatifs \`project\`, \`status\`, \`archived=1\`) : \`curl -s ${auth} "${base}state?project=SV"\`
Modifier ou archiver un projet (seuls les champs envoyés changent ; le dépôt reste une adresse GitHub) :
\`curl -s -X PATCH ${json} ${base}projects/SV -d '{"status":"paused"}'\`
Pour un texte long ou avec apostrophes, écris le JSON dans un fichier et envoie-le avec \`-d @fichier.json\`.
`;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const clients = loadClients(path.join(root, 'data', 'agent-access.json'));
  const address = tailscaleAddress();
  if (!address) { console.error('Tailscale n’est pas actif sur ce PC : OpenClaw ne pourra pas joindre Projets.'); process.exitCode = 1; }
  else {
    const dir = path.join(root, 'data', 'openclaw-skill', 'cockpit-projets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill(`http://${address}:${PORT}/agent/v1/`, clients.openclaw.token));
    console.log('Compétence prête : ' + path.join(dir, 'SKILL.md'));
    console.log('À copier sur le serveur OpenClaw dans ~/.openclaw/skills/cockpit-projets/ (partagé par tous ses agents), avec chmod 600.');
  }
}
module.exports = { skill };
