# Architecture — Entraide Feu

Document de référence pour auditer ou faire auditer le code (humain ou IA).
L'application est volontairement minimale : **un process Node, une base MariaDB,
un dossier d'uploads** — aucun service externe payant, aucune clé d'API tierce.

## Vue d'ensemble

```
Navigateur (PWA vanilla JS + Leaflet)
   │  polling GET /api/state (15-30 s, backoff en cas d'erreur)
   │  Web Push (VAPID auto-hébergé) pour les alertes et réponses
   ▼
server.js (Express)
   ├── db.js → MariaDB (socket UNIX, pool de 5)     — schema.sql auto-appliqué au boot
   ├── importer.js → alertesfeux.fr (toutes les 6 h) — points officiels
   ├── /fires/wms → proxy + cache NASA GIBS          — couche feux satellites
   ├── uploads/  → photos & vocaux (fichiers plats)
   ├── data/     → secrets générés au 1er boot (HMAC, admin, VAPID)
   └── logs/     → error.log horodaté
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Toute l'API + pages serveur (OG, QR) + tâches périodiques |
| `db.js` | Pool MariaDB + application de `schema.sql` au démarrage |
| `importer.js` | Parse alertesfeux.fr, géocode (Nominatim, cache, throttle), sync `official_points` |
| `schema.sql` | Schéma complet, idempotent (`CREATE IF NOT EXISTS` + `ALTER IF NOT EXISTS`) |
| `scripts/purge.js` | Purge de test : standard / `--all` / `--full` |
| `public/app.js` | Tout le client : carte, fiches, formulaires, push, polling |
| `public/index.html` | Structure : onboarding 5 étapes, modales, fiche, panneaux |
| `public/sw.js` | Service worker : cache réseau-d'abord du shell, réception push |
| `public/admin.html` | Modération : signalements, bannissement, zones, points officiels |

## Modèle d'identité (pas de comptes)

- Un cookie `fid` **HttpOnly** anonyme, posé par le serveur à la première visite.
- La base ne stocke que `HMAC-SHA256(fid, SECRET)` — une fuite de base ne permet
  d'usurper personne.
- Le cookie est l'unique preuve de propriété : clôturer ses fiches, annuler son
  « j'arrive », recevoir ses réponses. Filet de secours : code de clôture à
  4 chiffres par fiche (anti-brute-force 10 essais/h/IP).
- Prénom obligatoire, profession déclarative (« se déclare pompier » — jamais
  « vérifié », c'est un choix juridique délibéré).

## Modèle de données (tables)

- `identities` — hash, prénom, profession, banni.
- `pings` — fiche : famille (`besoin`/`offre`), type (humain/matériel/médical/
  collecte/refuge), titre, message public, **message privé** (visible uniquement
  émetteur + engagés), position, photo/vocal, statut, code de clôture, `hidden`.
  Refuges citoyens : `places`, `animals`, `is_full` (complet = affiché mais
  non sollicitable ; distinct de la clôture). Le « j'arrive » devient
  « demander à rejoindre » sur un refuge — même mécanique, mêmes tables.
- `arrivals` — « j'arrive » : ETA, téléphone (visible émetteur seul), **position
  du dépanneur** (visible émetteur + lui-même, bornée à 300 km du ping).
- `ping_updates` — mises à jour horodatées ajoutées par l'émetteur.
- `reports` — signalements ; ≥ 3 hashes distincts → `hidden=1`.
- `contact_requests` — échange de numéro consenti (pending/accepted/declined).
- `watchers` — alertes : catégories, position + rayon, abonnement push.
- `official_points` — points préfecture/mairies ; `auto=1` = synchronisés depuis
  alertesfeux.fr (remplacés à chaque import), `auto=0` = saisis par l'admin (intouchés).
- `zones` — zones de danger tracées par l'admin (cercles).
- `geocode_cache` — réponses Nominatim (préfixe de version dans la clé).
- `stats` — compteur de besoins résolus.

## Cycle de vie d'une fiche

émission (cookie → propriétaire, push aux vigies dans le rayon)
→ « j'arrive » (compteur public, ETA, position/téléphone pour l'émetteur, push à l'émetteur)
→ échange de numéro consenti (jamais public, à destination d'un seul hash)
→ clôture (cookie ou code) OU expiration : **invisible à 24 h, purge définitive
fichiers compris à 72 h**. Re-déclaration quotidienne assumée (bouton pré-rempli) :
le feu bouge, la carte doit refléter le terrain du jour.

## Couche feux satellites

`/fires/wms` proxifie le WMS de NASA GIBS (VIIRS SNPP + NOAA-20 + MODIS Terra) :
- la **date servie** est la dernière réellement publiée par la NASA (lue dans les
  capabilities WMTS toutes les 30 min), pas « aujourd'hui » souvent vide ;
- cache mémoire : succès 30 min, échec 2 min (tuile transparente immédiate
  plutôt qu'un blocage de 15 s par client) ; LRU ~300 tuiles ;
- côté client : une seule couche, tuiles 512 px, pas de requête au-delà du zoom 11.

## Sécurité / vie privée — invariants à vérifier en revue

1. Aucun numéro de téléphone n'est jamais public (uniquement le destinataire choisi).
2. La position d'un dépanneur n'est visible que de l'émetteur du ping concerné
   (et de lui-même) ; bornes géographiques + plausibilité côté serveur.
3. La partie privée d'une fiche n'est renvoyée qu'à l'émetteur et aux engagés
   (`hasPrivate` sinon).
4. Les photos sont recompressées côté client (canvas) → EXIF/GPS supprimés.
5. Tout HTML rendu passe par `esc()` (client) ou `esc()` (serveur, pages OG).
6. Rate limiting généreux par IP (CGNAT) sur toutes les mutations.
7. Les erreurs async ne tuent pas le process (wrapper Express) ; tout part dans
   `logs/error.log`.
8. RGPD : cookie technique exempté de consentement, TTL 24-72 h, suppression
   réelle des fichiers, pages légales à jour.

## Points de fragilité connus (assumés)

- L'import alertesfeux.fr casse si leur gabarit HTML change → erreur loggée,
  derniers points conservés, saisie admin toujours possible.
- Géocodage Nominatim : heuristique en cascade, bornée au Sud-Ouest (constante
  `BBOX` dans importer.js — à adapter si fork ailleurs).
- Push iOS : exige l'ajout à l'écran d'accueil (limitation Apple, contournement
  affiché à l'utilisateur).
- Tuiles OSM publiques : suffisant à l'échelle départementale, prévoir un
  fournisseur dédié si trafic national.
