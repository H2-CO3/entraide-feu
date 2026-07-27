require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const webpush = require('web-push');
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const { q, init } = require('./db');
const { runImport } = require('./importer');

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UP_DIR, { recursive: true });

// Secrets : .env prioritaire, sinon générés une fois et persistés dans data/
function persisted(file, gen) {
  const f = path.join(DATA_DIR, file);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const v = gen();
  fs.writeFileSync(f, v, { mode: 0o600 });
  return v;
}
const SECRET = process.env.SECRET || persisted('secret.txt', () => crypto.randomBytes(32).toString('hex'));
const ADMIN_KEY = process.env.ADMIN_KEY || persisted('admin_key.txt', () => crypto.randomBytes(9).toString('base64url'));
const vapid = (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : JSON.parse(persisted('vapid.json', () => JSON.stringify(webpush.generateVAPIDKeys())));
const CONTACT = process.env.CONTACT_EMAIL || 'contact@example.org';
webpush.setVapidDetails('mailto:' + CONTACT, vapid.publicKey, vapid.privateKey);

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TTL_H = 24;    // durée de vie publique d'un ping
const PURGE_H = 72;  // suppression définitive (fenêtre de re-déclaration)
const REPORT_THRESHOLD = 3;
const TYPES = { besoin: ['humain', 'materiel', 'medical'], offre: ['collecte', 'refuge'] };
const ALL_TYPES = [...TYPES.besoin, ...TYPES.offre];
const TYPE_LABEL = { humain: '🙋 Bras / véhicule', materiel: '📦 Matériel', medical: '⚕️ Médical', collecte: '📥 Point de collecte', refuge: '🏠 Refuge' };

// ---------- journalisation des erreurs ----------
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
function logErr(context, err) {
  const line = `[${new Date().toISOString()}] ${context} — ${err?.stack || err}\n`;
  console.error(line.trim());
  try { fs.appendFileSync(path.join(LOG_DIR, 'error.log'), line); } catch {}
}
process.on('unhandledRejection', e => logErr('unhandledRejection', e));
process.on('uncaughtException', e => { logErr('uncaughtException (arrêt)', e); process.exit(1); });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// Toute route async qui rejette part dans le middleware d'erreur au lieu de
// tuer le process (les middlewares à 3 arguments ne sont pas touchés)
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (route, ...handlers) => orig(route, ...handlers.map(f =>
    typeof f === 'function' && f.length < 3
      ? (req, res, next) => Promise.resolve(f(req, res)).catch(next)
      : f));
}

// ---------- identité cookie & code de session ----------
const hashFid = fid => crypto.createHmac('sha256', SECRET).update(fid).digest('hex');
function setFidCookie(req, res, fid) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fid=${fid}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`);
}
// Le code de session (remis une seule fois à l'onboarding) DÉRIVE le cookie :
// fid = HMAC(SECRET, code). Le serveur ne stocke ni le code ni le cookie — le
// saisir sur un autre appareil reconstruit mathématiquement la même identité.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // sans 0/O/1/I ambigus
function genSessionCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `FEU-${s.slice(0, 4)}-${s.slice(4)}`;
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^FEU/, '');
const fidFromCode = code => crypto.createHmac('sha256', SECRET).update('fid|' + code).digest('hex').slice(0, 48);

app.use((req, res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';')
    .map(s => s.trim().split('=')).filter(a => a[0]).map(a => [a[0], decodeURIComponent(a.slice(1).join('='))]));
  let fid = cookies.fid;
  if (!fid || !/^[a-f0-9]{48}$/.test(fid)) {
    fid = crypto.randomBytes(24).toString('hex');
    setFidCookie(req, res, fid);
  }
  req.hash = hashFid(fid);
  next();
});

// ---------- rate limit maison (généreux : CGNAT) ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  return ++b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 600000).unref();
function limited(name, max) {
  return (req, res, next) => rateLimit(`${name}:${req.ip}`, max, 3600000) ? next()
    : res.status(429).json({ error: 'Trop de requêtes, réessayez plus tard.' });
}

async function isBanned(hash) {
  const r = await q('SELECT banned FROM identities WHERE hash=?', [hash]);
  return r.length && r[0].banned === 1;
}
function distKm(la1, lo1, la2, lo2) {
  const r = x => x * Math.PI / 180, R = 6371;
  const h = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const newId = () => crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'a').slice(0, 10);
const cleanPhone = p => { const s = String(p || '').replace(/[^+0-9 ]/g, '').trim().slice(0, 25); return s.length >= 6 ? s : null; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// identifiant opaque d'un dépanneur au sein d'un ping : permet à l'émetteur de
// cibler une demande de numéro sans jamais voir le hash d'identité du dépanneur
const aidOf = (pingId, helperHash) => crypto.createHmac('sha256', SECRET).update(`aid|${pingId}|${helperHash}`).digest('hex').slice(0, 12);

// ---------- push ----------
async function pushTo(hash, payload) {
  const rows = await q('SELECT subscription FROM watchers WHERE hash=? AND subscription IS NOT NULL', [hash]);
  if (!rows.length) return;
  try {
    await webpush.sendNotification(JSON.parse(rows[0].subscription), JSON.stringify(payload), { TTL: 3600 });
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410)
      await q('UPDATE watchers SET subscription=NULL WHERE hash=?', [hash]);
  }
}
async function pushWatchers(ping) {
  const rows = await q('SELECT hash, subscription, cats, lat, lng, radius_km FROM watchers WHERE subscription IS NOT NULL AND hash<>?', [ping.owner_hash]);
  const payload = {
    title: `${TYPE_LABEL[ping.type]} — ${ping.kind === 'besoin' ? 'nouveau SOS' : 'nouveau refuge'}`,
    body: ping.title,
    url: `/#p=${ping.id}`,
  };
  for (const w of rows) {
    if (!w.cats.split(',').includes(ping.type)) continue;
    if (w.lat != null && distKm(+w.lat, +w.lng, +ping.lat, +ping.lng) > w.radius_km) continue;
    pushTo(w.hash, payload); // fire and forget
  }
}

