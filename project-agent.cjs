'use strict';
// Réglages des agents OpenClaw dédiés aux projets, partagés par la demande de création (projects.cjs)
// et par la compétence cockpit-projets : modèle, outils, compétences et fichiers d'espace de travail courts.
// Chaque outil, compétence ou fichier injecté est relu à chaque tour : on garde le nécessaire, rien de plus.

const MODEL = Object.freeze({ primary: 'anthropic/claude-opus-5-5', fallbacks: ['openai/gpt-5.6-sol'] });

// Projet avec dépôt : fichiers, commandes (git, gh, npm), web, navigateur et lecture de captures.
// Sans messagerie, automatisations, appareils, médias génératifs, wiki, voix ni tableaux de bord.
const CODE = Object.freeze({
  tools: { profile: 'minimal', alsoAllow: ['group:fs', 'exec', 'process', 'secrets', 'web_search', 'web_fetch', 'browser', 'view_image'] },
  // cockpit-projets : télécharger les pièces jointes (captures) des tâches.
  skills: ['github', 'browser-automation', 'cockpit-projets', 'node-inspect-debugger'],
});
// Projet sans dépôt : profil généraliste d'OpenClaw et toutes les compétences, pour ne fermer aucun usage.
const GENERAL = Object.freeze({ tools: { profile: 'coding', alsoAllow: ['browser'] } });

function agentSettings(project = {}) {
  const preset = project.context?.repository || project.repository ? CODE : GENERAL;
  return { kind: preset === CODE ? 'code' : 'general', model: MODEL, tools: preset.tools, ...(preset.skills ? { skills: preset.skills } : {}) };
}

// Commande unique appliquée après « openclaw agents add » ; elle ne touche que l'entrée de cet agent.
function configCommand(agentId, settings) {
  const entry = `agents.entries.${agentId}`;
  const ops = [{ path: entry + '.model', value: settings.model }, { path: entry + '.tools', value: settings.tools }];
  if (settings.skills) ops.push({ path: entry + '.skills', value: settings.skills });
  return `openclaw config set --batch-json '${JSON.stringify(ops)}'`;
}

// Règles ajoutées à la fin d'AGENTS.md, après le contexte du projet (à la place du modèle générique d'OpenClaw).
const RULES = `## Sécurité
- Aucun secret (clé, jeton, mot de passe) dans le dépôt, les tâches ou ce fichier ; si un accès manque, le demander avec l'outil \`secrets\`.
- Demander avant toute action destructive, publication, déploiement, envoi externe ou dépense non prévus par la tâche.
- Avant de modifier la copie locale, vérifier \`git status\` : ne jamais écraser ni committer des changements qui ne sont pas les tiens (sinon travailler dans un \`git worktree\` séparé).

## Efficacité (jetons)
- Regrouper dans un même tour les lectures et commandes indépendantes ; enchaîner les commandes liées en un seul appel shell.
- Chercher avant de lire (\`git grep -n\`, \`grep -rn\`), puis lire seulement les lignes utiles ; ne pas relire un fichier déjà lu ou qu'on vient d'éditer.
- Captures : les analyser toutes en une seule passe, noter les constats, ne pas les rouvrir.
- Boucle visuelle bornée : au plus 2 cycles capture → correction → capture par problème, puis rapporter ce qui reste. Fermer le navigateur dès la vérification finie.
- Tests ciblés pendant le travail, suite complète une seule fois à la fin.
- Réponse finale courte : ce qui a changé, tests, commit, ce qui reste.`;

// Versions minimales qui remplacent les modèles génériques créés par OpenClaw (ils sont injectés à chaque tour).
function workspaceFiles(agentId, day = new Date().toISOString().slice(0, 10)) {
  return {
    'USER.md': `# USER.md\n\n## Directives\n\n<!-- observed: ${day} | status: active -->\n\n- Always reply in French, short: the result first, then only what the user must do.\n`,
    'IDENTITY.md': `# IDENTITY.md\n\n- Name: ${agentId}\n`,
    'SOUL.md': '# SOUL.md\n\nAide réellement, sans formules creuses. Cherche avant de demander. Prudent avec tout ce qui sort de la machine, audacieux en interne. Concis par défaut, précis quand ça compte.\n',
  };
}

module.exports = { MODEL, CODE, GENERAL, RULES, agentSettings, configCommand, workspaceFiles };
