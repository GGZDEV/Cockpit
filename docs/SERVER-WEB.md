# Cockpit web permanent (Projets)

## Architecture choisie

Un seul processus Node sert l’interface et `/api/projects/*` sur la même origine. Le mode `COCKPIT_SERVER_MODE=1` :

- écoute sur `HOST`/`PORT` et vérifie `COCKPIT_ALLOWED_HOSTS` ;
- protège tout le site par le mot de passe `COCKPIT_WEB_PASSWORD_FILE` (obligatoire) : page de connexion et cookie de session pour les navigateurs, HTTP Basic pour les scripts (voir « Connexion ») ;
- ouvre directement **Projets** et ne rend ni modules PC, ni métriques système, ni réglages desktop/HA ;
- exécute les tâches avec Claude Code (Codex peut être activé), dans `COCKPIT_WORKSPACES` ;
- désactive le moteur OpenClaw historique, qui dépendait de la passerelle desktop FeedMe ;
- joint Deployer CT113 à `http://192.168.1.236:8080` avec un jeton lu hors Git.

Le service systemd utilisateur redémarre après une panne. Le linger de l’utilisateur permet son démarrage sans session ouverte. Les données restent dans `data/` (ignoré par Git), les dépôts dans `~/Projets`, les secrets et la configuration dans `~/.config/cockpit/`.

## Connexion (persistante d’un déploiement à l’autre)

- **Navigateur, téléphone, appli écran d’accueil iOS** : une navigation sans session reçoit **401** avec une page de connexion autonome (mot de passe seul ; identifiant caché `cockpit` pour les gestionnaires de mots de passe), sans `WWW-Authenticate`, donc sans fenêtre native. `POST /login` pose le cookie `cockpit_session` (HMAC-SHA256, `HttpOnly; SameSite=Lax; Path=/`, `Secure` derrière le proxy HTTPS, 400 jours, prolongé à chaque visite après un jour) puis renvoie vers la page demandée (chemin local seulement).
- **Scripts, curl, contrôle de santé** (pas d’en-têtes `Sec-Fetch-*`) : `401` + `WWW-Authenticate: Basic` comme avant ; `-u cockpit:<mot de passe>` reste accepté. Une navigation authentifiée en Basic reçoit aussi le cookie : les appareils déjà configurés basculent seuls.
- **Appel d’API sans session depuis le navigateur** : `401` JSON avec `X-Cockpit-Login: 1` ; `public/login-guard.js` recharge alors la page, qui affiche la connexion.
- **Dossier d’état** `COCKPIT_STATE_DIR` (défaut `~/.config/cockpit`, `0700`) : `session-secret` (32 octets aléatoires, `0600`, créé une fois, jamais régénéré) et `ha-session.json` (`0600`). Le clone de déploiement peut donc être remplacé sans déconnecter personne. La clé de signature dépend du secret **et** du mot de passe web : changer `web-password` (puis redémarrer) déconnecte tous les appareils ; supprimer `session-secret` aussi.
- **Se déconnecter** : bouton dans Paramètres (`POST /logout`). Les échecs de mot de passe sont limités par adresse (8 par quart d’heure, en mémoire). Manifeste et icônes PWA restent publics.
- **Jeton Home Assistant** : mémorisé par le serveur dans `<état>/ha-session.json`. Au premier accès, un ancien `data/ha-session.json` est copié (sans être supprimé ; « Déconnecter » efface les deux). Au démarrage, chaque appareil essaie son jeton, puis celui du serveur s’il est refusé ; un jeton n’est enregistré qu’après avoir fonctionné, et une coupure réseau ne jette aucun jeton (`public/ha-session.js`).

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

Sans identifiants, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3888/` doit répondre `401` (contrôle de santé de Deployer).

Dans le navigateur : `http://<IP_DE_L_HOTE>:3888/`, page de connexion, mot de passe contenu dans `~/.config/cockpit/web-password`. Créer ensuite un projet de test ; l’état Deployer doit indiquer l’hôte `192.168.1.236:8080`.

## Secrets indispensables

- `deployer-token` : obligatoire pour enregistrer et déployer un projet sur CT113 ; jamais committé, jamais envoyé au navigateur.
- `web-password` : obligatoire pour protéger l’interface exposée sur le LAN ; jamais committé.
- `session-secret`, `ha-session.json` : créés par le serveur dans le dossier d’état ; jamais committés, à conserver entre les déploiements.
- authentifications `gh` et `claude` : restent dans leurs stockages utilisateur existants ; Cockpit ne les copie pas.

Aucune configuration ne vise ni ne modifie `aio.ggz.ovh`.