// ---------- couche feux : proxy NASA GIBS avec cache ----------
// Pourquoi un proxy : (1) la NASA publie avec 3-24 h de latence, il faut servir la
// DERNIÈRE date réellement disponible (lue dans les capabilities WMTS), pas
// « aujourd'hui » qui est souvent vide ; (2) le cache mutualise les tuiles entre
// tous les visiteurs au lieu de marteler GIBS depuis chaque mobile.
// Les deux VIIRS 375 m uniquement : MODIS (1 km) rend en plus un voile bleu de
// fauchée satellite sur les journées incomplètes, illisible sur la carte
const FIRE_LAYERS = 'VIIRS_SNPP_Thermal_Anomalies_375m_All,VIIRS_NOAA20_Thermal_Anomalies_375m_All';
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const fireTiles = new Map(); // clé bbox|taille|date → {buf, at}
let fireDate = null;

async function refreshFireDate() {
  try {
    const r = await fetch('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml', { signal: AbortSignal.timeout(20000) });
    const xml = await r.text();
    const section = xml.split('VIIRS_SNPP_Thermal_Anomalies_375m_All')[1] || '';
    const def = (section.match(/<Default>(\d{4}-\d{2}-\d{2})<\/Default>/) || [])[1];
    if (def) fireDate = def;
  } catch (e) { logErr('refreshFireDate', e); }
  if (!fireDate) fireDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // repli : hier
}

app.get('/fires/wms', async (req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=1800');
  try {
    const bbox = String(req.query.bbox || '');
    if (!/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(bbox)) return res.status(400).end(EMPTY_PNG);
    const w = Math.min(512, parseInt(req.query.width) || 512);
    const h = Math.min(512, parseInt(req.query.height) || 512);
    const key = `${bbox}|${w}x${h}|${fireDate}`;
    const hit = fireTiles.get(key);
    // succès gardé 30 min ; échec gardé 2 min (GIBS est parfois lent : on répond
    // transparent tout de suite plutôt que de bloquer chaque client 15 s)
    if (hit && Date.now() - hit.at < (hit.fail ? 120_000 : 1_800_000)) return res.end(hit.buf);
    let buf = null;
    try {
      const r = await fetch('https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi' +
        `?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&FORMAT=image%2Fpng&TRANSPARENT=TRUE&SRS=EPSG%3A3857` +
        `&LAYERS=${encodeURIComponent(FIRE_LAYERS)}&BBOX=${bbox}&WIDTH=${w}&HEIGHT=${h}&TIME=${fireDate}`,
        { signal: AbortSignal.timeout(25000) }); // GIBS peut être très lent ; l'échec est mis en cache 2 min
      if (r.ok && (r.headers.get('content-type') || '').includes('image')) buf = Buffer.from(await r.arrayBuffer());
    } catch {}
    // Ne garder que les pixels de feu (rouge net) : GIBS peint aussi en bleu la
    // fauchée / les zones « pas encore ingérées » du jour en cours → carrés bleus
    if (buf) {
      try {
        const png = PNG.sync.read(buf);
        const d = png.data;
        for (let i = 0; i < d.length; i += 4) {
          if (!(d[i] > d[i + 1] + 60 && d[i] > d[i + 2] + 60)) d[i + 3] = 0;
        }
        buf = PNG.sync.write(png);
      } catch {} // format inattendu → on sert tel quel
    }
    fireTiles.set(key, buf ? { buf, at: Date.now() } : { buf: EMPTY_PNG, at: Date.now(), fail: true });
    if (!buf) return res.end(EMPTY_PNG);
    if (fireTiles.size > 300) fireTiles.delete(fireTiles.keys().next().value); // LRU grossier, ~15 Mo max
    res.end(buf);
  } catch { res.end(EMPTY_PNG); } // une tuile transparente vaut mieux qu'une carte cassée
});

// ---------- couche feux : détections vectorielles FIRMS (canal principal) ----------
// Une requête serveur toutes les 10 min pour TOUS les visiteurs (quota FIRMS :
// 5 000 / 10 min — on en consomme 3). Chaque point garde son heure d'acquisition,
// sa confiance et sa puissance : la carte peut dire QUAND le feu a été vu.
const FIRMS_KEY = process.env.FIRMS_MAP_KEY || '';
const FIRMS_BBOX = '-2.0,43.3,1.5,46.2'; // west,south,east,north — même zone que l'import (à adapter si fork)
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
let firePoints = [], fireUpdatedAt = null;

