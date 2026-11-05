# Cockpit web permanent (Projets)

## Architecture choisie

Un seul processus Node sert l’interface et `/api/projects/*` sur la même origine. Le mode `COCKPIT_SERVER_MODE=1` :

- écoute sur `HOST`/`PORT` et vérifie `COCKPIT_ALLOWED_HOSTS` ;
- demande une authentification HTTP Basic si `COCKPIT_WEB_PASSWORD_FILE` est configuré ;
- ouvre directement **Projets** et ne rend ni modules PC, ni métriques système, ni réglages desktop/HA ;
- exécute les tâches avec Claude Code (Codex peut être activé), dans `COCKPIT_WORKSPACES` ;
- désactive le moteur OpenClaw historique, qui dépendait de la passerelle desktop FeedMe ;
- joint Deployer CT113 à `http://192.168.1.236:8080` avec un jeton lu hors Git.

Le service systemd utilisateur redémarre après une panne. Le linger de l’utilisateur permet son démarrage sans session ouverte. Les données restent dans `data/` (ignoré par Git), les dépôts dans `~/Projets`, les secrets et la configuration dans `~/.config/cockpit/`.

## Audit des anciennes dépendances PC/desktop

Pour **Projets**, les dépendances utiles sont : Node.js, Git, GitHub CLI déjà authentifié, Claude CLI déjà authentifié, et un dossier de travail persistant. Elles existent sur l’hôte OpenClaw.

Dépendances desktop neutralisées en mode serveur :

- découverte locale FeedMe sur les ports 3777–3782 ;
- fenêtre Electron, AppBar Windows, extension Brave et scripts `.cmd`/`.vbs` ;
- relais Home Assistant/tablette et détection des interfaces réseau ;
- métriques du PC, Spotify, RSS, maison et conversations OpenClaw fournies par FeedMe ;
- accès agent séparé sur le port 3890.

Les fichiers historiques restent disponibles pour le mode local, mais ne sont ni démarrés ni présentés par le service web.

## Installation idempotente (à exécuter lors du déploiement)

Depuis le clone destiné à rester en place :

```bash
./scripts/install-web-service.sh \
  --allowed-hosts <IP_DE_L_HOTE>,<NOM_DNS> \
  --deployer-token-file /home/openclaw/.openclaw/workspace/deployer/secrets/cockpit-api-token
```

Le script :

1. copie le jeton en mode `0600` dans `~/.config/cockpit/deployer-token` ;
2. crée une fois un mot de passe web aléatoire dans `~/.config/cockpit/web-password` ;
3. crée `~/.config/cockpit/web.env` seulement s’il n’existe pas ;
4. génère l’unité avec les chemins absolus du clone et de Node ;
5. recharge et active `cockpit-web.service`.

Une relance conserve `web.env`, le mot de passe et les données. Pour changer les hôtes autorisés, éditer `~/.config/cockpit/web.env`, puis :

```bash
systemctl --user restart cockpit-web.service
```

## Vérification après déploiement

```bash
systemctl --user status cockpit-web.service
curl -u "cockpit:$(cat ~/.config/cockpit/web-password)" \
  -H "Host: <IP_DE_L_HOTE>:3888" http://127.0.0.1:3888/api/status
curl http://192.168.1.236:8080/health
```

Dans le navigateur : `http://<IP_DE_L_HOTE>:3888/`, utilisateur `cockpit`, mot de passe contenu dans `~/.config/cockpit/web-password`. Créer ensuite un projet de test ; l’état Deployer doit indiquer l’hôte `192.168.1.236:8080`.

## Secrets indispensables

- `deployer-token` : obligatoire pour enregistrer et déployer un projet sur CT113 ; jamais committé, jamais envoyé au navigateur.
- `web-password` : obligatoire pour protéger l’interface exposée sur le LAN ; jamais committé.
- authentifications `gh` et `claude` : restent dans leurs stockages utilisateur existants ; Cockpit ne les copie pas.

Aucune configuration ne vise ni ne modifie `aio.ggz.ovh`.
