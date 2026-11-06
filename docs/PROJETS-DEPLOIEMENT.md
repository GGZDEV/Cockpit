# Projets : création, copie locale, développement, déploiement

Un projet Cockpit suit un chemin unique : **créer → copie locale → développer (Claude Code) → déployer**. Cockpit ne déploie rien lui-même :
il enregistre le projet auprès du **service de déploiement** (CT 113 `deployer`, API HTTP JSON sur le réseau local) et affiche son état.
Le service clone le dépôt depuis GitHub, teste, construit, publie, vérifie la santé du site et revient en arrière si elle échoue.

```
Cockpit (ce PC) ──PUT /projects/<id>──────────► service de déploiement (192.168.1.236:8080)
   │  bouton « Déployer » ──POST …/deploy──────►  clone GitHub → tests → build → publication → contrôle de santé
   │  état, journal court ◄──GET /projects/<id>──  (retour arrière automatique si la santé échoue)
   └─ copie locale ──git push──► GitHub ◄── sondage chaque minute (mode automatique)
```

Le contrat de l'API est écrit par le service (`deployer/CONTRAT.md`, version 1). Cockpit n'utilise que : `GET /health`, `PUT` / `GET /projects/<id>`,
`POST /projects/<id>/deploy`, `GET /projects/<id>/subdomain` et `…/subdomain/approve`. Les routes `rollback` et `DELETE` ne sont pas appelées.

## Réglages du serveur Cockpit (variables d'environnement)

| Variable | Rôle | Défaut |
|---|---|---|
| `COCKPIT_DEPLOYER_TOKEN` | jeton d'API du service (**obligatoire** pour déployer) | aucun : le bouton est désactivé et le dit |
| `COCKPIT_DEPLOYER_URL` | adresse du service | `http://192.168.1.236:8080` |
| `COCKPIT_GITHUB_TOKEN` | facultatif : jeton transmis au GitHub CLI (`gh`) pour créer un dépôt, si `gh` n'est pas déjà connecté (`gh auth login`) | aucun |
| `COCKPIT_PUBLIC_DOMAIN_SUFFIX` | seul suffixe accepté pour un nom public | `.ggz.ovh` |
| `COCKPIT_WORKSPACES` | dossier des copies locales (déjà existant) | dossier parent de Cockpit |

À définir comme variables d'environnement de l'utilisateur sur le PC où tourne Cockpit, puis relancer Cockpit. Le jeton n'est lu que par le serveur : il ne
figure ni dans l'interface, ni dans `data/projects.json`, ni dans les journaux, ni dans les messages d'erreur (ils sont expurgés avant affichage). Le jeton
du service est dans `/etc/deployer/api-token` sur le CT 113 ; ne le copiez pas dans un dépôt.

## Ce que l'utilisateur voit

- **Formulaire de projet → « Déploiement »** : URL de déploiement (`https://…` obligatoire), case « Déploiement automatique » (décochée par défaut)
  et branche de production (`main`). Le type et ses réglages ne sont plus demandés : la recette est préparée une seule fois dans le service
  (même dépôt GitHub) et Cockpit la reprend telle quelle, contrôle de santé compris. Sans recette, le projet reste « à compléter ».
- **« Clore la tâche »** : si la branche de la tâche (`cockpit/<code>-…`) a des commits, Cockpit (un programme, sans agent) la fusionne dans la
  branche de production de la copie locale puis la pousse sur GitHub. Seuls les commits partent : une modification non committée du worktree
  (souvent un fichier réécrit par les tests) est laissée de côté et signalée. Refusé sans rien toucher si la copie locale a des modifications
  non committées, si `main` a divergé de GitHub ou en cas de conflit. Le déploiement suit ensuite : automatique, ou bouton « Déployer ».
- **Bloc « Déploiement » du projet** (tableau et fiche) : lien vers l'URL, mode, dernier déploiement (**en attente / en cours / réussi / échoué / revenu en arrière**),
  commit, étape, message, **journal court** (40 lignes), boutons **Déployer** (devient **Redéployer** en mode automatique) et **Actualiser**.
  Désactivé avec la raison écrite à côté si l'URL, le dépôt ou le type manquent, si le service n'a pas de jeton, ou si un déploiement est en cours.
- **Erreurs** : service injoignable, délai dépassé, jeton refusé, réglages refusés (message du service), déploiement déjà en cours : chacune a un message en français.
  Un projet non enregistré affiche la raison et un bouton **Réenregistrer** ; une panne passagère est réessayée toutes les minutes.
- **Nom public** : si le service attend l'accord de l'utilisateur, le bouton **« Valider la mise en ligne publique de x.ggz.ovh »** apparaît ; il demande une
  confirmation, vérifie que le nom correspond à celui du service, puis appelle `subdomain/approve`. C'est le seul chemin vers cet appel. Cockpit ne touche ni au DNS ni au proxy.