function parseFirmsCsv(text) {
  const lines = text.trim().split('\n');
  const idx = Object.fromEntries(lines.shift().split(',').map((h, i) => [h.trim(), i]));
  const out = [];
  for (const line of lines) {
    const c = line.split(',');
    const lat = parseFloat(c[idx.latitude]), lng = parseFloat(c[idx.longitude]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const hhmm = String(c[idx.acq_time] || '0').padStart(4, '0');
    out.push({
      lat, lng,
      t: `${c[idx.acq_date]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
      sat: { N: 'Suomi-NPP', N20: 'NOAA-20', N21: 'NOAA-21', 1: 'NOAA-20', 2: 'NOAA-21' }[c[idx.satellite]] || c[idx.satellite],
      conf: c[idx.confidence], // l / n / h
      frp: parseFloat(c[idx.frp]) || null,
    });
  }
  return out;
}

async function refreshFirms() {
  if (!FIRMS_KEY) return;
  try {
    const all = [];
    for (const src of FIRMS_SOURCES) {
      const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_KEY}/${src}/${FIRMS_BBOX}/2`,
        { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (!r.ok || /^(Invalid|Error)/i.test(text)) throw new Error(`${src}: ${text.slice(0, 100)}`);
      all.push(...parseFirmsCsv(text));
    }
    firePoints = all;
    fireUpdatedAt = new Date().toISOString();
  } catch (e) { logErr('refreshFirms', e); } // les derniers points connus restent servis
}

app.get('/api/fires', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (FIRMS_KEY && fireUpdatedAt) return res.json({ mode: 'firms', updatedAt: fireUpdatedAt, points: firePoints });
  res.json({ mode: 'gibs', date: fireDate }); // repli raster si pas de clé / premier fetch raté
});

// ---------- uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1_500_000, files: 2 },
});
function saveUpload(file, kindAllowed) {
  if (!file) return null;
  const ok = {
    photo: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' },
    audio: { 'audio/webm': '.webm', 'video/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav' },
  }[kindAllowed];
  const ext = ok[(file.mimetype || '').split(';')[0]];
  if (!ext) return null;
  const name = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UP_DIR, name), file.buffer);
  return name;
}
function deleteFiles(ping) {
  for (const f of [ping.photo, ping.audio]) {
    if (f && /^[a-f0-9]+\.[a-z0-9]+$/.test(f)) fs.rmSync(path.join(UP_DIR, f), { force: true });
  }
}

// ============================================================
// API
// ============================================================

// Fait basculer toutes les traces d'une identité vers un nouveau hash
// (émission/régénération du code : le cookie devient celui dérivé du code)
async function migrateIdentity(oldHash, newHash) {
  if (oldHash === newHash) return;
  await q('UPDATE IGNORE identities SET hash=? WHERE hash=?', [newHash, oldHash]);
  await q('DELETE FROM identities WHERE hash=?', [oldHash]);
  for (const [t, cols] of [['pings', ['owner_hash']], ['arrivals', ['helper_hash']], ['reports', ['reporter_hash']],
    ['watchers', ['hash']], ['contact_requests', ['requester_hash', 'target_hash']]]) {
    for (const col of cols) await q(`UPDATE IGNORE ${t} SET ${col}=? WHERE ${col}=?`, [newHash, oldHash]);
  }
}

// Émettre (ou régénérer) le code de session — l'ancien code devient invalide
app.post('/api/session/code', limited('code-gen', 10), async (req, res) => {
  const code = genSessionCode();
  const fid = fidFromCode(normCode(code));
  const newHash = hashFid(fid);
  await q('INSERT IGNORE INTO identities (hash) VALUES (?)', [req.hash]); // identité assurée avant bascule
  await migrateIdentity(req.hash, newHash);
  setFidCookie(req, res, fid);
  res.json({ code });
});

// Récupérer sa session sur un nouvel appareil avec le code
app.post('/api/session/recover', limited('recover', 10), async (req, res) => {
  const code = normCode(req.body.code);
  if (code.length !== 8) return res.status(400).json({ error: 'Code invalide (format FEU-XXXX-XXXX).' });
  const fid = fidFromCode(code);
  const found = await q('SELECT name FROM identities WHERE hash=?', [hashFid(fid)]);
  if (!found.length) return res.status(404).json({ error: 'Code inconnu.' });
  setFidCookie(req, res, fid);
  res.json({ ok: true, name: found[0].name });
});

// Profil d'onboarding (facultatif, sur l'honneur)
app.post('/api/onboard', limited('onboard', 30), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40) || null;
  const prof = ['pompier', 'policier', 'soignant'].includes(req.body.profession) ? req.body.profession : null;
  await q('INSERT INTO identities (hash, name, profession) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), profession=VALUES(profession)', [req.hash, name, prof]);
  res.json({ ok: true });
});

