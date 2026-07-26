#!/usr/bin/env node
/* Purge des données de test.
   node scripts/purge.js          → fiches + interactions + fichiers uploadés
   node scripts/purge.js --all    → + identités, vigies, compteur résolus
   node scripts/purge.js --full   → + points officiels et zones de danger
   Les clés (data/) ne sont jamais touchées. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { q, pool } = require('../db');

const ALL = process.argv.includes('--all') || process.argv.includes('--full');
const FULL = process.argv.includes('--full');
const UP_DIR = path.join(__dirname, '..', 'uploads');

(async () => {
  const tables = ['ping_updates', 'arrivals', 'reports', 'contact_requests', 'pings'];
  if (ALL) tables.push('watchers', 'identities');
  if (FULL) tables.push('official_points', 'zones');

  for (const t of tables) {
    const [r] = [await q(`SELECT COUNT(*) AS n FROM ${t}`)];
    await q(`DELETE FROM ${t}`);
    console.log(`  ${t}: ${r[0].n} ligne(s) supprimée(s)`);
  }
  if (ALL) { await q("UPDATE stats SET v=0 WHERE k='resolved'"); console.log('  stats: compteur résolus remis à 0'); }

  let files = 0;
  for (const f of fs.readdirSync(UP_DIR)) { fs.rmSync(path.join(UP_DIR, f), { force: true }); files++; }
  console.log(`  uploads/: ${files} fichier(s) supprimé(s)`);

  await pool.end();
  console.log(`Purge ${FULL ? 'complète' : ALL ? 'étendue' : 'standard'} terminée ✅`);
})().catch(e => { console.error('Erreur purge :', e.message); process.exit(1); });
