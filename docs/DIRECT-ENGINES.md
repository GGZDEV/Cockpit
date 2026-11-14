# Moteurs directs : Claude Code et Codex

## Contrat Claude natif (2026-11-13)

Un projet Cockpit correspond à un environnement Claude ; une tâche correspond à une session conservée dans son worktree. Cockpit lance le CLI Claude Code lui-même, sans autre modèle pour planifier, reformuler ou relire automatiquement.

- Premier message : titre, demande, résultat attendu, critères, ressources, pièces jointes et éventuelle précision de l'utilisateur.
- Messages suivants : nouvelle demande et nouvelles pièces jointes seulement, avec `--resume` et le même UUID.
- Aucun Caveman, méthode de lecture, format de réponse compressé, suite de tests ou capture obligatoire ajoutés par Cockpit.
- Claude gère lui-même installation et vérifications. Cockpit ne lance plus installation/baseline avant les tâches Claude. La préparation historique Codex reste inchangée.
- L'option utilisateur « Plan d'abord » reste disponible en lecture seule ; elle n'est pas activée systématiquement.

## Arguments et capacités

`claude -p --output-format stream-json --verbose --tools default` conserve la boucle agent native. Le moteur charge normalement les réglages utilisateur/projet/locaux, skills, commandes, hooks, mémoire et serveurs MCP configurés. Cockpit n'ajoute aucun plugin.

Les anciennes options `--disable-slash-commands`, `--strict-mcp-config`, `--exclude-dynamic-system-prompt-sections` et le bloc `--settings` qui désactivait mémoire/hooks/instructions Git ont été retirés. Le modèle choisi dans Cockpit, l'effort optionnel, les plafonds et les permissions restent en place.

En Applications (`COCKPIT_APPLICATIONS=1`), seul un contexte système d'hébergement/publication est ajouté : CT113, outils locaux, préparation séparée de la production, recettes Compose, Deployer et respect des validations. Aucune procédure de vérification universelle. Docker et le réseau restent accessibles ; `git push` et `npm publish` restent interdits au moteur pour ne pas contourner la publication Cockpit.

Sans Applications, les protections réseau/publication historiques restent actives. Pas de `--bare` ni de `--dangerously-skip-permissions`. OAuth conservé ; clés API/variables privées du serveur filtrées ; secrets caviardés dans les résultats.

## Consignes et configuration de projet

`project-claudemd.cjs` analyse le dépôt sans IA. Si absent, Cockpit génère un `CLAUDE.md` avec les faits du dépôt, commandes, objectif, environnement et consignes **sans troncature supplémentaire**. Seules les limites de saisie API restent applicables. Les procédures génériques d'économie de jetons et de tests ont été retirées.

Un fichier suivi dans Git ou retouché à la main n'est jamais réécrit. Si le dépôt a déjà un `CLAUDE.md`, les champs Cockpit sont placés dans une règle native séparée `.claude/rules/cockpit-project.md`, elle-même protégée contre les retouches. Les fichiers générés restent exclus des commits.

À chaque lancement/reprise, Cockpit actualise ses fichiers non retouchés et synchronise les fichiers **locaux non suivis** `CLAUDE.md`, `CLAUDE.local.md`, `.claude/**` et `.mcp.json` vers le worktree. Les fichiers suivis appartiennent à la branche de la tâche : ils ne sont pas écrasés par ceux d'une autre branche. Les liens symboliques ne sont pas recopiés.

Un manifeste de hachages dans le répertoire administratif Git de la tâche permet d'actualiser/supprimer uniquement les copies encore identiques à celles gérées par Cockpit. Les modifications spécifiques à une tâche sont conservées. Les copies générées anciennes sont reconnues seulement par un hachage connu, jamais par leur simple en-tête.

**Sessions anciennes :** le CLI installé enregistre par défaut un instantané du prompt système à la première requête. Une ancienne session peut donc conserver Caveman ou l'ancien contexte système malgré le retrait des options au lancement. Cockpit ne détruit ni ne réécrit ces sessions, et ne désactive pas globalement ce comportement natif. Les nouvelles sessions partent avec le nouveau profil.

