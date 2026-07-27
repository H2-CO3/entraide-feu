# Tests fonctionnels — Entraide Feu

Plan de test manuel couvrant toutes les features. Chaque scénario est autonome,
avec ses acteurs, ses étapes et ses résultats attendus (cases à cocher).

## Combien d'utilisateurs ?

**4 identités navigateur + 1 session admin** couvrent 100 % de la logique :

| Identité | Rôles joués | Comment l'obtenir |
|---|---|---|
| **A** | Émetteur de besoin, demandeur refuge, signaleur 1 | Navigateur normal, appareil 1 |
| **B** | Dépanneur (alertes + j'arrive + position), signaleur 2 | Navigateur normal, appareil 2 (Android idéal : push natif) |
| **C** | Hébergeur (refuge), 2ᵉ dépanneur, signaleur 3 | Fenêtre privée ou 3ᵉ appareil (iPhone idéal : cas PWA) |
| **D** | Auteur de la fiche à signaler, spectateur anonyme | Fenêtre privée jetable |
| **Admin** | Modération, zones, import, points officiels | `/admin.html` + clé (console serveur ou `data/admin_key.txt`) |

Le minimum **dur** est fixé par le masquage à 3 signalements distincts (S11) : il
faut 3 identités qui signalent + 1 auteur = 4. Tout le reste se joue à 2.
**En pratique : 2 humains suffisent** (chacun 1 navigateur + 1 fenêtre privée),
mais pour les notifications push il faut de vrais appareils :
1 Android (push direct), 1 iPhone (push après « Sur l'écran d'accueil »), 1 desktop.

**Avant de commencer** : `npm run purge:all` (garde les points officiels), serveur
démarré, et chaque testeur vide les données du site (ou fenêtre privée neuve).

---

## S1 — Onboarding (A, B, C, D)
1. Ouvrir l'app dans un navigateur vierge.
2. Parcourir les 5 écrans ; à l'écran prénom, tenter « Continuer » sans prénom.
3. Cliquer une profession, la re-cliquer, en choisir une autre.
4. Terminer par un des 3 gestes (varier selon l'identité).

- [ ] Le disclaimer sécurité (18/112 + satellites NASA) est à l'écran 2.
- [ ] Impossible de passer l'écran 3 sans prénom (message clair).
- [ ] Une profession se désélectionne au re-clic.
- [ ] L'écran final propose bien 3 gestes + « juste voir la carte ».
- [ ] Au refresh, l'onboarding ne réapparaît pas ; 👤 → « Revoir l'introduction » le rejoue.
- [ ] Cookie `fid` HttpOnly posé (DevTools → Application).

## S2 — Émettre un besoin complet (A)
1. « Lancer un SOS » → catégorie Matériel, titre, message public,
   **partie privée** (ex : « code portail 1234 »), photo, vocal ≤ 60 s.
2. Déplacer la carte sous le repère central, valider.
3. Noter le **code de clôture** affiché ; activer « me prévenir ».

- [ ] Photo recompressée (< 500 Ko dans l'onglet réseau) et vocal lisibles sur la fiche.
- [ ] Le pin apparaît chez B/C/D en ≤ 30 s (polling) avec la bonne icône.
- [ ] La photo ne contient plus de GPS EXIF (vérifier avec un lecteur EXIF).
- [ ] « Besoin d'aide » devient « 📋 Mon SOS (suivi) » chez A.

## S3 — Alertes dépanneur (B, puis C hors rayon)
1. B : « Je dépanne » → cocher Matériel, rayon couvrant le besoin de A, notifications ON.
2. C : idem mais position/rayon NE couvrant PAS la zone (ou catégorie Médical seule).
3. A émet un nouveau besoin Matériel dans le rayon de B.

- [ ] B reçoit un push (app fermée sur Android) qui ouvre la fiche au tap.
- [ ] C ne reçoit rien (hors rayon / mauvaise catégorie).
- [ ] Le bouton « Je dépanne » a disparu chez B ; réglages accessibles via 👤.
- [ ] 👤 → « Ne plus être disponible » fait réapparaître le bouton.
- [ ] Stats : « 🔔 N en alerte » cohérent.

## S4 — J'arrive + position (B sur le besoin de A)
1. B ouvre la fiche → « J'arrive » : ETA ~30 min, son numéro, accepter la géoloc.
2. A observe carte et fiche. B → « Actualiser ma position ». B → « Je ne peux plus venir », puis re-« J'arrive ».

- [ ] Avant « J'arrive », B ne voit PAS la partie privée (mention 🔒 visible) ; après, oui.
- [ ] A voit : compteur 1, nom/profession de B, ETA, son numéro cliquable, 🚗 sur la carte avec fraîcheur.
- [ ] C/D ne voient NI la position NI le numéro de B (vérifier `/api/state` en DevTools).
- [ ] A est notifié (push) de l'arrivée de B.
- [ ] L'annulation retire compteur + 🚗 ; le re-clic refonctionne.

## S5 — Échange de numéro (C → A, sans j'arrive)
1. C ouvre la fiche de A → « Demander son numéro ».
2. A voit la bannière → teste **Refuser**. C re-demande ; A **partage** son numéro.

- [ ] A voit « C (se déclare …) demande votre numéro » avec le titre de la fiche.
- [ ] Refus : C voit « n'a pas souhaité partager » (+ message si renseigné).
- [ ] Accord : C voit le numéro + bouton 📞 appeler ; D ne voit rien.

**Sens inverse (B a dit « j'arrive » SANS numéro)** :
3. A ouvre sa fiche → bouton « 📞 Demander son numéro » sur la ligne de B.
4. B reçoit la bannière « A (émetteur) demande votre numéro » → accepte avec un
   petit message, OU refuse avec un message (« pas de tel, j'y suis à 15h »).

- [ ] A voit la réponse rattachée à la bonne ligne d'arrivée (numéro cliquable + message, ou refus + message).
- [ ] Un tiers ne voit rien de tout cela dans `/api/state`.

## S6 — Vie de la fiche (A)
1. A ajoute une mise à jour (« plus besoin de X »). 2. A clôture depuis « Mon SOS ».

- [ ] La mise à jour horodatée apparaît chez tous en ≤ 30 s.
- [ ] Clôture : la fiche disparaît partout, « ✅ résolus » +1, le bouton A redevient « Besoin d'aide ».

## S7 — Code de session : remise et récupération (A)
1. À l'onboarding, après « J'accepte » : noter le code FEU-XXXX-XXXX affiché (bouton copier).
2. A émet un SOS + configure une vigie, puis **vide les données du site** (simule le téléphone perdu).
3. Sur le « nouvel appareil » : onboarding → « 🔑 J'ai déjà un code de session » → saisir le code.
4. Tester aussi : mauvais code, puis 👤 → « Régénérer mon code » → vérifier que l'ancien est mort.

- [ ] Le code n'est affiché qu'une seule fois (pas re-consultable ensuite).
- [ ] Après récupération : profil, SOS (avec bouton clôturer), vigie — tout est là.
- [ ] Mauvais code → « Code inconnu » ; ~10 essais → « Trop de requêtes » (429).
- [ ] Après régénération, l'ancien code ne fonctionne plus, le nouveau récupère tout.

## S8 — Refuge citoyen (C héberge, A demande)
1. C : « Ouvrir un refuge » → 4 places, 🐾 animaux, partie privée = adresse exacte.
2. A ouvre la fiche → « 🙋 Demander à rejoindre » (+ échange de numéro).
3. C → « ⛔ Afficher complet ». D regarde. C → « 🟢 Rouvrir des places ».
4. C émet un SOS besoin (le refuge manque de couvertures).

- [ ] Badges 🛏️ 4 places / 🐾 sur la fiche ; adresse exacte invisible avant demande.
- [ ] Complet : pin grisé + ⛔ sur la carte, bandeau COMPLET, bouton demande retiré chez D.
- [ ] Rouvert : tout revient. Le SOS de C est un besoin normal, suivi via « Mon SOS ».
- [ ] C garde son bouton « Besoin d'aide » même en étant hébergeur.

## S9 — Signalement et modération (D auteur ; A, B, C signalent ; Admin)
1. D émet une fiche « abusive ». A, B, C la signalent (3 identités distinctes).
2. Admin : `/admin.html` → vérifier la section signalées → **Rétablir**, puis **Supprimer**, puis **Bannir** D.
3. D tente de re-émettre.

- [ ] À 3 signalements la fiche disparaît de la carte (mais reste en admin, marquée MASQUÉE).
- [ ] Rétablir la refait apparaître ; Supprimer purge fiche + fichiers.
- [ ] D banni → « Accès suspendu » à l'émission et au j'arrive.

## S10 — Expiration et re-déclaration (A, accéléré)
1. A émet une fiche, puis vieillir artificiellement :
   `UPDATE pings SET created_at = created_at - INTERVAL 25 HOUR WHERE id='<id>';`
2. Attendre un poll. 3. Cliquer « 🔄 Re-déclarer » dans la bannière.

- [ ] La fiche disparaît de la carte publique après 24 h.
- [ ] A voit la bannière « votre fiche a expiré » ; le formulaire se pré-remplit (partie privée incluse).
- [ ] À +72 h (`- INTERVAL 73 HOUR`) : purge réelle en base + fichiers uploads disparus.

## S11 — Couche feux (tous)
1. Activer/désactiver 🛰️ Feux. Taper un point. Ouvrir ℹ️.
2. Test du repli : retirer `FIRMS_MAP_KEY` du `.env`, redémarrer, recharger.

- [ ] Points colorés par fraîcheur conformes à la légende ; popup = date/heure locale, « il y a X h », confiance, satellite.
- [ ] Aucun carré bleu, dans les deux modes.
- [ ] Sans clé : mode raster GIBS (points rouges) fonctionne. Remettre la clé après !

## S12 — Points officiels, zones, import (Admin)
1. Admin : ajouter un point officiel manuel + une zone de danger sur la zone de test.
2. A tente de placer un besoin DANS la zone. 3. Admin : bouton « import alertesfeux »
   (`POST /api/admin/import-alertesfeux`).

- [ ] Pins bleus 🏛️ non clusterisés, popup avec source + itinéraire Google Maps.
- [ ] Au placement en zone : avertissement « placez le point en retrait » (non bloquant) ; badge ⚠️ sur la fiche.
- [ ] L'import recharge les points auto sans toucher les points manuels.

## S13 — Diffusion et PWA (1 appareil de chaque)
1. Partager une fiche (bouton 📤) dans WhatsApp/SMS. 2. Ouvrir `/affiche.html`, imprimer.
3. iPhone : ajouter à l'écran d'accueil puis activer les alertes. 4. Couper le réseau, rouvrir l'app.

- [ ] Le lien partagé montre un aperçu (titre + image) et ouvre la fiche centrée.
- [ ] QR de l'affiche → ouvre le site. Hors-ligne : l'app s'ouvre (dernier état), bandeau d'erreur discret.
- [ ] iPhone : push reçus une fois installée sur l'écran d'accueil.

## S14 — Résilience (technique, en local)
1. Éteindre MariaDB pendant l'utilisation, puis la relancer.
2. Émettre 25 fiches d'affilée (même IP). 3. Uploader une photo de 3 Mo.

- [ ] BDD coupée : l'app affiche des erreurs propres, AUCUN crash du process Node ;
      `logs/error.log` rempli ; reprise seule au retour de la base.
- [ ] Rate limit : blocage vers ~20 créations/h avec message clair.
- [ ] Photo > 1,5 Mo : la compression client la fait passer ; un fichier envoyé
      brut > 1,5 Mo (via curl) → 400 « Fichier trop volumineux ».

---

## Matrice de couverture rapide

| Feature | Scénarios |
|---|---|
| Onboarding, cookie, profil | S1 |
| Besoin (photo/vocal/privé/code) | S2, S7 |
| Alertes push + rayon | S3 |
| J'arrive, position, ETA | S4 |
| Échange de numéro | S4, S5 |
| Mises à jour, clôture, stats | S6 |
| Refuge (places/animaux/complet) | S8 |
| Signalement, admin, ban | S9 |
| TTL 24/72 h, re-déclaration | S10 |
| Feux FIRMS + repli GIBS | S11 |
| Officiels, zones, import | S12 |
| Partage OG, QR, PWA, iOS | S13 |
| Pannes, rate limit, uploads | S14 |
