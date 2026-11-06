# Provenance et choix de prototype

## Restauration des interfaces d’origine

L’habillage pastel du premier prototype a été retiré de l’application. `public/design/feedme.css`, `agents.css`, `ai-usage.css` et `home.css` sont des copies inchangées des feuilles originales. La colonne, les en-têtes repliables, les tuiles de monitoring et le lecteur FeedMe utilisent leurs structures originales ; la grille maison reprend le rail, l’en-tête date/heure, les cartes translucides, les pièces et les vues météo/agenda. `home-icons.js`, `home-model.js` et `home-modules.js` sont copiés directement depuis HomeDashboard ; leurs rendus thermostat, éclairage, capteurs, scènes et automatismes sont branchés sur les sources du prototype.

Les nouvelles dispositions sont dans `mb.layouts.native.v1`. La première disposition de démonstration reste disponible dans son ancienne clé `mb.layouts.v1`. Notes et tâches restent conservées. Les fichiers des deux projets initiaux restent intacts.

## Sources consultées

Les sources de `../FeedMe` et `../HomeDashboard` ont été lues sur place. Elles n’ont pas été déplacées ni modifiées. Aucune configuration personnelle ni aucun jeton n’a été copié dans MetaDashBoard.

| Origine | Ce que le prototype en conserve |
| --- | --- |
| FeedMe `public/dashboard.js` | Principe de registre de modules, bibliothèque, contexte d’instance et préférences |
| FeedMe `public/widgets/*` | Domaines RSS, Spotify, système, calendrier, tâches, météo et collections ; nouvelle présentation |
| FeedMe `server.js` | Contrats JSON des routes de lecture ; pas de copie du serveur de 1 867 lignes |
| FeedMe `agents.js`, `openclaw.js`, `agent-inbox.js` | Réutilisation du service existant via HTTP local ; les identités et les sessions restent chez FeedMe |
| FeedMe `public/agents.js` | Formats de conversations et événements SSE `start`, `delta`, `replace`, `done`, `error` |
| FeedMe `ai-usage.js`, `direct-usage.js` | Format des quotas existants, sans recopier les lecteurs de comptes locaux |
| FeedMe `electron.js`, `preload.js`, `appbar.js` | Distinction entre interface et fonctions Windows ; enveloppe Electron minimale nouvelle |
| FeedMe `extensions/brave/*` | Principe du panneau latéral ; nouvelle extension pour MetaBoard |
| HomeDashboard `js/ha.js` | Copie du client WebSocket dans `public/vendor/ha.js` ; arrêt du minuteur de reconnexion ajouté à `close()` |
| HomeDashboard `js/auth.js` | Copie adaptée dans `public/vendor/auth.js` ; stockage OAuth renommé de `hd.*` en `mb.*` |
| HomeDashboard `js/model.js`, `js/layout.js` | Modèle original copié ; pièces, registres et dispositions par pièce adaptées dans `public/rooms.js` |
| HomeDashboard `js/modules.js`, `js/app.js` | Catalogue original copié ; composants de pièces branchés dans `public/native-renderers.js`, couverture avancée détaillée dans `docs/PARITY.md` |
| HomeDashboard `js/morph.js` | Besoin identifié de préserver le focus ; module non copié, refonte incrémentale du rendu à envisager |
| HomeDashboard `deploy/deploy.sh` | Adresse HA suggérée et principe d’hébergement statique `/config/www/` ; publication MetaBoard ajoutée sous `/local/maison/metaboard/`, sans remplacer la page originale |

## Ce qui est réellement mutualisé ici

Une seule application fournit la bibliothèque, les instances, les vues détaillées, le stockage des dispositions et les trois présentations. La même définition de module est utilisée en carte et en détail. Les équipements HA sont sélectionnables par instance. Les tâches et notes restent locales pour éviter de transformer l’exploration du prototype en migration de données.

Le prototype est sans dépendance serveur, avec des modules JavaScript natifs. Ce choix facilite l’essai et ne préjuge pas du framework d’une future version. La feuille de styles utilise des polices Google avec des alternatives système si le réseau est indisponible.

## Ce qui reste volontairement relié aux anciens projets

Le backend FeedMe reste le propriétaire des conversations, connexions, quotas et fichiers métier. Les commandes maison passent directement par HA. En conséquence, arrêter FeedMe n’arrête pas la connexion HA ; arrêter le PC n’empêche pas une copie statique servie par HA de fonctionner sur tablette.

Ce n’est pas encore une extraction du backend FeedMe en service autonome. Les deux applications initiales restent les références pour les fonctionnalités qui ne sont pas portées.

