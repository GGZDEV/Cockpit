# OpenRadio dans Applications

Hébergement : **CT113 application, 192.168.1.236**, pas CT114/OpenClaw.
Adresse : `https://openradio.ggz.ovh`, protégée par la connexion Cockpit.

La recette `application.json` épingle la source OpenRadio à un commit complet ; `Dockerfile` construit Next.js, Compose démarre l'image `${APP_IMAGE}` sur le port 3100. Aucun abonnement ni clé IA n'est activé.

Après validation de la demande utilisateur, depuis Cockpit :

```
node scripts/applicationctl.cjs register-app openradio deploy/openradio/application.json
node scripts/applicationctl.cjs domain openradio openradio.ggz.ovh
node scripts/applicationctl.cjs deploy-app openradio
node scripts/applicationctl.cjs status openradio
```

Deployer récupère la recette publiée sur GitHub, construit l'image et vérifie le service. Son retour arrière relance la recette au commit précédent en conservant les volumes. La source ne doit être mise à jour qu'en changeant explicitement le commit épinglé après essais.

Cockpit sert le nom dédié via `COCKPIT_OPENRADIO_HOST=openradio.ggz.ovh` et `COCKPIT_OPENRADIO_UPSTREAM=http://192.168.1.236:3100` ; ce nom figure dans `COCKPIT_ALLOWED_HOSTS`. La page `/openradio.html` du dock ouvre l'installation. Les identifiants Cockpit ne sont jamais transmis à OpenRadio.

La santé HTTP ne suffit pas : vérifier aussi recherche, liste de stations et tentative de lecture. Certaines stations peuvent être indisponibles ou utiliser des flux HTTP bloqués depuis une page HTTPS ; ne pas confondre cela avec une panne du lecteur.

Voir [le fonctionnement commun](../../docs/APPLICATIONS.md) pour les projets présents et futurs.
