# Déploiement sur o2switch (hébergement mutualisé cPanel)

Guide testé sur un offre unique o2switch. Durée : ~30 minutes.

## 1. Sous-domaine + HTTPS

cPanel → **Domaines** → créer le sous-domaine (ex. `entraide-feu.mondomaine.fr`),
racine documentaire indifférente (Passenger la remplacera). **AutoSSL** émet le
certificat Let's Encrypt automatiquement sous ~1 h (vérifier dans SSL/TLS Status).

## 2. Base de données

cPanel → **Bases de données MySQL®** :
1. Créer la base (ex. `cpuser_firemap`).
2. Créer l'utilisateur + mot de passe fort.
3. Ajouter l'utilisateur à la base avec **tous les privilèges**.

## 3. Application Node.js

cPanel → **Setup Node.js App** → Create Application :
- **Node.js version** : 20.x (ou la plus récente ≥ 18)
- **Application mode** : Production
- **Application root** : `entraide-feu` (le dossier sera créé dans le home)
- **Application URL** : le sous-domaine créé
- **Application startup file** : `server.js`

Puis, dans le **Terminal** cPanel (ou SSH) :

```bash
cd ~/entraide-feu
git clone https://github.com/H2-CO3/entraide-feu.git .
# activer l'environnement Node de l'app (la commande exacte est affichée en haut
# de la page Setup Node.js App, du type :)
source /home/CPUSER/nodevenv/entraide-feu/20/bin/activate
npm install --omit=dev
cp .env.example .env && nano .env    # voir §4
```

## 4. `.env` de production

```ini
DB_HOST=localhost
DB_NAME=cpuser_firemap
DB_USER=cpuser_firemap
DB_PASS=…
BASE_URL=https://entraide-feu.mondomaine.fr
CONTACT_EMAIL=…
FIRMS_MAP_KEY=…            # clé NASA FIRMS (gratuite)
SMTP_HOST=serveurX.o2switch.net
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=alerte@…          # boîte créée dans cPanel → Comptes de messagerie
SMTP_PASS=…
# REGION_* / GEO_BBOX : défauts Gironde — cf. FORKING.md pour un autre territoire
# PORT, HTTPS_* : NE PAS définir (Passenger gère le port, le TLS vient d'AutoSSL)
```

Retour dans Setup Node.js App → **Restart**. Le premier démarrage crée le
schéma SQL, les clés (`data/`) et affiche l'URL d'admin dans les logs de l'app
(ou lire `data/admin_key.txt`).

## 5. Maintien en vie (IMPORTANT)

Passenger **endort les applications sans trafic** — ce qui suspendrait le
nettoyage 24 h, la synchro alertesfeux et le rafraîchissement FIRMS.
cPanel → **Tâches Cron** :

```
*/5 * * * * curl -s https://entraide-feu.mondomaine.fr/api/state > /dev/null
```

## 6. Vérifications post-déploiement

```bash
curl -s https://…/api/state | head -c 200     # 200 + JSON
curl -s https://…/api/fires | head -c 100     # mode "firms"
curl -s https://…/api/config                  # région correcte
```

Puis depuis un téléphone (réseau mobile, pas le WiFi de test) : onboarding
complet, e-mail de bienvenue reçu, géolocalisation au placement, une vigie +
un SOS croisés entre deux appareils → e-mail d'alerte.

Après les tests : `npm run purge:all` (dans le venv Node) pour ouvrir propre.

## Dépannage

- **503 / app ne démarre pas** : lire le log Passenger (chemin affiché dans
  Setup Node.js App) et `~/entraide-feu/logs/error.log`.
- **Init BDD impossible** : identifiants `.env`, et l'utilisateur bien ajouté
  à la base avec tous privilèges.
- **E-mails absents** : `logs/error.log` (`notify-mail`), et le `SMTP_FROM`
  doit correspondre à la boîte authentifiée.
- **Géoloc/notifs bloquées** : vérifier que l'URL est bien en https (AutoSSL émis).
