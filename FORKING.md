# Forking guide — adapt this app to your territory or your emergency

Entraide Feu was built in ~48h during the July 2026 Gironde wildfires (France).
It is deliberately simple to redeploy: **one Node process, one MySQL/MariaDB
database, one uploads folder**. One person can run it. This guide lists
everything you need to change — and nothing else.

The UI is intentionally **monolingual** (French here): the map content is a
local conversation between residents. Fork it in *your* language entirely,
rather than making it bilingual — mixed-language SOS posts confuse the local
responders who are the whole point of the tool.

## 1. Territory — one block in `.env`

```ini
REGION_CENTER=44.8,-0.9,9        # initial map view: lat, lng, zoom
REGION_BOUNDS=40.5,-6.5,51.8,10.5 # navigable area: south, west, north, east
GEO_BBOX=-2.0,43.3,1.5,46.2       # satellite fire detections + geocoding: west, south, east, north
```

That's it — map view, map limits, FIRMS satellite bbox and Nominatim geocoding
bounds all follow. Keep `REGION_BOUNDS` generous (a country), `GEO_BBOX` tight
(your crisis region — it bounds geocoding disambiguation).

## 2. Branding & wording

- `public/index.html` — app name, onboarding texts, legend. Search for
  « Entraide Feu » and the fire-specific wording (SOS categories are already
  universal: hands/vehicle, supplies, medical + shelters, collection points).
- `public/icon.svg`, `public/manifest.webmanifest` — icon and PWA name.
- `public/legal.html` — your legal notice (publisher, host, contact). **Required
  by law in France; check your jurisdiction.**
- `public/affiche.html` — the printable QR poster.
- Emergency numbers: 18/112 are French — search `tel:18` / `tel:112`.

## 3. Data sources

- **Satellite fire layer** (`FIRMS_MAP_KEY`): free key at
  https://firms.modaps.eosdis.nasa.gov/api/map_key/ — worldwide coverage, so it
  works for any territory. **For non-fire emergencies (flood, earthquake):
  leave the key unset** — the app falls back gracefully, and you can hide the
  🛰️ toggle in `index.html`.
- **Official points importer** (`IMPORT_SOURCES`): scrapes a volunteer-run
  situation site (alertesfeux.fr HTML template). For your fork:
  `IMPORT_SOURCES=none` to disable, then feed official shelters/collection
  points by hand through `/admin.html` — or adapt `parsePage()` in
  `importer.js` to your local source.

## 4. Notifications

- **Email (primary channel)**: any SMTP (`SMTP_*` in `.env`). Without it,
  emails are simulated into `logs/mail.log` (dev mode).
- **Web push (silent bonus)**: VAPID keys are generated automatically. Don't
  rely on it — that's why email is the primary channel.

## 5. Demo dataset

The onboarding includes an explorable demo. Regenerate it with **your** places
and scenarios:

1. Edit `PLACES`, `SOS`, `REFUGES` in `scripts/seed-demo.js` (your towns, your
   crisis vocabulary).
2. `node scripts/seed-demo.js` (server running, database up)
3. `curl -s http://localhost:3000/api/state | node scripts/make-demo.js`
4. Commit the new `public/demo.json`, then purge the seeded data
   (`npm run purge:all`).

The anonymous snapshot is sanitized by construction: no private parts, no phone
numbers, no session codes can leak into it.

## 6. Deploy

See README (shared hosting friendly: HTTPS via the host's proxy, `pm2` or
systemd, connection pool capped at 5). First boot creates the schema and all
secrets (`data/`), and prints the admin URL.

## 7. What NOT to change

- The privacy invariants (ARCHITECTURE.md §security): phones never public,
  helper positions owner-only, private parts gated, hashes only in DB.
- The 24h TTL philosophy: re-declaring daily keeps the map truthful. Your
  crisis moves; so should your data.
- `.env` stays out of git. It contains your SMTP password and FIRMS key.
