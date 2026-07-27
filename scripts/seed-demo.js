/* Génère une simulation de crise réaliste (SOS, refuges, dépanneurs, arrivées)
   pour tester l'app en conditions réelles ET produire le jeu d'exemples de la démo.

   Usage :  node scripts/seed-demo.js          (peuple la base)
   Puis  :  curl -s http://localhost:3000/api/state | node scripts/make-demo.js
            (fige un instantané sanitisé dans public/demo.json)

   FORK : adaptez PLACES (vos communes), SOS et REFUGES (vos scénarios) —
   tout le contenu simulé est déclaré ci-dessous. Insertion SQL directe
   (le rate-limit de l'API interdit 60 créations d'affilée depuis une IP).
   Les identités simulées n'ont volontairement PAS d'e-mail. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const FIRST = ['Jean', 'Marie', 'Karim', 'Sophie', 'Luc', 'Fatima', 'Pierre', 'Léa', 'Nicolas', 'Awa', 'Julien', 'Chantal', 'Mehdi', 'Anne', 'Bruno', 'Inès', 'Paul', 'Nadia', 'Hervé', 'Claire', 'Yassine', 'Monique', 'David', 'Élodie', 'Franck', 'Aïcha', 'Gilles', 'Laure', 'Romain', 'Sylvie'];
const PROF = [null, null, null, null, null, 'pompier', null, 'soignant', null, null, 'policier', null];

// communes réelles du secteur (approx)
const PLACES = [
  ['Lacanau', 44.98, -1.08], ['Le Porge', 44.87, -1.09], ['Saumos', 44.85, -0.93],
  ['Le Temple', 44.92, -0.88], ['Salaunes', 44.93, -0.84], ['Sainte-Hélène', 44.96, -0.88],
  ['Andernos', 44.74, -1.10], ['Arès', 44.76, -1.14], ['Lège-Cap-Ferret', 44.79, -1.15],
  ['Le Barp', 44.61, -0.77], ['Mios', 44.60, -0.85], ['Biganos', 44.64, -0.97],
  ['Audenge', 44.68, -1.01], ['Lanton', 44.70, -1.03], ['Marcheprime', 44.69, -0.85],
  ['Saint-Jean-d\'Illac', 44.80, -0.79], ['Martignas', 44.84, -0.78], ['Salles', 44.55, -0.87],
  ['Belin-Béliet', 44.50, -0.79], ['Biscarrosse', 44.39, -1.16], ['Sanguinet', 44.48, -1.07],
  ['Parentis-en-Born', 44.35, -1.07], ['Bordeaux', 44.84, -0.58], ['Mérignac', 44.83, -0.68],
  ['Saint-Médard', 44.90, -0.72], ['Pessac', 44.80, -0.64],
];

const SOS = [
  ['materiel', 'Besoin d\'AdBlue pour camion SDIS', 'Deux bidons de 10L suffiraient, point de rencontre parking Intermarché.'],
  ['materiel', 'Groupe électrogène pour EHPAD', 'Coupure secteur, 15 résidents. 3kW minimum.'],
  ['humain', 'Bras pour déplacer du bétail', '25 brebis à charger avant 8h, bétaillère sur place.'],
  ['materiel', 'Foin pour 12 chevaux évacués', 'Chevaux regroupés au centre équestre, plus de stock.'],
  ['medical', 'Masques FFP2 pour l\'école', 'Fumées rabattues sur le bourg, 60 enfants confinés.'],
  ['materiel', 'Ravitaillement eau pompiers D107', 'Palettes de bouteilles pour les équipes au sol.'],
  ['materiel', 'Nourrice gasoil pour tronçonneuses', 'Équipe communale de déblaiement à sec.'],
  ['humain', 'Personne âgée à évacuer (véhicule)', 'Mamie 88 ans + fauteuil roulant, pas de voiture.'],
  ['materiel', 'Chargeurs téléphone salle des fêtes', 'Multiprises et chargeurs pour 40 évacués.'],
  ['materiel', 'Croquettes chiens pour refuge', '30 chiens accueillis en urgence.'],
  ['materiel', 'Lampes frontales équipe déblaiement', '10 frontales + piles.'],
  ['medical', 'Médicaments asthme', 'Ventoline pour évacués, ordonnances OK, pharmacie fermée.'],
  ['humain', 'Conducteur poids lourd bénévole', 'Permis C pour navette de matériel Bordeaux → front.'],
  ['materiel', 'Citernes IBC 1000L', 'Pour points d\'eau des exploitations.'],
  ['materiel', 'Bâches pour toitures', 'Braises retombées, 3 toitures percées.'],
  ['materiel', 'Lait infantile + couches T4', 'Trois familles avec bébés au gymnase.'],
  ['medical', 'Glacières + pains de glace insuline', 'Diabétiques évacués, frigo HS.'],
  ['materiel', 'Débroussailleuses coupe-feu', 'Renfort pare-feu chemin des Arnauds.'],
  ['materiel', 'Talkies-walkies coordination', 'Réseau saturé, 6 postes minimum.'],
  ['humain', 'Remorque bétaillère', 'Poneys du centre aéré à déplacer.'],
  ['materiel', 'Piles + radios FM', 'Coupure réseau secteur nord, info FR-Alert inaccessible.'],
  ['materiel', 'Mélange 2 temps tronçonneuses', '20L pour l\'équipe de bûcheronnage bénévole.'],
  ['materiel', 'Gants cuir + lunettes de protection', 'Pour les bénévoles du déblaiement.'],
  ['humain', 'Bras déchargement palettes', 'Camion de dons arrive à 7h, salle omnisports.'],
  ['medical', 'Infirmier pour poste de secours', 'Renfort 6h-12h au point d\'accueil.'],
  ['humain', 'Véhicule 7 places navette évacués', 'Rotations gymnase → centre Bordeaux.'],
  ['materiel', 'Matelas + duvets gymnase', 'Il manque 25 couchages.'],
  ['materiel', 'Extincteurs pour véhicules navette', 'Obligatoire pour approcher la zone.'],
  ['humain', 'Garde d\'enfants parents mobilisés', '5 enfants de pompiers volontaires à garder.'],
  ['materiel', 'Câbles + batteries 12V', 'Véhicules abandonnés à redémarrer sur la D6.'],
];

const REFUGES = [
  ['Maison 2 chambres + jardin', 4, 1, 'On a de la place, on est au calme. Arrivée possible à toute heure.'],
  ['Ferme — 6 places + boxes chevaux', 6, 1, 'Boxes libres pour 4 chevaux, pré clôturé.'],
  ['Appartement Bordeaux centre', 2, 0, 'Canapé-lit + chambre d\'amis, immeuble calme.'],
  ['Gîte 8 places', 8, 1, 'Gîte vide cette semaine, cuisine équipée.'],
  ['Studio pour 1-2 personnes', 2, 0, 'Petit mais fonctionnel, draps fournis.'],
  ['Villa avec piscine — 5 places', 5, 1, 'Grande maison, les enfants sont les bienvenus.'],
  ['Camping-car sur notre terrain', 3, 1, 'Autonome, électricité branchée.'],
  ['Longère 10 places', 10, 1, 'Grande capacité, idéal famille nombreuse ou groupe.'],
  ['Chambre chez l\'habitant', 1, 0, 'Pour une personne seule, salle de bain partagée.'],
  ['Maison plain-pied PMR', 3, 0, 'Accessible fauteuil, barre d\'appui, proche pharmacie.'],
  ['Grange aménagée 4 places', 4, 1, 'Rustique mais chauffé, animaux acceptés sans souci.'],
  ['T3 à Mérignac', 4, 0, 'Deux chambres, proche rocade et hôpital.'],
];

const ETAS = ['~15 min', '~30 min', '~1 h', '~2 h et +'];
const UPDATES = ['Quelqu\'un est en route, merci !', 'Toujours d\'actualité ce matin', 'Plus que la moitié du besoin, continuez', 'Point de rencontre déplacé au parking de la mairie', 'Les pompiers confirment le besoin'];

const rnd = a => a[Math.floor(Math.random() * a.length)];
const jitter = () => (Math.random() - 0.5) * 0.03;
const hex = n => crypto.randomBytes(n).toString('hex');
const pid = () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'a').slice(0, 10);
const ago = maxMin => new Date(Date.now() - (5 + Math.random() * maxMin) * 60000);

(async () => {
  const db = await mysql.createConnection({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_SOCKET ? undefined : (process.env.DB_HOST || '127.0.0.1'), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME });
  const people = [];
  for (let i = 0; i < 45; i++) {
    const h = hex(32);
    people.push(h);
    await db.execute('INSERT INTO identities (hash, name, profession) VALUES (?,?,?)', [h, FIRST[i % FIRST.length], rnd(PROF)]);
  }
  let nPings = 0, nArr = 0;
  // ~30 SOS répartis, âges 5 min → 20 h
  for (const [type, title, msg] of SOS) {
    const [where, la, lo] = rnd(PLACES);
    const owner = rnd(people);
    const id = pid();
    await db.execute(
      'INSERT INTO pings (id, owner_hash, kind, type, title, message, private_message, lat, lng, close_code, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, owner, 'besoin', type, title, `${msg} (${where})`, Math.random() < .4 ? 'Tel direct : 06 00 00 00 00' : null,
        la + jitter(), lo + jitter(), '0000', ago(1200)]);
    nPings++;
    // arrivées sur ~la moitié
    const n = Math.random() < .5 ? Math.floor(Math.random() * 3) : 0;
    for (let k = 0; k < n; k++) {
      const helper = rnd(people.filter(p => p !== owner));
      await db.execute('INSERT IGNORE INTO arrivals (ping_id, helper_hash, eta, phone, lat, lng, pos_at) VALUES (?,?,?,?,?,?,NOW())',
        [id, helper, rnd(ETAS), Math.random() < .5 ? '06 12 34 56 78' : null,
          Math.random() < .6 ? la + jitter() : null, Math.random() < .6 ? lo + jitter() : null]).then(() => nArr++);
    }
    if (Math.random() < .35) await db.execute('INSERT INTO ping_updates (ping_id, text) VALUES (?,?)', [id, rnd(UPDATES)]);
  }
  // 12 refuges avec demandes en divers états
  for (const [title, places, animals, msg] of REFUGES) {
    const [where, la, lo] = rnd(PLACES);
    const owner = rnd(people);
    const id = pid();
    const full = Math.random() < .25 ? 1 : 0;
    await db.execute(
      'INSERT INTO pings (id, owner_hash, kind, type, title, message, private_message, lat, lng, close_code, places, animals, is_full, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, owner, 'offre', 'refuge', title, `${msg} (${where})`, '15 chemin des Acacias — sonner fort', la + jitter(), lo + jitter(), '0000', places, animals, full, ago(900)]);
    nPings++;
    const dem = Math.floor(Math.random() * 3);
    const st = ['pending', 'accepted', 'declined'];
    for (let k = 0; k < dem; k++) {
      await db.execute('INSERT IGNORE INTO arrivals (ping_id, helper_hash, join_status) VALUES (?,?,?)',
        [id, rnd(people.filter(p => p !== owner)), rnd(st)]).then(() => nArr++);
    }
  }
  // 8 dépanneurs visibles + 6 vigies invisibles
  const cats = ['humain', 'materiel', 'medical'];
  for (let i = 0; i < 14; i++) {
    const [w, la, lo] = rnd(PLACES);
    await db.execute('INSERT IGNORE INTO watchers (hash, cats, lat, lng, radius_km, visible) VALUES (?,?,?,?,?,?)',
      [people[i], [...new Set([rnd(cats), rnd(cats)])].join(','), la + jitter(), lo + jitter(), 10 + Math.floor(Math.random() * 40), i < 8 ? 1 : 0]);
  }
  // 2 signalements (sous le seuil) sur un SOS au hasard + compteur résolus vraisemblable
  const [rows] = await db.execute("SELECT id FROM pings WHERE kind='besoin' LIMIT 1");
  for (let k = 0; k < 2; k++) await db.execute('INSERT IGNORE INTO reports (ping_id, reporter_hash) VALUES (?,?)', [rows[0].id, rnd(people)]);
  await db.execute("UPDATE stats SET v=17 WHERE k='resolved'");
  console.log(`Seed OK : ${nPings} publications, ${nArr} arrivées/demandes, 8 dépanneurs visibles, 6 vigies, 45 identités`);
  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
