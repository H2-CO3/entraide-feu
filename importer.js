/* Connecteur alertesfeux.fr → points officiels.
   Le site (bénévole, sans API) publie les collectes/hébergements relayés des
   préfectures et mairies dans un HTML très structuré (<article class="org">).
   On le parse avec tolérance, on géocode via Nominatim (cache en base, throttle),
   et on synchronise les points marqués auto=1 — les points ajoutés à la main
   par l'admin (auto=0) ne sont jamais touchés. */
const { q } = require('./db');

// Sources d'import des points officiels — surchageables par IMPORT_SOURCES dans
// .env (format « url|type,url|type », valeur « none » = import désactivé).
// Le parseur attend le gabarit HTML <article class="org"> d'alertesfeux.fr ;
// pour une autre source, adapter parsePage() ou saisir les points via l'admin.
const PAGES = process.env.IMPORT_SOURCES === 'none' ? []
  : process.env.IMPORT_SOURCES
    ? process.env.IMPORT_SOURCES.split(',').map(s => { const [url, t] = s.trim().split('|'); return { url, defaultType: t || 'collecte' }; })
    : [
      { url: 'https://alertesfeux.fr/solidarite', defaultType: 'collecte' },
      { url: 'https://alertesfeux.fr/animaux', defaultType: 'info' },
    ];