// État global — l'unique endpoint de polling
app.get('/api/state', async (req, res) => {
  const pings = await q(`
    SELECT p.*, i.name AS owner_name, i.profession AS owner_prof
    FROM pings p LEFT JOIN identities i ON i.hash = p.owner_hash
    WHERE p.hidden = 0 AND p.status = 'open' AND p.created_at > NOW() - INTERVAL ${TTL_H} HOUR
    ORDER BY p.created_at DESC LIMIT 500`);
  const ids = pings.map(p => p.id);
  const [updates, arrivals, myReqs, zones, alertCount, statsRow, meRows, myWatch, myExpired, officials] = await Promise.all([
    ids.length ? q(`SELECT ping_id, text, created_at FROM ping_updates WHERE ping_id IN (?) ORDER BY created_at`, [ids]) : [],
    ids.length ? q(`SELECT a.ping_id, a.helper_hash, a.eta, a.phone, a.lat, a.lng, a.pos_at, a.created_at, i.name, i.profession
                    FROM arrivals a LEFT JOIN identities i ON i.hash=a.helper_hash WHERE a.ping_id IN (?)`, [ids]) : [],
    q(`SELECT c.*, p.title AS ping_title, p.owner_hash, ri.name AS requester_name, ri.profession AS requester_prof
       FROM contact_requests c JOIN pings p ON p.id=c.ping_id
       LEFT JOIN identities ri ON ri.hash=c.requester_hash
       WHERE (c.requester_hash=? OR c.target_hash=? OR (c.target_hash='' AND p.owner_hash=?))
         AND c.created_at > NOW() - INTERVAL ${TTL_H} HOUR`, [req.hash, req.hash, req.hash]),
    q('SELECT id, label, lat, lng, radius_m FROM zones'),
    q('SELECT COUNT(*) AS n FROM watchers WHERE subscription IS NOT NULL'),
    q("SELECT v FROM stats WHERE k='resolved'"),
    q('SELECT name, profession FROM identities WHERE hash=?', [req.hash]),
    q('SELECT cats, lat, lng, radius_km, visible, offer_cats, subscription IS NOT NULL AS subscribed FROM watchers WHERE hash=?', [req.hash]),
    q(`SELECT id, kind, type, title, message, private_message, lat, lng FROM pings
       WHERE owner_hash=? AND created_at <= NOW() - INTERVAL ${TTL_H} HOUR AND created_at > NOW() - INTERVAL ${PURGE_H} HOUR`, [req.hash]),
    q('SELECT id, type, label, detail, lat, lng, source FROM official_points'),
  ]);

  const upd = {}, arr = {};
  for (const u of updates) (upd[u.ping_id] ||= []).push({ text: u.text, at: u.created_at });
  for (const a of arrivals) (arr[a.ping_id] ||= []).push(a);

  const out = pings.map(p => {
    const mine = p.owner_hash === req.hash;
    const list = arr[p.id] || [];
    const engaged = mine || list.some(a => a.helper_hash === req.hash);
    return {
      id: p.id, kind: p.kind, type: p.type, title: p.title, message: p.message,
      places: p.places, animals: p.animals == null ? null : !!p.animals, isFull: !!p.is_full,
      // partie privée : réservée à l'émetteur et à ceux qui ont dit « j'arrive »
      hasPrivate: !!p.private_message,
      privateMessage: engaged ? p.private_message : undefined,
      lat: +p.lat, lng: +p.lng, photo: p.photo, audio: p.audio,
      at: p.created_at, ownerName: p.owner_name, ownerProf: p.owner_prof,
      mine, iArrive: list.some(a => a.helper_hash === req.hash),
      updates: upd[p.id] || [],
      arrivals: list.map(a => {
        const self = a.helper_hash === req.hash;
        return {
          name: a.name, prof: a.profession, eta: a.eta, at: a.created_at, self,
          aid: mine ? aidOf(p.id, a.helper_hash) : undefined, // cible d'une demande de numéro
          phone: mine ? a.phone : undefined, // le numéro laissé par un dépanneur n'est visible que de l'émetteur
          // la position d'un dépanneur n'est visible que de l'émetteur (et de lui-même)
          lat: (mine || self) && a.lat != null ? +a.lat : undefined,
          lng: (mine || self) && a.lng != null ? +a.lng : undefined,
          posAt: (mine || self) && a.pos_at ? a.pos_at : undefined,
        };
      }),
    };
  });

  // demandes de numéro, dans les deux sens : je suis destinataire (à traiter en
  // bannière) et/ou demandeur (réponses reçues)
  const contact = { incoming: [], outgoing: [] };
  for (const c of myReqs) {
    const iAmTarget = c.target_hash ? c.target_hash === req.hash
      : (c.owner_hash === req.hash && c.requester_hash !== req.hash);
    if (iAmTarget) {
      contact.incoming.push({ id: c.id, pingId: c.ping_id, pingTitle: c.ping_title, status: c.status, name: c.requester_name, prof: c.requester_prof, fromOwner: !!c.target_hash, at: c.created_at });
    }
    if (c.requester_hash === req.hash) {
      contact.outgoing.push({
        pingId: c.ping_id, pingTitle: c.ping_title, status: c.status,
        phone: c.status === 'accepted' ? c.phone : undefined,
        message: c.status !== 'pending' ? c.message : undefined,
        aid: c.target_hash ? aidOf(c.ping_id, c.target_hash) : undefined, // demande émetteur→dépanneur
        at: c.created_at,
      });
    }
  }

  res.json({
    pings: out,
    zones: zones.map(z => ({ id: z.id, label: z.label, lat: +z.lat, lng: +z.lng, r: z.radius_m })),
    officials: officials.map(o => ({ ...o, lat: +o.lat, lng: +o.lng })),
    fireDate,
    stats: {
      besoins: out.filter(p => p.kind === 'besoin').length,
      collectes: out.filter(p => p.type === 'collecte').length,
      refuges: out.filter(p => p.type === 'refuge').length,
      alerte: alertCount[0]?.n || 0, // dépanneurs abonnés aux notifications
      resolved: statsRow[0]?.v || 0,
    },
    me: { name: meRows[0]?.name || null, prof: meRows[0]?.profession || null, watch: myWatch[0] || null },
    myExpired,
    contact,
    vapidKey: vapid.publicKey,
  });
});

