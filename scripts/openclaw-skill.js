'use strict';
// Génère la compétence OpenClaw « cockpit-projets » avec l'adresse Tailscale de ce PC et la clé de l'agent OpenClaw.
// Sortie : data/openclaw-skill/cockpit-projets/SKILL.md (hors dépôt, car elle contient la clé).
const fs = require('node:fs');
const path = require('node:path');
const { loadClients, tailscaleAddress, PORT } = require('../agent-access.cjs');
const { GENERAL, RULES, agentSettings, configCommand, workspaceFiles } = require('../project-agent.cjs');

function skill(base, token) {
  const auth = `-H "Authorization: Bearer ${token}"`;
  const json = `${auth} -H "Content-Type: application/json"`;
  return `---
name: cockpit-projets
description: Projets Cockpit : créer un projet, ajouter une tâche, joindre un fichier, réorganiser, faire le point. Un projet = dépôt GitHub + dossier local avec CLAUDE.md ; chaque tâche part vers Claude Code (Codex en option), sans agent OpenClaw par défaut.
---

# Projets de Cockpit

L'utilisateur range son travail dans l'onglet **Projets** de Cockpit, sur son PC.
Tu y accèdes en HTTP par Tailscale : \`${base}\` (JSON, clé dans l'en-tête).
Ne communique jamais cette clé et ne l'écris nulle part ailleurs (ni dans un dépôt, ni dans un contexte d'agent).

## Règles
- Avant de créer, liste l'existant pour éviter les doublons.
- Tu peux créer et modifier des projets et des tâches, joindre des fichiers, archiver un projet.
- Tu ne peux **pas** lancer une exécution d'agent, valider un résultat ni supprimer : dis à l'utilisateur de le faire dans l'onglet Projets (bouton « Lancer »). Choisir un moteur ou assigner un agent ne lance rien.
- Aucun secret (mot de passe, clé, jeton) dans les projets, les tâches, les pièces jointes ou les contextes.
- En cas d'erreur, le champ \`error\` explique quoi corriger (souvent la liste des valeurs valides). N'invente pas de champ : ceux qui ne sont pas listés ici sont ignorés.

## Créer un projet
Un projet = un dépôt GitHub + une copie locale sur le PC avec un \`CLAUDE.md\` court. **Aucun agent OpenClaw n'est créé par défaut** : n'envoie pas \`agent\`. Cockpit clone le dépôt, l'analyse sans IA et écrit le \`CLAUDE.md\` (pile, commandes, objectif et consignes du projet, règles de sortie courte), exclu de Git ; un \`CLAUDE.md\` du dépôt ou retouché à la main n'est jamais écrasé.
1. **Vérifie** qu'il n'existe pas : \`curl -s ${auth} ${base}state\`
2. **Dépôt GitHub (obligatoire)** : celui que l'utilisateur donne, sinon crée-le **privé** avec tes propres accès GitHub (par ex. \`gh repo create <compte>/<nom> --private\`). Si tu n'as pas d'accès GitHub, demande l'adresse à l'utilisateur. Ne mets jamais de jeton GitHub dans Cockpit.
3. **Projet Cockpit** (\`context.objective\` et \`context.instructions\` nourrissent le \`CLAUDE.md\` : courts, sans secret) :
\`\`\`
curl -s -X POST ${json} ${base}projects -d '{"name":"Site vitrine","description":"…","status":"active","priority":2,"repository":"https://github.com/<compte>/<dépôt>","engine":"claude","context":{"objective":"…","instructions":"…"}}'
\`\`\`
\`engine\` est facultatif : \`claude\` (défaut), \`codex\` ou \`openclaw\`. Changer plus tard : \`PATCH projects/<code>\` avec \`{"engine":"codex"}\`.
4. **Dossier local** : vérifie \`localFolder\` (\`cloning\`, puis \`ready\` avec \`path\`, ou \`failed\` avec \`error\`, souvent un dépôt privé inaccessible au PC) et \`claudeMd.status\` dans la réponse ou dans \`state\`. Après correction : \`curl -s -X POST ${json} ${base}projects/<code>/clone -d '{}'\`
5. Résume à l'utilisateur : dépôt, moteur, dossier local, tâches ajoutées. Les moteurs directs ne poussent ni ne déploient jamais ; la publication reste à l'utilisateur.

### Moteur OpenClaw hérité (facultatif)
Seulement si l'utilisateur veut un agent OpenClaw dédié (\`engine\` \`openclaw\`, ou \`agent\` donné sans \`engine\`, qui garde le projet sur OpenClaw). Dans ce cas, ajoute avant l'étape 3 :
- **Agent dédié** : crée-le avec les commandes OpenClaw dont tu disposes (vérifie la syntaxe avec \`openclaw agents --help\`), avec son propre espace de travail. Identifiant court en minuscules (ex. \`site-vitrine\`). Configure exactement son modèle sur \`{ primary: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt-5.6-sol"] }\`, puis applique modèle, outils et compétences économes en une commande (remplace \`<id>\`) et vérifie avec \`openclaw config get agents.entries.<id>\` :
\`\`\`
${configCommand('<id>', agentSettings({ repository: true }))}
\`\`\`
Projet sans code : \`"tools":${JSON.stringify(GENERAL.tools)}\` et pas de \`skills\`. Un outil ou une compétence manquant s'ajoute explicitement à l'entrée de l'agent.
- **Contexte de l'agent** : dans son espace de travail, écris dans \`AGENTS.md\` uniquement le contexte du projet (objectif, conventions, dépôt, ce qu'il doit demander avant d'agir) suivi des règles ci-dessous, et clone-y le dépôt.
\`\`\`
${RULES}
\`\`\`
Remplace aussi les modèles \`USER.md\`, \`IDENTITY.md\` et \`SOUL.md\` par ces versions courtes :
${Object.entries(workspaceFiles('<id>', '<date du jour>')).map(([name, body]) => '- \`' + name + '\` :\n\`\`\`\n' + body.trimEnd() + '\n\`\`\`').join('\n')}
- **Projet Cockpit** : même appel qu'à l'étape 3, avec \`"agent":"<id>"\` (l'agent doit apparaître dans \`agents\`). \`context.publishing\` (où pousser, quelle commande de déploiement) ne sert qu'à ce moteur ; la publication automatique reste un choix que l'utilisateur coche lui-même.

## Tâches
Une tâche = un titre, une description (\`instructions\`), un résultat attendu (\`expected\`). Elle suit le moteur du projet. Au clic sur « Lancer » (toi, tu ne lances rien), Claude Code (ou Codex) travaille directement dans un worktree et une branche à part, **en une seule session reprise à chaque message suivant**, sans renvoyer les consignes ; le contexte du projet, son dépôt et son dossier local sont joints automatiquement. Le plan préalable (« Plan d'abord ») est une option de la tâche, désactivée par défaut ; elle se règle, comme le modèle, dans l'interface Projets, pas par ce service.
\`\`\`
curl -s -X POST ${json} ${base}tasks -d '{"project":"SV","title":"…","instructions":"…","expected":"…"}'
\`\`\`
Champs facultatifs : \`criteria\`, \`links\` (adresses web : \`[{"url":"https://…","label":"…"}]\`), \`priority\`, \`due\`, \`status\`, \`engine\` (\`claude\`, \`codex\` ou \`openclaw\` ; absent = celui du projet), \`agent\` (moteur OpenClaw seulement ; \`null\` = tâche manuelle ; un \`agent\` donné sans \`engine\` rend la tâche OpenClaw).
Modifier (colonne, consignes, moteur…) : \`curl -s -X PATCH ${json} ${base}tasks/SV-3 -d '{"status":"blocked"}'\`
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