## Points à décider après essai

1. Valider que les modules et les trois dispositions répondent au besoin quotidien.
2. Choisir où héberger les services RSS/agents pour les rendre accessibles aussi à la tablette.
3. Prévoir une authentification explicite avant toute exposition de ces services hors du PC.
4. Extraire les connecteurs FeedMe en services propres, sans dépendre de ses variables globales Electron.
5. Remplacer les rerendus de page complets par des mises à jour ciblées, avec un cycle de vie d’abonnement par module.
6. Versionner les schémas de configuration et développer les migrations des préférences originales.
7. Porter les fonctions avancées utiles plutôt que tout reproduire immédiatement : météo, transports détaillés, commandes médias, pièces jointes, notifications et suivi RSS.

## État des vérifications lors de la création

- Passerelle locale testée contre les accès hors périmètre et les méthodes interdites.
- Connexion au FeedMe en cours d’exécution : 130 articles lus, collections, calendrier, état Spotify et métriques accessibles.
- Interface essayée en mode démonstration et en données réelles.
- Aucun message à un véritable agent envoyé pour tester le chat.
- Aucun jeton HA extrait, aucune commande envoyée à la maison.
- Extension Brave fournie sans installation ni publication automatique.
- Export tablette publié par le pipeline Git existant, dans son sous-dossier indépendant.


Édition HomeDashboard : `public/home-editor.js` reprend les gestes pointer, maintien tactile, échange, défilement pendant le déplacement, redimensionnement et clavier de `HomeDashboard/js/app.js`, avec adaptation aux données MetaBoard. `public/home-display.js` adapte son en-tête en trois zones, ses polices, fonds et plein écran. Les préférences restent sous `mb.*`, séparées de celles du projet original.


Référence fournie le 29 octobre : `Dashboard Maison-html.zip` (lecture de `Main.dc.html`, sans exécution de ses scripts) confirme que le thème graphite doit habiller une grille maison. Les skins dans `public/themes.css` ne contiennent aucune règle de taille, d’ordre ni de grille. Le profil, et non le thème, choisit la structure. Les rendus compacts système/quota/Spotify/RSS reprennent le balisage des widgets FeedMe.


Réglages visuels : `public/module-settings.js` et `public/module-settings.css` adaptent les contrôles de `HomeDashboard/js/app.js` (pastilles, S/M/L/XL, aperçu des onze polices, formats de date/heure, dimensions et pied de fenêtre). Les choix sont portés par le formulaire jusqu’à la validation, sans modifier la disposition enregistrée lors de l’annulation.

## Restauration des pages de pièces — 29 octobre 2026

`public/rooms.js` reprend l’indexation des pièces et les règles de `js/layout.js`. Les pages personnalisées `room:<area_id>` sont lues dans les préférences originales du compte, puis copiées sous des clés `mb.*` distinctes par maison, pièce et profil. Les notes sont copiées sans réécrire leur source. Les commandes et rendus partagent la même sélection d’appareils : portée de pièce ou sélection manuelle. Les réglages conservent les sélections multiples et les options importées. La synchronisation des modifications entre navigateurs n’est pas portée. Voir [l’inventaire de parité](docs/PARITY.md).

## Reprise complète des contrôleurs — 30 octobre 2026

Les composants FeedMe sont copiés sous `public/integrations/feedme/`, avec adaptation du chargement pour une instance par module et du transport vers la passerelle MetaBoard. `public/vendor/home-morph.js` reprend le rendu incrémental original. Les réglages et actions HA supplémentaires sont branchés dans `module-settings.js`, `ha-actions.js`, `proxmox.js`, `data.js` et `account-sync.js`. Le lanceur réutilise le backend FeedMe existant sans modifier ses sources. Le relais `relay.cjs` permet la connexion depuis l’interface tablette avec une session administrateur HA valide. L’état courant et les limites remplacent les constats historiques ci-dessus : [docs/PARITY.md](docs/PARITY.md).

## Style de réponse caveman — 6 novembre 2026

`claude-caveman.md` reprend `skills/caveman/SKILL.md` de [caveman](https://github.com/juliusbrussee/caveman) v4.0.1 (commit `4bf8898`, Apache-2.0, © Julius Brussee). Modifications : en-tête YAML et section « Persistence » (commandes `/caveman`, suivi par hooks) retirés, remplacés par « toujours actif » ; mention de `/caveman-compress` retirée. `claude-direct.cjs` passe ce texte à chaque appel `claude -p` via `--append-system-prompt`.