// Créer un ping
app.post('/api/pings', limited('create', 20), upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  if (await isBanned(req.hash)) return res.status(403).json({ error: 'Accès suspendu.' });
  const { kind, type } = req.body;
  const title = String(req.body.title || '').trim().slice(0, 80);
  const message = String(req.body.message || '').trim().slice(0, 1000);
  const privMsg = String(req.body.private_message || '').trim().slice(0, 500);
  const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
  if (!TYPES[kind]?.includes(type)) return res.status(400).json({ error: 'Type invalide.' });
  if (!title) return res.status(400).json({ error: 'Un titre court est requis.' });
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Position invalide.' });

  const id = newId();
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const photo = saveUpload(req.files?.photo?.[0], 'photo');
  const audio = saveUpload(req.files?.audio?.[0], 'audio');
  // champs structurés des refuges citoyens
  const places = type === 'refuge' && isFinite(parseInt(req.body.places)) ? Math.min(500, Math.max(1, parseInt(req.body.places))) : null;
  const animals = type === 'refuge' ? (req.body.animals === '1' ? 1 : 0) : null;
  await q('INSERT INTO pings (id, owner_hash, kind, type, title, message, private_message, lat, lng, photo, audio, close_code, places, animals) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, req.hash, kind, type, title, message || null, privMsg || null, lat, lng, photo, audio, code, places, animals]);
  pushWatchers({ id, owner_hash: req.hash, kind, type, title, lat, lng }).catch(() => {});
  res.json({ id, closeCode: code });
});

// J'arrive (toggle) — avec ETA et numéro facultatifs
app.post('/api/pings/:id/arrive', limited('act', 120), async (req, res) => {
  if (await isBanned(req.hash)) return res.status(403).json({ error: 'Accès suspendu.' });
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open' AND hidden=0", [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'Ping introuvable ou clos.' });
  const existing = await q('SELECT 1 FROM arrivals WHERE ping_id=? AND helper_hash=?', [p.id, req.hash]);
  if (req.body.cancel || existing.length) {
    await q('DELETE FROM arrivals WHERE ping_id=? AND helper_hash=?', [p.id, req.hash]);
    if (!req.body.cancel && !existing.length) return res.json({ arrived: false });
    return res.json({ arrived: false });
  }
  const eta = ['~15 min', '~30 min', '~1 h', '~2 h et +'].includes(req.body.eta) ? req.body.eta : null;
  const phone = cleanPhone(req.body.phone);
  const pos = validHelperPos(req.body.lat, req.body.lng, p);
  await q('INSERT INTO arrivals (ping_id, helper_hash, eta, phone, lat, lng, pos_at) VALUES (?,?,?,?,?,?,?)',
    [p.id, req.hash, eta, phone, pos?.lat ?? null, pos?.lng ?? null, pos ? new Date() : null]);
  const who = (await q('SELECT name, profession FROM identities WHERE hash=?', [req.hash]))[0] || {};
  pushTo(p.owner_hash, {
    title: `🚗 ${who.name || 'Quelqu’un'}${who.profession ? ' (se déclare ' + who.profession + ')' : ''} arrive`,
    body: `${p.title}${eta ? ' — ' + eta : ''}`,
    url: `/#p=${p.id}`,
  }).catch(() => {});
  res.json({ arrived: true });
});

// Position partagée par un dépanneur : bornes géographiques strictes et
// plausibilité (≤ 300 km du ping) — jamais publique, visible du seul émetteur
function validHelperPos(lat, lng, ping) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (distKm(lat, lng, +ping.lat, +ping.lng) > 300) return null;
  return { lat, lng };
}

// Rafraîchir sa position quand on est en route (réservé aux dépanneurs engagés)
app.post('/api/pings/:id/position', limited('act', 240), async (req, res) => {
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open'", [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'Ping introuvable.' });
  const mine = (await q('SELECT 1 FROM arrivals WHERE ping_id=? AND helper_hash=?', [p.id, req.hash])).length;
  if (!mine) return res.status(403).json({ error: 'Cliquez d’abord sur « j’arrive ».' });
  const pos = validHelperPos(req.body.lat, req.body.lng, p);
  if (!pos) return res.status(400).json({ error: 'Position invalide ou trop éloignée.' });
  await q('UPDATE arrivals SET lat=?, lng=?, pos_at=NOW() WHERE ping_id=? AND helper_hash=?', [pos.lat, pos.lng, p.id, req.hash]);
  res.json({ ok: true });
});

