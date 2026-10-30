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
description: Créer, consulter et modifier les projets et tâches de l'utilisateur dans l'onglet Projets de Cockpit (son tableau de bord personnel). À utiliser quand il demande d'ajouter un projet, une tâche, de réorganiser ou de faire le point sur ses projets.
---

# Projets de Cockpit

L'utilisateur range son travail personnel dans l'onglet **Projets** de Cockpit, sur son PC.
Tu y accèdes en HTTP par Tailscale : \`${base}\` (JSON, clé dans l'en-tête).
Ne communique jamais cette clé et ne l'écris nulle part ailleurs.

## Règles
- Avant de créer, liste l'existant pour éviter les doublons.
- Tu peux créer et modifier des projets et des tâches, archiver un projet.
- Tu ne peux **pas** lancer une exécution d'agent, valider un résultat ni supprimer : dis à l'utilisateur de le faire dans l'onglet Projets (bouton « Lancer »). Assigner un agent à une tâche ne lance rien.
- Rédige des consignes claires et un résultat attendu vérifiable : un agent les recevra tels quels au lancement.
- Aucun secret (mot de passe, clé, jeton) dans les projets ou les tâches.
- En cas d'erreur, le champ \`error\` explique quoi corriger (souvent la liste des valeurs valides).

## Valeurs
- Statut de tâche : \`todo\` (À faire), \`doing\` (En cours, tâches manuelles seulement), \`blocked\` (Bloqué), \`review\` (À valider), \`done\` (Terminé).
- Statut de projet : \`prep\` (À préparer), \`active\`, \`paused\`, \`done\`.
- Priorité : 0 aucune, 1 basse, 2 moyenne, 3 haute, 4 urgent. Échéance : \`AAAA-MM-JJ\`.
- Projet : son nom, son code (ex. \`MAI\`) ou son id. Tâche : son code (ex. \`MAI-3\`).
- Agent : identifiant ou nom renvoyé par \`agents\` ; \`null\` pour une tâche manuelle.

## Appels
Lister (filtres facultatifs \`project\`, \`status\`, \`archived=1\`) :
\`\`\`
curl -s ${auth} "${base}state?project=MAI"
\`\`\`
Agents OpenClaw assignables : \`curl -s ${auth} ${base}agents\`
Détail d'une tâche : \`curl -s ${auth} ${base}tasks/MAI-3\`

Créer un projet (\`context\` : objective, instructions, resources, repository, environment, links) :
\`\`\`
curl -s -X POST ${json} ${base}projects -d '{"name":"Maison connectée","description":"…","status":"active","priority":2,"context":{"objective":"…"}}'
\`\`\`
Modifier ou archiver un projet (seuls les champs envoyés changent) :
\`\`\`
curl -s -X PATCH ${json} ${base}projects/MAI -d '{"status":"paused"}'
\`\`\`
Créer une tâche :
\`\`\`
curl -s -X POST ${json} ${base}tasks -d '{"project":"MAI","title":"…","instructions":"…","expected":"…","criteria":"…","priority":3,"due":"2026-11-15","agent":"homelab"}'
\`\`\`
Modifier une tâche (colonne, consignes, agent…) :
\`\`\`
curl -s -X PATCH ${json} ${base}tasks/MAI-3 -d '{"status":"blocked"}'
\`\`\`
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
