# Applications : développer, installer et publier

Le conteneur **CT113 application**, `192.168.1.236`, héberge Cockpit, Claude Code, Deployer, God's Eye, World Monitor et OpenRadio. OpenClaw est un client facultatif extérieur. CT114 n'est plus la cible par défaut.

## Droits effectifs des tâches

Sur cette installation, `COCKPIT_APPLICATIONS=1` autorise les outils réseau et Docker local pour les tâches Claude existantes et nouvelles, y compris les sessions reprises. La politique serveur est ajoutée au prompt système, même si un ancien `CLAUDE.md` parle encore d'interdiction réseau. L'utilisateur a autorisé ces droits pour son usage personnel. L'accès au socket Docker donne de larges droits sur le conteneur Applications : ce n'est pas une isolation de sécurité face à du code malveillant.

Ne pas modifier les conteneurs en ligne pour essayer une tâche : construire une image et démarrer un conteneur temporaire nommé avec le code de tâche, sur un port libre. Les dépôts/worktrees restent séparés du code servi. Ne pas utiliser CT104/OpenClaw comme dépendance d'hébergement.

## Publication : conserver les règles du projet

`Clore` ne publie pas. `Clore et déployer` fusionne/pousse selon le fonctionnement existant ; le mode automatique ou manuel reste inchangé. L'agent peut préparer une recette et tout vérifier sans publier. Un lancement explicite de Deployer ou une création de domaine par l'agent requiert que la demande utilisateur autorise cette opération ; ne pas remplacer la validation par un `git push` ou un `docker compose up` directement sur la production.

Outil disponible sur le serveur :

```
node /home/openclaw/services/cockpit/scripts/applicationctl.cjs help
node /home/openclaw/services/cockpit/scripts/applicationctl.cjs state
node /home/openclaw/services/cockpit/scripts/applicationctl.cjs configure <id-projet> deploy/application.json
```

`configure` enregistre une recette sans lancer de publication et conserve branche/mode automatique. Il utilise les identifiants serveur sans les afficher. Pour les compagnons (OpenRadio par exemple), `register-app <slug> <recette>`, `deploy-app <slug>`, `status <slug>` et `domain <slug> <nom-exact>` s'adressent au même Deployer. Ne jamais mettre une clé dans le JSON.

## Recette Compose pour les projets futurs

Ajouter au dépôt `deploy/application.json` :

```json
{
  "compose": "compose.yaml",
  "healthUrl": "http://192.168.1.236:3200/",
  "expect": "Mon application"
}
```

Le Compose expose ce port sur `192.168.1.236`, possède une politique de redémarrage, limite mémoire et journaux. Les volumes nommés conservent les données entre publications ; une migration destructive de données exige un plan de sauvegarde/retour arrière. Le runner installé `/usr/local/bin/application-deploy <slug> . deploy/application.json "$DEPLOY_COMMIT"` construit/démarre puis vérifie l'URL interne. Deployer exécute la même recette au commit précédent en cas d'échec, sans toucher les volumes.

Pour une source externe épinglée : voir `deploy/openradio/application.json`, `source.repository`, `source.commit` complet et `dockerfile` du dépôt. L'image est étiquetée par commit de livraison et injectée dans Compose via `${APP_IMAGE}`. Pour un compagnon, ajouter `repository` (`owner/repo`), `url`, `recipe`, et éventuellement `domain`/`upstream`. Les domaines protégés passent par Cockpit et ne transmettent jamais ses identifiants à l'application.

## Résultat attendu

Ne pas annoncer « déployé » pour un simple commit ou des tests du dashboard. Construire réellement, vérifier HTTP et API, puis lecture/interactions et capture si interface. Dire explicitement ce qui reste non vérifié. Ne pas fournir des commandes administrateur à l'utilisateur lorsqu'elles peuvent être exécutées ici.

## Migration World Monitor 2026-11-12

Transfert des images déjà en service, configurations et volume Redis vers CT113, sans changement de domaine ou d'identifiants. L'ancienne installation CT114 est conservée arrêtée pour retour arrière, jamais supprimée automatiquement. La configuration Cockpit pointe désormais vers `http://192.168.1.236:3000`. Les recettes Deployer utilisent Applications, pas CT114.
