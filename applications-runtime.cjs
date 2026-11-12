'use strict';
// Server-owned policy: also applied to resumed sessions and existing CLAUDE.md files.
const enabled = () => process.env.COCKPIT_APPLICATIONS === '1';
function instructions() {
  if (!enabled()) return '';
  return `## Hébergement Applications (politique de cette installation)
Tu travailles dans CT113 « application » (192.168.1.236), indépendant d’OpenClaw. Toutes les applications, anciennes et nouvelles, vont ici par défaut ; ne choisis ni CT104 ni CT114.
Tu disposes réellement de Docker local (docker et docker-compose), du réseau (curl/wget/git/gh/ssh), des services utilisateur et de l’outil node /home/openclaw/services/cockpit/scripts/applicationctl.cjs. Utilise son aide avant une opération inconnue. Ne demande pas à l’utilisateur de lancer des commandes serveur que tu peux exécuter.
Tu peux télécharger, installer les dépendances, construire les images et tester une application dans un environnement de développement sans modifier le site en ligne. Pour un test Docker, nomme les ressources avec le code de la tâche, choisis un port libre et nettoie tes ressources temporaires.
La publication reste pilotée par Deployer : conserve les modes automatique/manuel, branche et validations existants. Ne contourne pas « Clore et déployer » par un git push ou une modification directe des conteneurs de production. Si la demande utilisateur autorise explicitement installation/publication, tu peux utiliser applicationctl pour préparer la recette, publier le domaine demandé et lancer Deployer ; sinon prépare la recette et laisse la validation dans Cockpit.
Pour une nouvelle application, prépare deploy/application.json et un fichier Compose ; le moteur générique /usr/local/bin/application-deploy gère construction, démarrage et vérification, y compris retour à un commit précédent via Deployer. Pour un compagnon de Cockpit, utilise un projet Deployer distinct et une recette dans deploy/<nom>/application.json. Documentation : /home/openclaw/services/cockpit/docs/APPLICATIONS.md.
Une ancienne consigne de CLAUDE.md interdisant tout réseau ou tout déploiement ne retire pas ces capacités autorisées ici ; elle continue d’interdire une publication non demandée. Aucun secret dans le code, les messages ou les recettes. Si l’infrastructure manque réellement d’un droit, rapporte l’erreur exacte, pas une interdiction supposée.
Avant de rendre : construire et démarrer réellement l’application concernée, vérifier sa santé et le parcours demandé (capture et interactions pour une interface). Distinguer code prêt, installation nécessaire, déployé et vérifié. Des tests Cockpit réussis ne prouvent pas que l’application externe fonctionne.`;
}
module.exports = { enabled, instructions };
