/* Fige l'état anonyme courant en jeu d'exemples pour le mode démonstration.
   Usage : curl -s http://localhost:3000/api/state | node scripts/make-demo.js
   La vue anonyme est sanitisée par construction (aucune partie privée,
   aucun numéro, aucun code n'y figure). */
let d = '';
process.stdin.on('data', c => d += c).on('end', () => {
  const s = JSON.parse(d);
  const demo = { pings: s.pings, zones: s.zones, helpers: (s.helpers || []).map(h => ({ ...h, self: false })), officials: s.officials, stats: s.stats };
  require('fs').writeFileSync(require('path').join(__dirname, '..', 'public', 'demo.json'), JSON.stringify(demo));
  console.log(`public/demo.json : ${demo.pings.length} publications, ${demo.helpers.length} dépanneurs`);
});
