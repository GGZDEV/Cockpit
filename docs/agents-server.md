# Connexion autonome aux agents

Le navigateur rejoint un service agents permanent, authentifié par la session
administrateur Home Assistant. Ce service rejoint OpenClaw en WebSocket. Aucun
appel agents ou quotas ne passe par le PC lorsque `agentsOrigin` est configuré.
Les autres modules (RSS, métriques du PC, projets) gardent leur circuit existant.
Sans `agentsOrigin`, la connexion locale existante reste utilisée pendant la migration.
Une panne du serveur configuré ne bascule jamais silencieusement sur le PC.

## Installation sur le serveur Linux

Prérequis : Node 22 ou supérieur, accès du serveur à Home Assistant et OpenClaw,
et accès de la tablette à l’adresse du nouveau service. Une adresse Tailscale
nécessite Tailscale sur la tablette ; sinon prévoir un relais réseau accessible.
Le service utilise les adaptateurs HTTP existants de FeedMe, sans lancer Electron
ni le serveur desktop. Révision validée :
`GGZDEV/FeedMe@010fbab3fa99bb216050817d111082316479bfae`.

Avec un compte administrateur du serveur :

```sh
git clone https://github.com/GGZDEV/Cockpit.git ~/Cockpit
git clone https://github.com/GGZDEV/FeedMe.git ~/FeedMe
cd ~/FeedMe
git checkout 010fbab3fa99bb216050817d111082316479bfae
npm install --omit=dev --ignore-scripts
mkdir -p ~/.config/systemd/user ~/.local/share/cockpit-agents
chmod 700 ~/.local/share/cockpit-agents
cp ~/Cockpit/deploy/cockpit-agents.service ~/.config/systemd/user/
```

Créer `~/.config/cockpit-agents.env` (mode 600), avec les chemins absolus
correspondant au compte Linux :

```ini
BACKEND_DIR=/home/openclaw/FeedMe
AGENTS_DATA_DIR=/home/openclaw/.local/share/cockpit-agents
HA_ORIGIN=http://192.168.1.251:8123
AGENTS_HOST=127.0.0.1
AGENTS_PORT=3889
```

Le service écoute par défaut sur localhost : un reverse proxy HTTPS peut le
publier sur le réseau privé. Pour un réseau privé de confiance en HTTP, fixer
AGENTS_HOST à l’adresse privée précise du serveur. Ne pas exposer directement ce
port sur Internet. Le site HTTPS exige un endpoint HTTPS. Le proxy doit conserver
Authorization et Origin, désactiver la mise en tampon SSE et autoriser les longues
requêtes de messages. L’origine HA doit être celle de la page qui intègre les agents.

```sh
systemctl --user daemon-reload
systemctl --user enable --now cockpit-agents
# À activer une fois avec les droits administrateur pour survivre aux déconnexions :
sudo loginctl enable-linger openclaw
```

Ajouter `agentsOrigin` à `public/runtime.json`, avec uniquement l’origine joignable
depuis la tablette (exemple `https://agents.exemple.fr`), puis republier le site.
La génération du runtime préserve ce champ. Ne l’activer qu’après le démarrage
et la vérification du service. L’adresse ne contient aucun secret.

## Association et données

Ouvrir le module Agents, configurer sa passerelle (localhost est utilisable si le
service et OpenClaw sont sur le même serveur), puis approuver le nouvel appareil
côté OpenClaw. Les secrets sont chiffrés AES-256-GCM au repos ; la clé reste dans
AGENTS_DATA_DIR avec les données, hors des fichiers publics et du dépôt. Sauvegarder
ce répertoire privé complet, clé comprise. Ne pas copier les secrets Windows,
qui ne peuvent pas être déchiffrés sur Linux. Le service a sa propre identité
persistante. Les historiques distants restent dans OpenClaw ; les conversations
purement locales et les profils du PC ne sont pas migrés automatiquement.
Les quotas proviennent des connexions OpenClaw du service, pas des abonnements
connectés uniquement aux applications du PC.

## Validation avant activation

Avec la session administrateur HA : vérifier `/api/status`, la liste des agents,
l’envoi d’un message et sa réception en flux, l’historique et les quotas proposés
par OpenClaw. Éteindre le PC et répéter. Vérifier aussi un redémarrage du service.
Sans session, le service doit répondre 401 ; une autre origine doit recevoir 403.
Pour revenir à la connexion précédente, retirer `agentsOrigin` puis republier.

## Publication sans inclure les modifications en cours

`COCKPIT_PUBLIC_SOURCE` permet au script de publication de lire un export propre
des fichiers publics du commit choisi plutôt que les fichiers de travail.
Le fonctionnement habituel de `npm run deploy:tablet` reste identique.
