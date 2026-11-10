# Moteurs directs : Claude Code et Codex (sans OpenClaw)

Une tâche de projet part **directement** vers Claude Code (par défaut) ou Codex sur ce PC. OpenClaw reste un moteur au choix,
inchangé, pour les projets et tâches qui l'utilisent déjà. Objectif : le moins de jetons possible, sans baisse de qualité.

## En une page

| | Avant (harnais, branches abandonnées) | Maintenant |
|---|---|---|
| Déroulé | analyse → plan modifiable → validation → exécution → vérifications → reçu | **un message part, le moteur travaille, Cockpit relève les faits Git** |
| Sessions | plusieurs appels obligatoires par tâche | **une session par tâche**, reprise à chaque message (`--resume`) |
| Consignes du projet | prompt système ajouté + rappelées dans chaque demande | **un `CLAUDE.md` court et stable** dans le dossier (il est mis en cache par Claude) |
| Plan | toujours | **option par tâche**, désactivée par défaut |
| Demande envoyée | contrat complet (cadre, publication, contexte) | titre + consignes + résultat attendu + critères (**~120 jetons** pour la tâche mesurée) |

## Ce qui se passe pour une tâche

1. Clic sur **Lancer** (rien ne démarre sans ce clic). Cockpit vérifie le dépôt (copie locale prête, sous le dossier des projets,
   racine Git, pas de lien symbolique), puis crée **un worktree et une branche par tâche** (`cockpit/<code>-<id>`), à côté
   de la copie principale qui n'est jamais modifiée. Le `CLAUDE.md` du projet y est copié.
   **Préparation** (`task-env.cjs`, dans le suivi asynchrone : la réponse du lancement n'attend pas, chaque étape s'affiche dans la
   chronologie, « Arrêter » l'interrompt) : dépendances installées si `node_modules` manque — `npm ci --no-audit --no-fund --prefer-offline`
   avec `package-lock.json`/`npm-shrinkwrap.json`, `pnpm`/`yarn` s'ils sont installés (sinon signalé), `npm install --no-save
   --no-package-lock` sans verrou (rien d'écrit dans le dépôt) — puis **tests de départ** (`npm test`, 10 min au plus) une seule fois par
   commit de départ, si `scripts.test` n'est pas le texte par défaut de npm : `task.direct.baseline = { sha, at, ok, passed, failed, total, summary }`.
   Un fichier suivi réécrit par ces tests est remis en état. Sans shell, environnement filtré, sortie tronquée et caviardée.
   Une nouvelle session reçoit les sections « Environnement préparé » (échecs existants signalés comme tels) et « Vérification ».
   **Vérification visuelle** : `node <Cockpit>/scripts/visual-check.cjs [--path /…] -- <commande du serveur>` (ou `--url`) démarre le serveur
   du projet sur un port libre (`PORT`), attend qu'il réponde, vérifie `MemAvailable` (≥ 350 Mo, sinon abandon propre), puis capture chaque chemin
   l'un après l'autre avec Chromium headless (`/usr/bin/chromium` ou `COCKPIT_CHROMIUM`) en mobile 390×844 (iPhone) et bureau 1440×900 ; serveur,
   Chromium et profils temporaires sont toujours supprimés ; sortie JSON. Cette commande est autorisée à Claude même avec une liste de commandes
   restreinte. Cockpit fournit `COCKPIT_VISUAL_DIR` propre à l'exécution, joint ensuite les PNG à la tâche (8 au plus, 5 Mo chacun) et supprime le dossier.
   Avec `--inspect` (implicite dès qu'une étape est donnée), Chromium est piloté par le protocole DevTools (WebSocket de Node 22+, sans dépendance) :
   sortie `console` (exceptions JavaScript, `console.error`, ressources en erreur), `overflow` (pixels de débordement horizontal et éléments fautifs,
   noté de nouveau seulement s'il change), et étapes `--click <sélecteur>`, `--type <sélecteur>=<texte>`, `--eval <js>` (10 au plus) rejouées dans
   l'ordre, chacune suivie d'une capture `<page>-<vue>-etapeN.png`. Une étape en échec est listée dans `errors` et rend `ok` faux.
2. `claude -p …` est lancé **sans shell** (arguments en tableau, demande sur l'entrée standard) dans ce worktree.
3. À la fin : résultat (ligne `STATUT:` facultative : `BLOQUÉ` = question, `ÉCHEC`), puis relevé Git fait par Cockpit sans jeton
   (branche, fichiers, commits, changements non commités), compteurs (jetons, appels, durée, coût estimé).
4. Chaque message suivant **reprend la même session** : `Suite (CO-3) : …`, sans renvoyer les consignes.
   Les pièces jointes ne sont listées qu'une fois par session. Session perdue → nouvelle session avec les consignes complètes
   et une note « reprise » (le worktree et ses modifications sont conservés).
5. **Arrêter** (bouton pendant l'exécution) arrête le processus et ses enfants ; session et dossier restent.
   Reprise à la main : `cd <worktree>` puis `claude --resume <id>` (affiché dans les détails de l'exécution).

Plan préalable (case « Plan d'abord » d'une tâche) : première exécution en lecture seule (`--permission-mode plan`, outils
Read/Glob/Grep), le plan s'affiche, puis « Exécuter le plan » (même session, mode normal) ou « Réviser le plan » (remarque,
reste en lecture seule). Aucune approbation enregistrée, aucun reçu. *Cette option n'a été éprouvée qu'avec le faux binaire.*

## Profil léger de Claude Code (vérifié avec `claude --help`, version 2.1.295)

| Option | Effet |
|---|---|
| `-p --output-format stream-json --verbose` | non interactif, flux lu ligne à ligne |
| `--tools Read,Glob,Grep,Edit,Write,Bash` | seuls outils exposés (pas d'agents, d'outils différés, de web sauf demande) |
| `--disable-slash-commands` | aucune compétence (liste de ~7 k jetons évitée) |
| `--strict-mcp-config` | aucun serveur MCP |
| `--settings '{"autoMemoryEnabled":false,"disableAllHooks":true,"includeGitInstructions":false,"enabledPlugins":{}}'` | ni mémoire automatique, ni hooks, ni instructions Git intégrées, ni plugins |
| `--exclude-dynamic-system-prompt-sections` | dossier/date/état Git déplacés hors du prompt système : meilleur partage du cache entre worktrees |
| `--permission-mode acceptEdits` + `--allowedTools` (liste du projet) | modifications permises, commandes de la liste seulement (`git`, `npm test`, `node --test`…) ; les commandes en lecture seule passent d'office |
| `--disallowedTools` | `git push`, `git remote`, `gh`, `npm publish`, `curl`, `wget`, `ssh`, `scp`, `rsync` toujours refusés |
| `--model claude-sonnet-5-5` | **Sonnet 5.5 par défaut**, réglable par projet puis par tâche |
| `--max-budget-usd` | plafond de sécurité par exécution (estimation de Claude) |
| `--session-id <uuid>` / `--resume <uuid>` | une session par tâche |

Non utilisés, volontairement : `--bare` (ignore la connexion par abonnement), `--dangerously-skip-permissions`,
`--append-system-prompt` (les règles sont dans `CLAUDE.md`). Les options récentes (`--settings`, `--max-budget-usd`,
`--exclude-dynamic-system-prompt-sections`, `--effort`) sont **retirées automatiquement** si `claude --help` ne les connaît pas.
Pour Windows : `COCKPIT_CLAUDE_BIN` = chemin de `claude.exe` (un `.cmd` est refusé, il imposerait un shell).

## Création d'un projet côté Claude Code

Claude Code n'a pas d'objet « projet » : **un projet = un dossier de code + un `CLAUDE.md` + des sessions rangées par dossier.**
Quand Cockpit clone le dépôt d'un projet (ou en retrouve la copie locale), il :

1. analyse le dépôt **sans IA** (`project-claudemd.cjs`) : `package.json`/lockfile, `pyproject`, `Cargo.toml`, `go.mod`, Makefile…
   → pile, commande de tests, dossiers, indentation, linter ;
2. écrit un `CLAUDE.md` de ~1 800 caractères (≈ 550 jetons) : objectif et consignes du projet, pile, commandes, conventions et
   **règles de sortie plafonnée** (lecture par plages, `| tail -30`, `git diff --stat`, tests ciblés puis suite une fois, réponse
   courte, `STATUT: BLOQUÉ/ÉCHEC`) ;
3. l'exclut de Git localement (`.git/info/exclude`) : jamais commité par accident ;
4. ne touche **jamais** un `CLAUDE.md` du dépôt, ni un fichier généré puis retouché à la main ; « Régénérer » (fiche du projet)
   ne réécrit que le fichier non retouché.

Chaque tâche ouvre ou reprend sa session dans **son worktree** (les sessions de Claude sont rangées par dossier, donc une par tâche) ;
le `CLAUDE.md` y est copié à la création. Le fichier reste court et stable : le modifier en cours de tâche casserait le cache.
Le projet est créé par l'interface ou par un agent (`POST projects` : sans `agent`, moteur Claude Code ; avec `agent`, moteur
OpenClaw comme avant).

## Mesure réelle (une tâche, Sonnet 5.5, n = 1)

Tâche « logo dans le header », même commit `9a09d21` que les essais précédents : **162 124 jetons** (10 appels, 50 s, socle au 1er appel
7 127), contre 168 413 pour Claude Code lancé à la main, 315 671 pour Cockpit via OpenClaw (config optimisée) et 329 441 avant
optimisation. Modèle relevé dans le journal de session : `claude-sonnet-5-5` pour les 10 appels. Détail, méthode et limites :
`benchmarks/cockpit-direct-2026-11-03/RAPPORT.md` (dans l'espace de travail OpenClaw).
Sans appel d'API (faux serveur local), la première requête pèse 18,7 k caractères avec ce profil, contre 24,5 k avec seulement
`--tools` + `--disable-slash-commands`, et 69,5 k pour `claude -p` « tel quel » (20 outils, liste de compétences).

## Choix du moteur

- Projet : **Claude Code** (défaut des nouveaux projets), Codex ou OpenClaw. Tâche : « Celui du projet » ou un autre.
- Un projet ou une tâche d'**avant** (aucun moteur enregistré) reste sur OpenClaw. Une tâche engagée ne change plus avec le projet.
- Changer le moteur d'une tâche déjà travaillée ouvre une nouvelle session, avec un court rappel (dernier résultat, `git status`).
- **Secours automatique** (réglage du projet, aucun par défaut) : seulement si le moteur a échoué **avant tout travail** (quota,
  authentification, service, binaire) et que le worktree est strictement identique avant/après. Sinon : décision humaine.

## Limites et budgets (réglages du projet, valeurs par défaut)

Délai 30 min (arrêt de toute l'arborescence), 10 exécutions par tâche, 5 $ par exécution et 20 $ par tâche (estimations de Claude ;
la reprise d'une session annonce un coût cumulé, Cockpit en retire la part déjà comptée), 2 exécutions simultanées sur le PC, tous moteurs confondus (chacune porte un
processus du moteur, ses installations et ses tests, et consomme le quota de l'abonnement ; `COCKPIT_MAX_PARALLEL=1` à `8` + relancer pour changer).

## Codex

`codex exec --json` puis `codex exec resume <id>` ; bac à sable `workspace-write` (lecture seule pour un plan), sans réseau ni
recherche web, jamais `--dangerously-bypass-approvals-and-sandbox`. `CODEX_HOME` **dédié** (`~/.cockpit/codex-home`, ou
`COCKPIT_CODEX_HOME`), refusé s'il est dans un dossier de projet. Codex ne lit pas `CLAUDE.md` : son contenu est joint à la
première demande. Il ne peut pas écrire dans `.git` : pas de commit, ses changements apparaissent « non commités ».
Seuls les compteurs exposés par Codex sont affichés (coût et appels : jamais inventés).

**Connexion (une fois, par code d'appareil)** : définir `COCKPIT_CODEX_HOME` si besoin, puis lancer
`CODEX_HOME=<ce dossier> codex login --device-auth` et saisir le code sur la page affichée avec le compte ChatGPT.
`COCKPIT_CODEX_BIN` : chemin de `codex` (ou de son `codex.js`).

## Activation

Les moteurs directs sont **actifs par défaut** dans ce code ; rien n'est basculé tout seul :
projets et tâches existants restent sur OpenClaw (tant qu'on ne change pas leur « Moteur des tâches »), seuls les **nouveaux** projets
partent sur Claude Code. Pour activer sur le PC : fusionner la branche, relancer Cockpit, vérifier que `claude` est dans le PATH
(`claude --version`), ouvrir un projet → « Moteur des tâches ».

## Revenir en arrière

- **Sans toucher au code** : variable d'environnement `COCKPIT_DIRECT=0` + relancer → plus aucun moteur direct, tout repasse par OpenClaw.
- **Par projet** : « Moteur des tâches » → OpenClaw ; **par tâche** : « Plus d'options → Moteur ».
- **Retour complet** : ne pas fusionner `feature/direct-claude` (ou `git revert` des commits de la branche). Les données restent lisibles :
  les champs ajoutés (`engine`, `direct`, `claudeMd`, `planFirst`, `model`) sont ignorés par l'ancienne version.
- Nettoyage éventuel : `git worktree list` puis `git worktree remove <dossier>` pour les worktrees de tâches (sous
  `<projets>/.cockpit-worktrees/`), `git branch -D cockpit/<code>-<id>` ; ligne `/CLAUDE.md` dans `.git/info/exclude`.

## Sécurité (inchangée par rapport à l'ancien harnais)

Aucun shell ; environnement du moteur sans variable ressemblant à un secret (jeton GitHub, clés API) — seule la connexion par
abonnement est conservée ; les clés API Anthropic/OpenAI sont retirées ; sorties, erreurs et journal masqués (`sk-…`, `ghp_…`,
`Bearer …`, `password=…`) ; aucun `auth.json` lu ; chemins validés (pas de `..`, pas de lien symbolique) ; pas de push,
de publication ni de déploiement par les moteurs directs (la procédure « Publication » d'un projet ne concerne que OpenClaw).

## Tests

`npm test` (tests avec faux binaires `tests/fixtures/fake-claude.js` et `fake-codex.js` : aucun jeton, aucun réseau).