const UA = 'EntraideFeu/1.0 (+https://github.com/H2-CO3/entraide-feu)';
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '’').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parsePage(html, defaultType) {
  const out = [];
  // ignore le gabarit d'exemple qui vit dans un commentaire HTML
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of clean.split(/<article class="org[^"]*"[^>]*>/).slice(1)) {
    const art = raw.split('</article>')[0];
    const title = strip((art.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!title) continue;
    // st go = en cours, st ok = ouvert/appel, st stop = « ne rien apporter » → exclu
    const stClass = (art.match(/<span class="st ([a-z]+)"/) || [])[1];
    if (stClass === 'stop') continue;
    const loc = strip((art.match(/<p class="loc">([\s\S]*?)<\/p>/) || [])[1]);
    const status = strip((art.match(/<span class="st[^"]*">([\s\S]*?)<\/span>/) || [])[1]);
    const box = strip((art.match(/<p class="box">([\s\S]*?)<\/p>/) || [])[1]);
    const tel = (art.match(/href="tel:([^"]+)"/) || [])[1];
    const yes = [...art.matchAll(/<li class="yes">([\s\S]*?)<\/li>/g)].map(m => strip(m[1]));
    const no = [...art.matchAll(/<li class="no">([\s\S]*?)<\/li>/g)].map(m => strip(m[1]));
    const srcDate = strip((art.match(/<p class="cardfoot">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);

    // la détection « refuge » ne vaut que pour la page solidarité ;
    // tout ce qui vient de /animaux reste en info (refuge = humains uniquement)
    const type = defaultType === 'collecte' && /héberg|refuge|accueil des sinistrés/i.test(title + ' ' + loc) ? 'refuge' : defaultType;
    let detail = '';
    if (status) detail += status + '. ';
    if (tel) detail += '📞 ' + tel + '. ';
    if (yes.length) detail += '✔ ' + yes.join(' · ') + '. ';
    if (no.length) detail += '✖ ' + no.join(' · ') + '. ';
    if (box) detail += box;
    out.push({ type, title, loc, box, detail: detail.slice(0, 300), srcDate });
  }
  return out;
}

// Candidats de géocodage, du plus précis au plus grossier. Une entrée sans
// aucun code postal (« 28 communes », listes de villes) n'est pas un lieu → [].
function geocodeCandidates(item) {
  const precise = [], coarse = [];
  const sent = (item.box.match(/([^.]*\b\d{5}\b[^.]*)/) || [])[1];
  let clean = null;
  if (sent) {
    clean = sent.replace(/^(Dépôt|Où déposer|Adresse)[^A-Za-zÀ-ÿ0-9]*(et inscriptions?[^A-Za-zÀ-ÿ0-9]*)?/i, '').trim();
    precise.push(clean); // adresse complète
  }
  let m = item.loc.match(/^([^(·]+)\((\d{5})\s+([^)]+)\)/);      // « Stade Chaban-Delmas (33300 Bordeaux) »
  if (m) { precise.push(`${m[1].trim()}, ${m[3].trim()}`); coarse.push(`${m[3].trim()} ${m[2]}, France`); }
  if (clean) {
    const iDigit = clean.search(/\d/);
    if (iDigit > 0) precise.push(clean.slice(iDigit)); // sans le nom du lieu (« 35 rue…, 33300 Ville »)
  }
  m = item.loc.match(/^([^(·]+)\((\d{5})\)/);                    // « Bordeaux (33300) »
  if (m) coarse.push(`${m[1].trim()} ${m[2]}, France`);
  return [...new Set([...precise, ...coarse].map(c => c.slice(0, 180)))];
}

// Recherche bornée à la zone couverte : évite qu'un libellé ambigu
// (« 28 communes ») atterrisse à l'autre bout de la France.
// Pilotée par GEO_BBOX dans .env (west,south,east,north) — cf. FORKING.md
const G = String(process.env.GEO_BBOX || '-2.0,43.3,1.5,46.2').split(',').map(Number);
const BBOX = { minLng: G[0], minLat: G[1], maxLng: G[2], maxLat: G[3] };
async function geocode(query) {
  const key = ('v2|' + query).slice(0, 191);
  const cached = await q('SELECT lat, lng, ok FROM geocode_cache WHERE q=?', [key]);
  if (cached.length) return cached[0].ok ? { lat: +cached[0].lat, lng: +cached[0].lng } : null;
  await sleep(1200); // politesse Nominatim : 1 req/s max
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=fr' +
    `&viewbox=${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng},${BBOX.minLat}&bounded=1&q=` + encodeURIComponent(query);
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  let hit = (await r.json())[0];
  if (hit && (+hit.lat < BBOX.minLat || +hit.lat > BBOX.maxLat || +hit.lon < BBOX.minLng || +hit.lon > BBOX.maxLng)) hit = null;
  await q('INSERT IGNORE INTO geocode_cache (q, lat, lng, ok) VALUES (?,?,?,?)',
    [key, hit ? +hit.lat : null, hit ? +hit.lon : null, hit ? 1 : 0]);
  return hit ? { lat: +hit.lat, lng: +hit.lon } : null;
}

async function runImport() {
  if (!PAGES.length) return { ok: 0, skipped: 0, total: 0, disabled: true };
  const found = [];
  for (const page of PAGES) {
    const r = await fetch(page.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${page.url} → HTTP ${r.status}`);
    found.push(...parsePage(await r.text(), page.defaultType).map(i => ({
      ...i,
      title: page.defaultType === 'info' && !/🐾/.test(i.title) ? '🐾 ' + i.title : i.title,
      source: page.url.split('/').pop(),
    })));
  }
  if (!found.length) throw new Error('0 point parsé — structure du site changée ?');

  let ok = 0, skipped = 0;
  const day = new Date().toISOString().slice(0, 10);
  await q('DELETE FROM official_points WHERE auto=1');
  for (const item of found) {
    let pos = null;
    for (const cand of geocodeCandidates(item)) {
      pos = await geocode(cand).catch(() => null);
      if (pos) break;
    }
    if (!pos) { skipped++; continue; } // pas géolocalisable (ex : « 28 communes ») → visible via le lien du panneau ℹ️
    await q('INSERT INTO official_points (type, label, detail, lat, lng, source, auto) VALUES (?,?,?,?,?,?,1)',
      [item.type, item.title.slice(0, 100), item.detail, pos.lat, pos.lng,
        `alertesfeux.fr/${item.source}${item.srcDate ? ' — ' + item.srcDate : ''} (import du ${day})`.slice(0, 120)]);
    ok++;
  }
  return { ok, skipped, total: found.length };
}

module.exports = { runImport };