## Intégration conservée / limites restantes

Cockpit crée une branche et un worktree par tâche, reçoit le texte et les appels outils, joint les captures produites et relève l'état Git sans appel modèle. Les droits et la publication Deployer restent inchangés. Claude utilise désormais le dialogue natif bidirectionnel `stream-json` (`--permission-prompt-tool stdio`). Les questions `AskUserQuestion` et demandes de permission sont affichées dans le compositeur ; une réponse repart dans le processus en cours, sans nouveau lancement ni changement de session. Les choix simples/multiples, réponses libres et refus sont conservés dans le fil. Le serveur valide la demande encore en attente ; une autorisation ne modifie jamais les droits persistants. Les restrictions explicites de publication restent prioritaires. Les annulations natives suppriment la demande ; après arrêt/redémarrage, les demandes périmées ne sont plus actionnables. Claude ne doit plus produire de marqueur textuel et ses réponses ne sont plus découpées sur ces marqueurs. Compatibilité historique conservée pour Codex/OpenClaw.

Les limites existantes sont inchangées : 30 min/exécution, 10 exécutions/tâche, 5 $ estimés/exécution et 20 $ estimés/tâche, parallélisme réglable. Ce ne sont pas des limites natives de l'abonnement Claude.

## Codex

`codex exec --json` puis `codex exec resume <id>` ; bac à sable `workspace-write` (lecture seule pour un plan), sans réseau ni
recherche web, jamais `--dangerously-bypass-approvals-and-sandbox`. `CODEX_HOME` **dédié** (`~/.cockpit/codex-home`, ou
`COCKPIT_CODEX_HOME`), refusé s'il est dans un dossier de projet. Codex ne lit pas `CLAUDE.md` : son contenu est joint à la
première demande. Il ne peut pas écrire dans `.git` : pas de commit, ses changements apparaissent « non commités ».
Seuls les compteurs exposés par Codex sont affichés (coût et appels : jamais inventés).

**Connexion (une fois, par code d'appareil)** : définir `COCKPIT_CODEX_HOME` si besoin, puis lancer
`CODEX_HOME=<ce dossier> codex login --device-auth` et saisir le code sur la page affichée avec le compte ChatGPT.
`COCKPIT_CODEX_BIN` : chemin de `codex` (ou de son `codex.js`).

## Vérification

`npm test` utilise de faux binaires sans quota modèle. Les scénarios couvrent session stable, demande sans surcouche, capacités non désactivées, héritage de configuration, mises à jour, protection des fichiers suivis/retouchés, publication et pièces jointes.

Référence du protocole : https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py (transport natif, aucune dépendance ajoutée).

Un essai réel supplémentaire peut utiliser une instance temporaire du service Projets, un dépôt local et une tâche jetables, sans dépôt GitHub ni déploiement externe. Supprimer ensuite état, dépôt, worktree et session Claude du test, sans toucher aux projets réels.

## Catalogue natif des modèles (2026-11-14)
Le sélecteur Cockpit lit désormais `initialize.models` du CLI réellement lancé, dans le même compte OAuth. Il utilise `resolvedModel` plutôt que de figer trois choix. Métadonnées mises en cache une heure ; lecture à l'ouverture de Projets et après expiration, sans requête modèle ni consommation de quota. Si le CLI ne répond pas, les trois choix historiques servent de secours ; le modèle déjà choisi d'un projet reste sélectionnable même absent du catalogue. Aucun défaut ou session existant n'est modifié. Les CLI CT104/CT113 ont été actualisés 2.1.295 → 2.1.325.
Les corrections d'intégration doivent être poussées dans la branche canonique GitHub avant publication : un simple commit local détaché est remplacé lors du prochain déploiement et ne suffit pas. Le commit natif 3e49d87 perdu lors d'un déploiement de tâche a été réintégré puis publié dans la branche canonique en même temps que cette correction.