// Clôturer (cookie propriétaire OU code de secours)
app.post('/api/pings/:id/close', limited('act', 120), async (req, res) => {
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open'", [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'Ping introuvable.' });
  const byCode = req.body.code && String(req.body.code) === p.close_code;
  if (p.owner_hash !== req.hash && !byCode) {
    // anti-brute-force du code à 4 chiffres : 10 essais/heure par IP
    if (req.body.code && !rateLimit(`code:${req.ip}`, 10, 3600000))
      return res.status(429).json({ error: 'Trop d’essais, réessayez plus tard.' });
    return res.status(403).json({ error: 'Seul l’émetteur peut clôturer (ou via le code de clôture).' });
  }
  await q("UPDATE pings SET status='closed', closed_at=NOW() WHERE id=?", [p.id]);
  if (p.kind === 'besoin') await q("UPDATE stats SET v=v+1 WHERE k='resolved'");
  res.json({ ok: true });
});

// Basculer complet / places disponibles (refuges, émetteur uniquement)
app.post('/api/pings/:id/full', limited('act', 120), async (req, res) => {
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open'", [req.params.id]))[0];
  if (!p || p.owner_hash !== req.hash) return res.status(403).json({ error: 'Réservé à l’émetteur.' });
  await q('UPDATE pings SET is_full=? WHERE id=?', [req.body.full ? 1 : 0, p.id]);
  res.json({ ok: true });
});

// Ajouter une mise à jour (émetteur uniquement)
app.post('/api/pings/:id/update', limited('act', 120), async (req, res) => {
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open'", [req.params.id]))[0];
  if (!p || p.owner_hash !== req.hash) return res.status(403).json({ error: 'Réservé à l’émetteur.' });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Texte vide.' });
  await q('INSERT INTO ping_updates (ping_id, text) VALUES (?,?)', [p.id, text]);
  res.json({ ok: true });
});