## Créer un projet

1. **À partir d'un dépôt existant** : comme avant (clone dans le dossier des projets, `CLAUDE.md` court généré). Le déploiement est facultatif et se règle plus tard.
2. **Projet neuf** (« Créer le dépôt GitHub… ») : Cockpit crée le dépôt (**privé** sauf case « Dépôt public »), le clone, écrit `README.md` et `.gitignore`,
   fait le premier commit et le pousse, prépare le `CLAUDE.md`, puis enregistre le projet auprès du service. L'avancement s'affiche dans le projet ; chaque étape
   est reprenable avec **Réessayer** (le dépôt n'est jamais recréé, un fichier existant jamais écrasé, un commit jamais refait).

Capacités GitHub : Cockpit n'a **aucun identifiant GitHub propre**. Le clone et les `git push` utilisent les accès Git déjà enregistrés sur le PC. La création d'un
dépôt passe par le **GitHub CLI** (`gh`, argument en tableau, sans shell), connecté sur le PC ou alimenté par `COCKPIT_GITHUB_TOKEN`. Sans `gh` ou sans droit « repo »,
le projet est créé quand même, l'interface dit précisément ce qui manque, et « Réessayer » reprend après correction. Le push exige aussi une identité Git (`user.name`,
`user.email`) et un accès en écriture (`gh auth setup-git`) sur le PC ; leur absence est expliquée de la même façon.

## Données (rétrocompatibles)

Ajouts sur un projet, tous facultatifs ; un projet sans ces champs se lit avec les valeurs par défaut et n'est jamais migré ni écrit :

- `deployment` : `{ url, auto, branch, type, config, buildCmd, testCmd, publicDomain, publicUpstream }` (réglages saisis, validés).
- `deployState` : `{ slug, registered, last, subdomain, checkedAt, error }` (état relu auprès du service ; jamais de secret).
- `bootstrap` : `{ status, step, error, request }` (création d'un projet neuf).

L'identifiant côté service (`slug`) vient du nom du projet, est figé à la première réussite et ne reprend jamais un projet du service qui pointe vers un autre dépôt.

## API de l'interface (`/api/projects/…`)

| Route | Effet |
|---|---|
| `GET deploy-config` | service configuré/joignable, GitHub utilisable (aucun secret) |
| `POST projects` / `PATCH projects/<id>` | corps : `deployment`, et `newRepository: { name?, owner?, private? }` à la création |
| `GET projects/<id>/deploy` | relit l'état auprès du service |
| `POST projects/<id>/deploy` | déploiement manuel ; `202 { project, warnings }` (avertissement si des commits locaux ne sont pas sur GitHub) |
| `POST projects/<id>/deploy-register` | (ré)enregistre auprès du service |
| `POST projects/<id>/deploy-public` | `{ name }` : accord sur le nom public |
| `POST projects/<id>/bootstrap` | relance la création d'un projet neuf |

L'accès des agents (`/agent/v1/`) ne reçoit que la **lecture** (`deploy`, `newRepository` dans `state`) ; déployer, activer l'automatique, régler un déploiement ou valider
un nom public leur est refusé (403). La compétence OpenClaw générée (`npm run agents:openclaw-skill`) le dit.

## Mode automatique

Cockpit enregistre `auto: true` ; le service sonde GitHub chaque minute et déploie quand la branche de production reçoit un nouveau commit. Cockpit relit l'état
(toutes les minutes en tâche de fond, toutes les 15 s pendant un déploiement). **Les moteurs directs ne poussent jamais** (règle du `CLAUDE.md`) : une tâche terminée ne
déclenche donc un déploiement qu'une fois son commit arrivé sur la branche de production de GitHub (fusion et push faits par l'utilisateur).

## Retour arrière de cette fonctionnalité

- Avant fusion : revenir à la branche de production avec `git checkout main`.
- Après fusion : `git revert` des commits de la branche. Les champs ajoutés (`deployment`, `deployState`, `bootstrap`) sont simplement ignorés par l'ancienne version ; aucun
  fichier de données n'est transformé.
- Côté service : les projets enregistrés restent connus du service ; `DELETE /projects/<id>` (non utilisé par Cockpit) les retire sans toucher aux fichiers déployés.
- Retour arrière d'un **déploiement** : automatique si la santé échoue (statut « revenu en arrière ») ; manuel via `POST /projects/<id>/rollback` du service (pas de bouton dans Cockpit).

## Tests

`tests/deployer-client.test.js`, `tests/project-deploy.test.js`, `tests/project-bootstrap.test.js`, `tests/projects-ui-deploy.test.js` : faux service conforme au contrat
(`tests/helpers/fake-deployer.js`), vrai Git local pour la création, aucun réseau réel. Lancer un seul fichier : `node --test tests/project-deploy.test.js`.
