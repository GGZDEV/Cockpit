# État de la reprise — 30 octobre 2026

Les projets initiaux restent conservés. Le fonctionnement retenu pour les essais est : services sur ce PC, interface tablette publiée à l’adresse habituelle dans Home Assistant. L’installation d’un service permanent sur Proxmox est reportée à la demande de l’utilisateur.

## Corrections de l’affichage et des réglages

- Le module Pièces reprend la grille du premier design : deux colonnes à largeur 2, nom et état des lampes, température, bouton d’éclairage, moyenne et Tout éteindre. Le groupe Autres reste accessible dans l’onglet de détail et sélectionnable dans les réglages du module ; il n’est pas imposé dans le résumé.
- Les dimensions, l’ordre et la disposition restent indépendants de la couleur du thème.
- Cocher un appareil dans les réglages désactive la sélection automatique. La sélection multiple est enregistrée, relue après rechargement et utilisée par les rendus et commandes. Une sélection manuelle vide reste vide.
- Le mode démo et ses données ne sont plus chargés. Les listes de démarrage fictives ont été retirées. Un service non connecté affiche un état vide ou son erreur réelle.

## Fonctions Cockpit réintégrées

Les composants complets de Cockpit, avec leurs contrôleurs, sont intégrés dans les modules Cockpit. Les données restent gérées par le backend Cockpit existant. Le lanceur Cockpit démarre ce backend en arrière-plan si nécessaire, avec son environnement Electron habituel pour conserver l’accès à ses identifiants enregistrés.

| Module | Fonctions reprises |
| --- | --- |
| RSS | Recherche, catégories, non lus, favoris, mots-clés inclus/exclus, visuels, résumés IA, regroupements, tendances, sauvegarde dans les collections et réglages des sources/OPML/Feedly. |
| Spotify | Commandes, progression, paroles, appareils Connect, historique, favoris et reconnexion. Les autorisations du compte Spotify restent nécessaires pour les fonctions correspondantes. |
| Système | Catalogue original des mesures et courbes, réseau, disque, disponibilité des capteurs et réglages des mesures. Les températures/FPS non exposés par le PC restent indiqués indisponibles. |
| Quotas IA | Configuration des abonnements, découverte et actualisation selon les capacités du backend existant. |
| Agents | Interface complète : connexions, contacts, conversations, modèles, pièces jointes, messages, réponses et files d’attente gérées par le contrôleur d’origine. |
| Collections, tâches, calendrier | Composants originaux avec les commandes d’édition fournies par Cockpit, et non une simple copie locale des données. |
| Météo par ville | Composant Cockpit distinct de la météo HA, avec recherche de lieu. |

Les réglages complets Cockpit sont accessibles depuis les paramètres Cockpit. Les préférences de ses nouveaux composants sont incluses dans l’export Cockpit et la synchronisation du compte HA. Les préférences locales de l’ancienne interface Cockpit sur une autre origine navigateur ne sont pas importées automatiquement.

## Fonctions Home Assistant reprises

- Pages distinctes par pièce, reprise des agencements personnalisés originaux, notes, dimensions, portée et choix d’appareils.
- Gestion de l’ordre et de la visibilité des pièces, noms personnalisés ; copie des autres pages originales depuis les paramètres.
- Réglages des seuils de température, regroupement par capteur/pièce, vues de calendrier, directions des transports, caméra et filtres Proxmox.
- Météo selon les dimensions du module, prévisions horaires/quotidiennes et détail agrandi.
- Calendriers filtrés selon les entités choisies ; événements et informations trafic du rendu d’origine.
- Listes de courses/tâches HA (Bring et autres entités todo), avec ajout et changement de statut.
- Lecteur HA et bibliothèque multimédia, sélection de source, lecture et volume.
- Caméras : flux via HA ou image périodique, cadrage et vue agrandie.
- Tableaux Proxmox à partir des registres, avec boutons de commande des machines.
- Mises à jour : versions, notes, sélection, sauvegarde si disponible et file d’installation.
- Rendu incrémental repris de Cockpit pour préserver les éléments, le focus et les composants déjà chargés.

Dispositions, notes et préférences Cockpit sont sauvegardées dans une clé du compte HA séparée : `metaboard_dashboard_v1`. La clé originale `maison_dashboard` n’est pas réécrite. Une autre session reçoit les changements lorsqu’elle est connectée et qu’aucun réglage ou champ n’est en cours d’édition. Des modifications simultanées sur deux appareils utilisent la dernière sauvegarde ; il ne s’agit pas d’un éditeur collaboratif avec fusion des conflits.

## Accès tablette pendant les essais sur PC

La page conserve son URL sous `/local/maison/metaboard/index.html`. Le relais du PC écoute sur son adresse du réseau local, port 3889. Il vérifie la session auprès de Home Assistant et réserve les services Cockpit aux comptes administrateurs HA. Le jeton HA ne passe pas dans les URL, les fichiers publiés ou les requêtes vers Cockpit. Le service local PC conserve ses restrictions d’origine et de routes.

Le PC et Cockpit doivent être actifs pour le RSS, les agents, Spotify et les mesures PC. Les modules maison continuent à communiquer directement avec HA. Le démarrage après un redémarrage Windows se fait par le lanceur Cockpit ; aucune tâche Windows de démarrage automatique n’a été créée.

## Limites et vérifications

- Les fonctions avancées ont été rebranchées ; cela ne signifie pas qu’une installation de mise à jour HA, une commande de VM ou une lecture caméra personnelle a été déclenchée pour les tester. Aucune commande réelle à la maison, à une VM ou à un agent n’a été envoyée durant la vérification.
- Les essais visuels portent sur les vraies données Cockpit du PC. La sélection des appareils HA, les registres et l’import des dispositions sont aussi vérifiés par des tests avec des données de contrôle.
- Le relais est testé pour le contrôle d’origine, le rôle administrateur, le transfert et le refus des requêtes non authentifiées. La connexion depuis la tablette physique nécessite sa session HA.
- Une connexion agent déconnectée ou un abonnement expiré doit être reconnecté dans ses réglages réels. Le prototype ne fabrique pas de valeurs pour les remplacer.
- L’enveloppe Windows comporte maintenant des contrôles de panneau gauche/droit, premier plan, AppBar, masquage, zone de notification et notifications des agents sur activation. Les gestes et interactions Windows natifs restent à valider sur cette version. Il n’y a pas de nouvel installateur autonome livré.
- L’extension Brave reste chargée localement, sans publication dans le magasin.
- Les dispositions automatiques des pièces sont conservées à leur première ouverture ; leur régénération après ajout d’appareils demande encore une réinitialisation de la vue.

## Sources

Cockpit : `js/app.js`, `layout.js`, `model.js`, `modules.js`, `morph.js`. Cockpit : `public/app.js`, `dashboard.js`, `agents.js`, `ai-usage.js`, `widgets/*`, `server.js`, `electron.js`, `appbar.js` et `preload.js`. Les adaptations sont dans `public/integrations/feedme`, `feedme-components.js`, `native-renderers.js`, `rooms.js`, `data.js`, `module-settings.js`, `ha-actions.js`, `account-sync.js` et `relay.cjs`.