// Signaler
app.post('/api/pings/:id/report', limited('act', 60), async (req, res) => {
  const p = (await q("SELECT id FROM pings WHERE id=? AND hidden=0", [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'Ping introuvable.' });
  await q('INSERT IGNORE INTO reports (ping_id, reporter_hash) VALUES (?,?)', [p.id, req.hash]);
  const n = (await q('SELECT COUNT(*) AS n FROM reports WHERE ping_id=?', [p.id]))[0].n;
  if (n >= REPORT_THRESHOLD) await q('UPDATE pings SET hidden=1 WHERE id=?', [p.id]);
  res.json({ ok: true });
});

// Demander un numéro — deux directions :
//   sans aid : un visiteur demande le numéro de l'émetteur du ping
//   avec aid : l'émetteur demande le numéro d'un dépanneur qui a dit « j'arrive »
app.post('/api/pings/:id/contact-request', limited('act', 60), async (req, res) => {
  if (await isBanned(req.hash)) return res.status(403).json({ error: 'Accès suspendu.' });
  const p = (await q("SELECT * FROM pings WHERE id=? AND status='open' AND hidden=0", [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'Ping introuvable.' });
  const who = (await q('SELECT name, profession FROM identities WHERE hash=?', [req.hash]))[0] || {};

  if (req.body.aid) {
    if (p.owner_hash !== req.hash) return res.status(403).json({ error: 'Réservé à l’émetteur.' });
    const arr = await q('SELECT helper_hash FROM arrivals WHERE ping_id=?', [p.id]);
    const target = arr.find(a => aidOf(p.id, a.helper_hash) === req.body.aid);
    if (!target) return res.status(404).json({ error: 'Dépanneur introuvable.' });
    await q('INSERT IGNORE INTO contact_requests (ping_id, requester_hash, target_hash) VALUES (?,?,?)', [p.id, req.hash, target.helper_hash]);
    pushTo(target.helper_hash, {
      title: `📞 ${who.name || 'L’émetteur'} demande votre numéro`,
      body: p.title, url: `/#p=${p.id}`,
    }).catch(() => {});
    return res.json({ ok: true });
  }

  if (p.owner_hash === req.hash) return res.status(400).json({ error: 'C’est votre propre ping.' });
  await q("INSERT IGNORE INTO contact_requests (ping_id, requester_hash, target_hash) VALUES (?,?,'')", [p.id, req.hash]);
  pushTo(p.owner_hash, {
    title: `📞 ${who.name || 'Quelqu’un'}${who.profession ? ' (se déclare ' + who.profession + ')' : ''} demande votre numéro`,
    body: p.title,
    url: `/#p=${p.id}`,
  }).catch(() => {});
  res.json({ ok: true });
});

// Répondre à une demande de numéro (le destinataire seul) — accepter avec numéro,
// ou refuser ; dans les deux cas un court message optionnel peut accompagner
app.post('/api/contact/:reqId/respond', limited('act', 120), async (req, res) => {
  const c = (await q(`SELECT c.*, p.owner_hash, p.title FROM contact_requests c JOIN pings p ON p.id=c.ping_id WHERE c.id=?`, [req.params.reqId]))[0];
  const isTarget = c && (c.target_hash ? c.target_hash === req.hash : c.owner_hash === req.hash);
  if (!isTarget) return res.status(403).json({ error: 'Non autorisé.' });
  const message = String(req.body.message || '').trim().slice(0, 200) || null;
  if (req.body.accept) {
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Numéro invalide.' });
    await q("UPDATE contact_requests SET status='accepted', phone=?, message=? WHERE id=?", [phone, message, c.id]);
    pushTo(c.requester_hash, { title: '✅ Numéro partagé', body: `Pour « ${c.title} » — ouvrez la fiche.`, url: `/#p=${c.ping_id}` }).catch(() => {});
  } else {
    await q("UPDATE contact_requests SET status='declined', message=? WHERE id=?", [message, c.id]);
    if (message) pushTo(c.requester_hash, { title: '📨 Réponse à votre demande', body: `« ${c.title} » — ouvrez la fiche.`, url: `/#p=${c.ping_id}` }).catch(() => {});
  }
  res.json({ ok: true });
});

// Vigie / qui-vive : préférences + abonnement push
app.post('/api/watch', limited('act', 60), async (req, res) => {
  const cats = (Array.isArray(req.body.cats) ? req.body.cats : []).filter(c => ALL_TYPES.includes(c)).join(',');
  let lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { lat = null; lng = null; }
  const radius = Math.min(200, Math.max(1, parseInt(req.body.radiusKm) || 20));
  const visible = 0; // feature « halo public » retirée — la position ne sert qu'au filtre d'alertes
  let sub = null;
  if (req.body.subscription && req.body.subscription.endpoint) sub = JSON.stringify(req.body.subscription).slice(0, 4000);
  await q(`INSERT INTO watchers (hash, subscription, cats, lat, lng, radius_km, visible, offer_cats)
           VALUES (?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE subscription=COALESCE(VALUES(subscription), subscription),
             cats=VALUES(cats), lat=VALUES(lat), lng=VALUES(lng), radius_km=VALUES(radius_km),
             visible=VALUES(visible), offer_cats=VALUES(offer_cats)`,
    [req.hash, sub, cats, lat, lng, radius, visible, '']);
  res.json({ ok: true });
});
app.post('/api/watch/stop', async (req, res) => {
  await q('DELETE FROM watchers WHERE hash=?', [req.hash]);
  res.json({ ok: true });
});

// ---------- admin ----------
function adminOnly(req, res, next) {
  const k = req.headers['x-admin-key'] || req.query.key;
  if (k !== ADMIN_KEY) return res.status(403).json({ error: 'Clé admin invalide.' });
  next();
}
app.get('/api/admin/overview', adminOnly, async (req, res) => {
  const pings = await q(`
    SELECT p.*, i.name AS owner_name, (SELECT COUNT(*) FROM reports r WHERE r.ping_id=p.id) AS reports
    FROM pings p LEFT JOIN identities i ON i.hash=p.owner_hash
    WHERE p.created_at > NOW() - INTERVAL ${PURGE_H} HOUR
    ORDER BY reports DESC, p.created_at DESC LIMIT 300`);
  const zones = await q('SELECT * FROM zones');
  const officials = await q('SELECT * FROM official_points ORDER BY created_at DESC');
  res.json({ pings, zones, officials });
});
app.post('/api/admin/delete', adminOnly, async (req, res) => {
  const p = (await q('SELECT * FROM pings WHERE id=?', [req.body.id]))[0];
  if (p) { deleteFiles(p); await purgePing(p.id); }
  res.json({ ok: true });
});
app.post('/api/admin/restore', adminOnly, async (req, res) => {
  await q('UPDATE pings SET hidden=0 WHERE id=?', [req.body.id]);
  await q('DELETE FROM reports WHERE ping_id=?', [req.body.id]);
  res.json({ ok: true });
});
app.post('/api/admin/ban', adminOnly, async (req, res) => {
  await q('INSERT INTO identities (hash, banned) VALUES (?,1) ON DUPLICATE KEY UPDATE banned=1', [String(req.body.hash)]);
  res.json({ ok: true });
});
app.post('/api/admin/zone', adminOnly, async (req, res) => {
  const { label, lat, lng, radius_m } = req.body;
  if (!label || !isFinite(+lat) || !isFinite(+lng) || !(+radius_m > 0)) return res.status(400).json({ error: 'Zone invalide.' });
  await q('INSERT INTO zones (label, lat, lng, radius_m) VALUES (?,?,?,?)', [String(label).slice(0, 80), +lat, +lng, Math.min(100000, +radius_m)]);
  res.json({ ok: true });
});
app.post('/api/admin/zone-delete', adminOnly, async (req, res) => {
  await q('DELETE FROM zones WHERE id=?', [+req.body.id]);
  res.json({ ok: true });
});
app.post('/api/admin/official', adminOnly, async (req, res) => {
  const { type, label, detail, lat, lng, source } = req.body;
  if (!['refuge', 'collecte', 'info'].includes(type) || !label || !isFinite(+lat) || !isFinite(+lng))
    return res.status(400).json({ error: 'Point officiel invalide.' });
  await q('INSERT INTO official_points (type, label, detail, lat, lng, source) VALUES (?,?,?,?,?,?)',
    [type, String(label).slice(0, 100), String(detail || '').slice(0, 300) || null, +lat, +lng, String(source || '').slice(0, 120) || null]);
  res.json({ ok: true });
});
app.post('/api/admin/official-delete', adminOnly, async (req, res) => {
  await q('DELETE FROM official_points WHERE id=?', [+req.body.id]);
  res.json({ ok: true });
});
app.post('/api/admin/import-alertesfeux', adminOnly, async (req, res) => {
  const r = await runImport();
  res.json(r);
});

// ---------- pages ----------

// Lien de partage avec aperçu OpenGraph
app.get('/p/:id', async (req, res) => {
  const p = (await q("SELECT * FROM pings WHERE id=? AND hidden=0 AND created_at > NOW() - INTERVAL 24 HOUR", [req.params.id]))[0];
  const title = p ? `${TYPE_LABEL[p.type]} — ${p.title}` : 'Entraide Feu';
  const desc = p ? (p.message || 'Besoin ou offre d’aide en zone de feu — ouvrez la carte.') : 'Carte d’entraide en zone de feu.';
  const img = p?.photo ? `${BASE_URL}/uploads/${p.photo}` : `${BASE_URL}/icon.svg`;
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc.slice(0, 200))}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:type" content="website">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>location.replace('/#p=${esc(req.params.id)}')</script>
</head><body><a href="/#p=${esc(req.params.id)}">Ouvrir la carte</a></body></html>`);
});

// QR code du site (pour l'affiche imprimable)
app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(BASE_URL, { type: 'svg', margin: 1, width: 512 });
  res.type('image/svg+xml').send(svg);
});

app.use('/uploads', express.static(UP_DIR, { maxAge: '1d', immutable: true }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '30d' }));
app.use('/vendor/markercluster', express.static(path.join(__dirname, 'node_modules', 'leaflet.markercluster', 'dist'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// ---------- gestion d'erreurs (toujours en dernier) ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: 'Fichier trop volumineux (1,5 Mo max) ou invalide.' });
  logErr(`${req.method} ${req.originalUrl}`, err);
  if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur — réessayez.' });
});

// ---------- nettoyage : TTL 24 h public, purge définitive à 72 h ----------
async function purgePing(id) {
  await q('DELETE FROM ping_updates WHERE ping_id=?', [id]);
  await q('DELETE FROM arrivals WHERE ping_id=?', [id]);
  await q('DELETE FROM reports WHERE ping_id=?', [id]);
  await q('DELETE FROM contact_requests WHERE ping_id=?', [id]);
  await q('DELETE FROM pings WHERE id=?', [id]);
}
async function cleanup() {
  try {
    const old = await q(`SELECT id, photo, audio FROM pings WHERE created_at <= NOW() - INTERVAL ${PURGE_H} HOUR`);
    for (const p of old) { deleteFiles(p); await purgePing(p.id); }
    await q(`DELETE FROM contact_requests WHERE created_at <= NOW() - INTERVAL ${TTL_H} HOUR`);
    await q(`DELETE FROM watchers WHERE updated_at <= NOW() - INTERVAL 30 DAY`);
  } catch (e) { logErr('cleanup', e); }
}

// ---------- démarrage ----------
const doImport = () => runImport()
  .then(r => console.log(`Import alertesfeux.fr : ${r.ok}/${r.total} points (${r.skipped} non géolocalisables)`))
  .catch(e => logErr('import alertesfeux.fr', e));

init().then(() => {
  setInterval(cleanup, 600000).unref();
  cleanup();
  doImport();
  setInterval(doImport, 6 * 3600000).unref();
  refreshFireDate().then(() => console.log(`Couche feux (repli GIBS) : données NASA du ${fireDate}`));
  setInterval(refreshFireDate, 1800000).unref();
  if (FIRMS_KEY) {
    refreshFirms().then(() => console.log(`FIRMS : ${firePoints.length} détections sur 48 h`));
    setInterval(refreshFirms, 600000).unref();
  } else console.log('FIRMS_MAP_KEY absente — couche feux en mode raster GIBS');
  const port = Number(process.env.PORT) || 3000;
  // HTTP toujours servi (dev desktop via localhost, prod derrière le proxy TLS).
  app.listen(port, () => {
    console.log(`Entraide Feu — HTTP sur le port ${port}`);
    console.log(`Admin : ${BASE_URL}/admin.html?key=${ADMIN_KEY}`);
  });
  // HTTPS local EN PLUS (test mobile sur le LAN, certificats mkcert) — jamais en prod
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    const httpsPort = Number(process.env.HTTPS_PORT) || 3443;
    require('https').createServer({
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT),
    }, app).listen(httpsPort, () => console.log(`             + HTTPS local sur le port ${httpsPort} (téléphone : https://IP-LAN:${httpsPort})`));
  }
}).catch(e => { console.error('Init BDD impossible :', e.message); process.exit(1); });
