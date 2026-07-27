/* Entraide Feu — client */
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_META = {
  humain:   { emoji: '🙋', label: 'Bras / véhicule', color: '#d64541' },
  materiel: { emoji: '📦', label: 'Matériel',        color: '#e07b39' },
  medical:  { emoji: '⚕️', label: 'Médical',         color: '#c23b6e' },
  collecte: { emoji: '📥', label: 'Point de collecte', color: '#2e9e5b' },
  refuge:   { emoji: '🏠', label: 'Refuge',          color: '#2f6fed' },
};
const PROF_LABEL = { pompier: 'se déclare pompier 🚒', policier: 'se déclare policier 👮', soignant: 'se déclare soignant ⚕️' };

let map, state = null, filter = 'all';
let markers = new Map(), carLayers = [], zoneLayers = [], officialLayers = [], cluster = null;
let fireLayers = [], fireOn = true, fireGroup = null, fireMode = null, fireTimer = null;
let placing = null;      // { draft, marker } pendant le placement
let recBlob = null, recMime = null, mediaRec = null;
let photoBlob = null;
let openPingId = null;
let pollDelay = 20000, pollTimer = null;
let knownIds = null;

/* ---------- utilitaires ---------- */
function toast(msg, err) {
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' err' : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 5000);
}
function timeAgo(ts) {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return `il y a ${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
}
async function api(url, opts = {}) {
  if (opts.json) { opts.body = JSON.stringify(opts.json); opts.headers = { 'Content-Type': 'application/json' }; opts.method = opts.method || 'POST'; }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur réseau');
  return data;
}
function distKm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 6371;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// géolocalisation : version bavarde (dit POURQUOI ça échoue) et raccourci silencieux
const GEO_MSG = {
  denied: 'Géolocalisation refusée — autorisez-la dans les réglages du navigateur, ou placez le point à la main',
  unavailable: 'Position introuvable (GPS coupé ?) — déplacez la carte sous le repère',
  timeout: 'GPS trop lent — déplacez la carte sous le repère, ou réessayez 🎯',
  insecure: 'Connexion non sécurisée : le navigateur bloque la géolocalisation',
  unsupported: 'Géolocalisation non disponible sur ce navigateur',
};
function getPositionVerbose() {
  return new Promise(r => {
    if (!('geolocation' in navigator)) return r({ error: 'unsupported' });
    if (!window.isSecureContext) return r({ error: 'insecure' });
    navigator.geolocation.getCurrentPosition(
      p => r({ pos: { lat: p.coords.latitude, lng: p.coords.longitude } }),
      e => r({ error: e.code === 1 ? 'denied' : e.code === 2 ? 'unavailable' : 'timeout' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
  });
}
const getPosition = () => getPositionVerbose().then(r => r.pos || null);

function inDangerZone(lat, lng) {
  if (!state) return null;
  return state.zones.find(z => distKm(lat, lng, z.lat, z.lng) * 1000 <= z.r) || null;
}
function chipsToggle(container, multi = true) {
  container.querySelectorAll('.chip').forEach(ch => ch.onclick = () => {
    if (multi) return ch.classList.toggle('on');
    // sélection unique : re-cliquer la puce active la désélectionne
    const wasOn = ch.classList.contains('on');
    container.querySelectorAll('.chip').forEach(o => o.classList.remove('on'));
    ch.classList.toggle('on', !wasOn);
  });
}
const chipsValues = container => [...container.querySelectorAll('.chip.on')].map(c => c.dataset.v);

/* ---------- carte ---------- */
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([44.8, -0.9], 9); // Gironde
  L.control.attribution({ position: 'topright', prefix: false }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);

  // Points chauds satellites — vectoriel FIRMS (horodaté par point) avec
  // repli raster GIBS si le serveur n'a pas de clé. Rendu canvas : léger.
  fireGroup = L.layerGroup();
  loadFires();
  fireTimer = setInterval(loadFires, 600000);

  cluster = L.markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false });
  map.addLayer(cluster);

  // repère central fixe pour le placement (créé une fois, masqué par défaut)
  const pin = document.createElement('div');
  pin.id = 'centerPin'; pin.className = 'hidden';
  map.getContainer().appendChild(pin);
  navigator.geolocation?.getCurrentPosition(p => {
    if (!openPingId) map.setView([p.coords.latitude, p.coords.longitude], 12);
  }, () => {}, { timeout: 5000 });
}

// couleur d'un point de feu selon son âge — l'info de sécurité, c'est la fraîcheur
function fireColor(ageH) {
  return ageH < 6 ? '#ff2d20' : ageH < 12 ? '#ff8c00' : ageH < 24 ? '#c96a2a' : '#8a7d72';
}
const fireRenderer = L.canvas({ padding: .3 });

async function loadFires() {
  try {
    const d = await api('/api/fires');
    fireMode = d.mode;
    if (d.mode === 'firms') {
      fireGroup.clearLayers();
      const now = Date.now();
      for (const p of d.points) {
        const ageH = (now - new Date(p.t).getTime()) / 3600000;
        const when = new Date(p.t).toLocaleString('fr-FR', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
        L.circleMarker([p.lat, p.lng], {
          renderer: fireRenderer, radius: 5, stroke: false,
          fillColor: fireColor(ageH), fillOpacity: ageH < 24 ? .85 : .55,
        }).bindPopup(
          `🔥 <b>Détection satellite</b><br>le ${when} — il y a ${ageH < 1 ? '&lt; 1 h' : Math.round(ageH) + ' h'}<br>` +
          `confiance ${({ h: 'élevée', n: 'normale', l: 'faible' })[p.conf] || p.conf} · ${p.sat}${p.frp ? ' · ' + Math.round(p.frp) + ' MW' : ''}`
        ).addTo(fireGroup);
      }
      const fd = $('#fireDate');
      if (fd) fd.textContent = `maj ${new Date(d.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (!fireLayers.length) {
      // repli raster : l'ancien proxy GIBS
      fireLayers = [L.tileLayer.wms('/fires/wms', {
        layers: 'fires', format: 'image/png', transparent: true,
        tileSize: 512, maxNativeZoom: 11, opacity: .8, updateWhenIdle: true,
      })];
    }
    setFireLayer(fireOn);
  } catch { /* prochaine tentative dans 10 min */ }
}

function setFireLayer(on) {
  fireOn = on;
  if (fireMode === 'firms') { fireLayers.forEach(l => l.remove()); on ? fireGroup.addTo(map) : fireGroup.remove(); }
  else { fireGroup.remove(); fireLayers.forEach(l => on ? l.addTo(map) : l.remove()); }
  $('#fireToggle')?.classList.toggle('on', on);
}

function render() {
  if (!state) return;
  // stats
  const s = state.stats;
  const statsTxt = `${s.besoins} SOS · ${s.collectes} collectes · ${s.refuges} refuges · 🔔 ${s.alerte} en alerte · ✅ ${s.resolved} résolus`;
  document.querySelectorAll('.statsline').forEach(el => el.textContent = statsTxt);
  if (fireMode !== 'firms') { const fd = $('#fireDate'); if (fd && state.fireDate) fd.textContent = '(' + state.fireDate + ')'; }

  // marqueurs
  const keep = new Set();
  for (const p of state.pings) {
    if (filter !== 'all' && p.kind !== filter) continue;
    keep.add(p.id);
    const meta = TYPE_META[p.type];
    const cnt = p.isFull ? '<span class="cnt full">⛔</span>'
      : p.arrivals.length ? `<span class="cnt">${p.arrivals.length}</span>` : '';
    const icon = L.divIcon({ className: '', html: `<div class="pin${p.isFull ? ' closedk' : ''}">${meta.emoji}${cnt}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    if (markers.has(p.id)) {
      markers.get(p.id).setIcon(icon).setLatLng([p.lat, p.lng]);
    } else {
      const m = L.marker([p.lat, p.lng], { icon }).on('click', () => openSheet(p.id));
      cluster.addLayer(m);
      markers.set(p.id, m);
    }
  }
  for (const [id, m] of markers) if (!keep.has(id)) { cluster.removeLayer(m); markers.delete(id); }
  cluster.refreshClusters();

  // dépanneurs en route vers MES fiches : 🚗 visibles de moi seul (émetteur)
  carLayers.forEach(l => l.remove());
  carLayers = [];
  for (const p of state.pings.filter(p => p.mine)) {
    for (const a of p.arrivals.filter(a => a.lat != null && !a.self)) {
      carLayers.push(L.marker([a.lat, a.lng], {
        icon: L.divIcon({ className: '', html: '<div class="pin">🚗</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
      }).addTo(map).bindTooltip(`🚗 ${a.name || 'Dépanneur'} → « ${p.title.slice(0, 30)} »${a.posAt ? ' · position ' + timeAgo(a.posAt) : ''}`));
    }
  }

  // points officiels (préfecture / mairies) — non clusterisés, toujours visibles
  const O_EMOJI = { refuge: '🏠', collecte: '📥', info: 'ℹ️' };
  officialLayers.forEach(l => l.remove());
  officialLayers = state.officials.map(o =>
    L.marker([o.lat, o.lng], {
      icon: L.divIcon({ className: '', html: `<div class="offpin">${O_EMOJI[o.type] || 'ℹ️'}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
    }).addTo(map).bindPopup(
      `<b>🏛️ ${esc(o.label)}</b><br>${o.detail ? esc(o.detail) + '<br>' : ''}` +
      `${o.source ? `<span style="opacity:.7;font-size:.8em">Source : ${esc(o.source)}</span><br>` : ''}` +
      `<a href="https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}" target="_blank" rel="noopener">🧭 Itinéraire</a>`));

  // zones de danger
  zoneLayers.forEach(l => l.remove());
  zoneLayers = state.zones.map(z =>
    L.circle([z.lat, z.lng], { radius: z.r, color: '#d64541', weight: 2, dashArray: '6 6', fillOpacity: .08 })
      .addTo(map).bindTooltip('⚠️ ' + esc(z.label)));

  renderBanners();
  renderMainButtons();
  if (openPingId) renderSheet(openPingId, true);
}

/* Boutons principaux selon le rôle :
   - besoin actif → « Besoin d'aide » devient le suivi de sa demande
   - dépanneur configuré → « Je dépanne » disparaît (réglages via 👤)
   - aucun choix → les deux boutons */
function renderMainButtons() {
  const myNeed = state.pings.find(p => p.mine && p.kind === 'besoin');
  const w = state.me?.watch;
  const helperActive = !!(w && (w.cats || w.subscribed));
  const bNeed = $('#btnNeed'), bHelp = $('#btnHelp');
  if (myNeed) {
    bNeed.innerHTML = '📋 Mon SOS <span class="muted">(suivi)</span>';
    bNeed.onclick = () => { map.setView([myNeed.lat, myNeed.lng], 14); openSheet(myNeed.id); };
  } else {
    bNeed.textContent = '🆘 Lancer un SOS';
    bNeed.onclick = () => openEmit('besoin');
  }
  bHelp.classList.toggle('hidden', helperActive);
}

/* ---------- polling ---------- */
async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await api('/api/state');
    const prevIds = knownIds;
    state = data;
    knownIds = new Set(data.pings.map(p => p.id));
    if (prevIds) {
      for (const p of data.pings) {
        if (!prevIds.has(p.id) && !p.mine) { toast(`${TYPE_META[p.type].emoji} Nouveau : ${p.title}`); break; }
      }
    }
    pollDelay = 20000;
    render();
  } catch (e) {
    pollDelay = Math.min(pollDelay * 2, 180000); // backoff : on ne matraque pas un serveur qui souffre
  }
  pollTimer = setTimeout(poll, pollDelay);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- bannières ---------- */
let lastBannerKey = null;
function renderBanners() {
  // règle d'or anti-perte de saisie : on ne reconstruit jamais une zone
  // contenant le champ actif, ni une bannière dont le contenu n'a pas changé
  const active = document.activeElement;
  if (active && /INPUT|TEXTAREA/.test(active.tagName) &&
      ($('#contactBanner').contains(active) || $('#redeclare').contains(active))) return;
  const pending = state.contact.incoming.filter(c => c.status === 'pending');
  const key = `${pending[0]?.id ?? ''}|${pending.length ? '' : state.myExpired[0]?.id ?? ''}`;
  if (key === lastBannerKey) return;
  lastBannerKey = key;
  const cb = $('#contactBanner');
  if (pending.length) {
    const c = pending[0];
    cb.innerHTML = `📞 <b>${esc(c.name || 'Quelqu’un')}</b>${c.prof ? ' <span class="badge prof">' + PROF_LABEL[c.prof] + '</span>' : ''}${c.fromOwner ? ' (émetteur)' : ''}
      demande votre numéro pour «&nbsp;${esc(c.pingTitle)}&nbsp;»
      <input type="tel" id="cbPhone" placeholder="Votre numéro" autocomplete="tel">
      <input type="text" id="cbMsg" maxlength="200" placeholder="Petit message (facultatif, avec ou sans numéro)">
      <div class="row">
        <button class="btn ghost" id="cbNo">Refuser</button>
        <button class="btn" id="cbYes">Partager</button>
      </div>`;
    cb.classList.remove('hidden');
    $('#cbYes').onclick = async () => {
      const phone = $('#cbPhone').value.trim();
      if (phone.length < 6) return toast('Numéro invalide', true);
      try { await api(`/api/contact/${c.id}/respond`, { json: { accept: true, phone, message: $('#cbMsg').value.trim() } }); toast('Numéro partagé ✅'); lastBannerKey = null; poll(); }
      catch (e) { toast(e.message, true); }
    };
    $('#cbNo').onclick = async () => {
      await api(`/api/contact/${c.id}/respond`, { json: { accept: false, message: $('#cbMsg').value.trim() } }).catch(() => {});
      lastBannerKey = null; poll();
    };
  } else cb.classList.add('hidden');

  // fiches expirées à re-déclarer
  const rd = $('#redeclare');
  if (state.myExpired.length && pending.length === 0) {
    const e0 = state.myExpired[0];
    rd.innerHTML = `⏳ Votre ${e0.kind === 'besoin' ? 'SOS' : 'refuge'} «&nbsp;${esc(e0.title)}&nbsp;» a expiré (24 h). Toujours d'actualité ?
      <div class="row"><button class="btn ghost" id="rdNo">Non, oublier</button><button class="btn" id="rdYes">🔄 Re-déclarer</button></div>`;
    rd.classList.remove('hidden');
    $('#rdYes').onclick = () => { rd.classList.add('hidden'); openEmit(e0.kind, e0); };
    $('#rdNo').onclick = () => rd.classList.add('hidden');
  } else rd.classList.add('hidden');
}

/* ---------- fiche ---------- */
function openSheet(id) {
  openPingId = id;
  renderSheet(id);
  $('#sheet').classList.remove('hidden');
}
function closeSheet() { openPingId = null; $('#sheet').classList.add('hidden'); }

let lastSheetSnap = null;
function renderSheet(id, soft) {
  const p = state.pings.find(x => x.id === id);
  const el = $('#sheetContent');
  if (!p) {
    if (!soft) { el.innerHTML = '<p class="muted">Cette publication n’existe plus (clôturée ou expirée).</p>'; lastSheetSnap = null; }
    return;
  }
  const snapOf = () => JSON.stringify([p, state.contact.outgoing.filter(c => c.pingId === id)]);
  if (soft) {
    // jamais de re-rendu pendant une saisie dans la fiche, ni si rien n'a changé
    const active = document.activeElement;
    if (active && /INPUT|TEXTAREA/.test(active.tagName) && $('#sheet').contains(active)) return;
    const snap = snapOf();
    if (snap === lastSheetSnap) return;
    lastSheetSnap = snap;
  } else {
    lastSheetSnap = snapOf();
  }
  const meta = TYPE_META[p.type];
  const zone = inDangerZone(p.lat, p.lng);
  const myOut = state.contact.outgoing.find(c => c.pingId === p.id && !c.aid); // ma demande vers l'émetteur

  const isRefuge = p.type === 'refuge';
  let html = `<h3>${meta.emoji} ${esc(p.title)}</h3>
    ${p.isFull ? '<p class="warn" style="text-align:center"><b>⛔ COMPLET</b> — inutile de demander pour le moment</p>' : ''}
    <div><span class="badge" style="background:${meta.color}">${p.kind === 'besoin' ? '🆘 SOS' : '🛟 Assistance'} — ${meta.label}</span>
    ${isRefuge && p.places ? `<span class="badge">🛏️ ${p.places} places</span>` : ''}
    ${isRefuge && p.animals != null ? `<span class="badge">${p.animals ? '🐾 animaux acceptés' : '🚫 pas d’animaux'}</span>` : ''}
    <span class="badge">${timeAgo(p.at)}</span>
    ${p.ownerName ? `<span class="badge">par ${esc(p.ownerName)}</span>` : ''}
    ${p.ownerProf ? `<span class="badge prof">${PROF_LABEL[p.ownerProf]}</span>` : ''}
    ${zone ? `<span class="badge zone">⚠️ zone «&nbsp;${esc(zone.label)}&nbsp;» — ne vous y rendez pas</span>` : ''}</div>
    <p style="margin:.45rem 0"><a class="btn ghost small-btn" style="text-decoration:none"
      href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">🧭 Itinéraire (Google Maps — feux et routes coupées visibles)</a></p>`;
  if (p.message) html += `<p style="margin:.5rem 0">${esc(p.message)}</p>`;
  if (p.privateMessage) {
    html += `<div class="warn" style="border-color:#3a5a7a;background:#20303a">🔒 <b>Détails réservés :</b><br>${esc(p.privateMessage)}</div>`;
  } else if (p.hasPrivate) {
    html += `<p class="muted small">🔒 ${isRefuge ? 'Ce refuge' : 'Ce SOS'} contient des détails privés (adresse exacte, contact…) visibles après avoir cliqué «&nbsp;${isRefuge ? 'Demander à rejoindre' : 'J\'arrive'}&nbsp;».</p>`;
  }
  if (p.photo) html += `<img src="/uploads/${esc(p.photo)}" alt="photo" loading="lazy">`;
  if (p.audio) html += `<audio controls preload="none" src="/uploads/${esc(p.audio)}"></audio>`;
  for (const u of p.updates) html += `<div class="updates"><div>🔄 ${esc(u.text)} <span class="muted small">(${timeAgo(u.at)})</span></div></div>`;

  if (p.arrivals.length) {
    html += `<div class="arrivals"><b>${isRefuge ? '🙋 ' + p.arrivals.length + ' demande(s)' : '🚗 ' + p.arrivals.length + ' en route'} :</b><ul>`;
    for (const a of p.arrivals) {
      let contactBit = '';
      if (a.phone) contactBit = ` — <a href="tel:${esc(a.phone)}">📞 ${esc(a.phone)}</a>`;
      else if (p.mine && a.aid && !a.self) {
        // pas de numéro laissé : l'émetteur peut le demander, le dépanneur reste libre
        const o = state.contact.outgoing.find(c => c.pingId === p.id && c.aid === a.aid);
        if (!o) contactBit = ` <button class="btn ghost small-btn askNum" data-aid="${esc(a.aid)}">📞 Demander son numéro</button>`;
        else if (o.status === 'pending') contactBit = ' — <span class="muted small">📞 demande envoyée…</span>';
        else if (o.status === 'accepted') contactBit = ` — <a href="tel:${esc(o.phone)}">📞 ${esc(o.phone)}</a>${o.message ? ` <span class="muted small">«&nbsp;${esc(o.message)}&nbsp;»</span>` : ''}`;
        else contactBit = ` — <span class="muted small">n'a pas partagé son numéro${o.message ? ' : «&nbsp;' + esc(o.message) + '&nbsp;»' : ''}</span>`;
      }
      html += `<li>${esc(a.name || 'Quelqu’un')}${a.prof ? ' <span class="badge prof">' + PROF_LABEL[a.prof] + '</span>' : ''}${a.eta ? ' — ' + esc(a.eta) : ''}${contactBit}</li>`;
    }
    html += '</ul></div>';
  }
  if (myOut?.status === 'accepted' && myOut.phone) {
    html += `<p>✅ Numéro partagé : <a href="tel:${esc(myOut.phone)}" class="btn small-btn" style="display:inline-block">📞 Appeler ${esc(myOut.phone)}</a>${myOut.message ? `<br><span class="muted small">«&nbsp;${esc(myOut.message)}&nbsp;»</span>` : ''}</p>`;
  } else if (myOut?.status === 'pending') {
    html += `<p class="muted small">📞 Demande de numéro envoyée, en attente…</p>`;
  } else if (myOut?.status === 'declined') {
    html += `<p class="muted small">L’émetteur n’a pas souhaité partager son numéro${myOut.message ? ' : «&nbsp;' + esc(myOut.message) + '&nbsp;»' : ''}.</p>`;
  }

  html += `<div id="fActions"></div>`;
  el.innerHTML = html;
  // demandes de numéro ciblées vers les dépanneurs sans téléphone (émetteur)
  el.querySelectorAll('.askNum').forEach(b => b.onclick = async () => {
    try { await api(`/api/pings/${p.id}/contact-request`, { json: { aid: b.dataset.aid } }); toast('Demande envoyée 📞'); poll(); }
    catch (e) { toast(e.message, true); }
  });
  const act = $('#fActions');

  if (p.mine) {
    act.innerHTML = `
      ${isRefuge ? `<div class="row"><button class="btn ${p.isFull ? 'help' : 'ghost'}" id="fFull">${p.isFull ? '🟢 Rouvrir des places' : '⛔ Afficher complet'}</button></div>` : ''}
      <textarea id="fUpd" rows="2" maxlength="300" placeholder="Ajouter une mise à jour (ex : plus besoin d'eau, besoin de gants)"></textarea>
      <div class="row"><button class="btn ghost" id="fUpdBtn">🔄 Publier la mise à jour</button></div>
      <div class="row"><button class="btn ghost" id="fShare">📤 Partager</button><button class="btn" id="fClose">✅ Clôturer</button></div>
      <p class="small muted">🔑 Code de secours : <b>${esc(p.closeCode || '')}</b> — si vous perdez cet appareil,
      ce code permet de clôturer ${isRefuge ? 'ce refuge' : 'ce SOS'} depuis n'importe quel autre.</p>`;
    const fFull = $('#fFull');
    if (fFull) fFull.onclick = async () => {
      try { await api(`/api/pings/${p.id}/full`, { json: { full: !p.isFull } }); toast(p.isFull ? 'Refuge rouvert 🟢' : 'Refuge affiché complet ⛔'); poll(); } catch (e) { toast(e.message, true); }
    };
    $('#fUpdBtn').onclick = async () => {
      const t = $('#fUpd').value.trim(); if (!t) return;
      try { await api(`/api/pings/${p.id}/update`, { json: { text: t } }); toast('Mise à jour publiée'); poll(); } catch (e) { toast(e.message, true); }
    };
    $('#fClose').onclick = async () => {
      if (!confirm(`Clôturer ${isRefuge ? 'ce refuge' : 'ce SOS'} ? Il disparaîtra de la carte.`)) return;
      try { await api(`/api/pings/${p.id}/close`, { json: {} }); toast(`${isRefuge ? 'Refuge' : 'SOS'} clôturé ✅`); closeSheet(); poll(); } catch (e) { toast(e.message, true); }
    };
  } else if (p.iArrive) {
    const me = p.arrivals.find(a => a.self);
    act.innerHTML = `
      ${me?.posAt ? `<p class="small muted">📍 Position partagée avec l'émetteur ${timeAgo(me.posAt)}</p>` : ''}
      <div class="row"><button class="btn" id="fRefreshPos">📍 Actualiser ma position</button></div>
      <div class="row"><button class="btn ghost" id="fCancelArr">${isRefuge ? '🚫 Annuler ma demande' : '🚫 Je ne peux plus venir'}</button></div>
      <div class="row"><button class="btn ghost" id="fShare">📤 Partager</button><button class="btn ghost" id="fReport">⚠️ Signaler</button></div>`;
    $('#fRefreshPos').onclick = async () => {
      const r = await getPositionVerbose();
      if (!r.pos) return toast(GEO_MSG[r.error] || GEO_MSG.unavailable, true);
      try { await api(`/api/pings/${p.id}/position`, { json: r.pos }); toast('Position mise à jour 📍'); poll(); } catch (e) { toast(e.message, true); }
    };
    $('#fCancelArr').onclick = async () => {
      try { await api(`/api/pings/${p.id}/arrive`, { json: { cancel: true } }); toast('Prise en charge annulée'); poll(); } catch (e) { toast(e.message, true); }
    };
  } else if (p.isFull) {
    // refuge complet : pas de bouton de demande, mais partager/signaler restent
    act.innerHTML = `<div class="row"><button class="btn ghost" id="fShare">📤 Partager</button><button class="btn ghost" id="fReport">⚠️ Signaler</button></div>`;
  } else {
    act.innerHTML = `
      <div id="arrForm" class="hidden">
        <p class="small muted">J'y serai dans :</p>
        <div class="chips" id="arrEta">
          <button class="chip" data-v="~15 min">~15 min</button><button class="chip" data-v="~30 min">~30 min</button>
          <button class="chip" data-v="~1 h">~1 h</button><button class="chip" data-v="~2 h et +">~2 h et +</button>
        </div>
        <input type="tel" id="arrPhone" placeholder="Mon numéro pour l'émetteur (facultatif)" autocomplete="tel">
        <p class="small muted">📍 Votre position sera partagée avec l'émetteur (et lui seul) pour qu'il vous voie arriver.</p>
        <button class="btn" id="arrGo">✅ Confirmer : j'arrive</button>
      </div>
      <button class="btn help" id="fArrive">${isRefuge ? '🙋 Demander à rejoindre' : '🚗 J\'arrive'}</button>
      <div class="row">
        <button class="btn ghost" id="fAskPhone">📞 Demander son numéro</button>
        <button class="btn ghost" id="fShare">📤 Partager</button>
        <button class="btn ghost" id="fReport">⚠️</button>
      </div>
      <button class="linklike" id="fCodeLink">C'est ${isRefuge ? 'mon refuge' : 'mon SOS'} mais j'ai changé d'appareil (code de clôture)</button>
      <div id="fCodeForm" class="hidden">
        <div class="row">
          <input type="text" id="fCode" inputmode="numeric" maxlength="4" placeholder="Code à 4 chiffres">
          <button class="btn" id="fCodeGo">Clôturer</button>
        </div>
      </div>`;
    $('#fArrive').onclick = () => { $('#arrForm').classList.remove('hidden'); $('#fArrive').classList.add('hidden'); chipsToggle($('#arrEta'), false); };
    $('#arrGo').onclick = async () => {
      const pos = await getPosition();
      try {
        await api(`/api/pings/${p.id}/arrive`, { json: { eta: chipsValues($('#arrEta'))[0], phone: $('#arrPhone').value.trim(), lat: pos?.lat, lng: pos?.lng } });
        toast('C’est noté, vous êtes attendu 💪'); askNotifPermission(); poll();
      } catch (e) { toast(e.message, true); }
    };
    $('#fAskPhone').onclick = async () => {
      try { await api(`/api/pings/${p.id}/contact-request`, { method: 'POST', json: {} }); toast('Demande envoyée — réponse ici même'); askNotifPermission(); poll(); } catch (e) { toast(e.message, true); }
    };
    $('#fCodeLink').onclick = () => { $('#fCodeForm').classList.remove('hidden'); $('#fCodeLink').classList.add('hidden'); $('#fCode').focus(); };
    $('#fCodeGo').onclick = async () => {
      const code = $('#fCode').value.trim();
      if (!/^\d{4}$/.test(code)) return toast('Le code fait 4 chiffres', true);
      try { await api(`/api/pings/${p.id}/close`, { json: { code } }); toast('Clôturé ✅'); closeSheet(); poll(); }
      catch (e) { toast('Code incorrect', true); }
    };
  }
  const shareBtn = $('#fShare');
  if (shareBtn) shareBtn.onclick = () => sharePing(p);
  const repBtn = $('#fReport');
  if (repBtn) repBtn.onclick = async () => {
    if (!confirm('Signaler cette publication comme abusive ou fausse ?')) return;
    try { await api(`/api/pings/${p.id}/report`, { method: 'POST', json: {} }); toast('Signalement enregistré'); } catch (e) { toast(e.message, true); }
  };
}

function sharePing(p) {
  const url = `${location.origin}/p/${p.id}`;
  if (navigator.share) navigator.share({ title: p.title, url }).catch(() => {});
  else { navigator.clipboard?.writeText(url); toast('Lien copié 📋'); }
}

/* ---------- émission ---------- */
function openEmit(kind, prefill) {
  photoBlob = null; recBlob = null; $('#emitAttach').textContent = '';
  const refuge = kind === 'offre'; // l'offre citoyenne = ouvrir un refuge (les collectes sont officielles)
  $('#emitTitle').textContent = refuge ? '🏠 Ouvrir un refuge' : '🆘 Lancer un SOS';
  const types = refuge ? ['refuge'] : ['humain', 'materiel', 'medical'];
  $('#emitTypes').innerHTML = types.map(t => `<button class="chip" data-v="${t}">${TYPE_META[t].emoji} ${TYPE_META[t].label}</button>`).join('');
  chipsToggle($('#emitTypes'), false);
  $('#emitTypes').classList.toggle('hidden', refuge); // un seul type possible → pas de choix à montrer
  $('#refugeFields').classList.toggle('hidden', !refuge);
  $('#emitTypes .chip').classList.add('on');
  $('#refugePlaces').value = prefill?.places || '';
  $('#refugeAnimals').classList.toggle('on', !!prefill?.animals);
  $('#emitTitleInput').value = prefill?.title || '';
  $('#emitTitleInput').placeholder = refuge ? 'Titre court (ex : maison avec 2 chambres à Mios) *' : "Titre court (ex : besoin d'AdBlue pour camion pompier) *";
  $('#emitMsg').value = prefill?.message || '';
  $('#emitPriv').value = prefill?.private_message || '';
  if (prefill?.type) $('#emitTypes').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === prefill.type));
  $('#emitModal').dataset.kind = kind;
  $('#emitModal').dataset.prefillLat = prefill?.lat ?? '';
  $('#emitModal').dataset.prefillLng = prefill?.lng ?? '';
  $('#emitModal').classList.remove('hidden');
}

async function compressPhoto(file) {
  // canvas → recompression jpeg : réduit le poids ET supprime les EXIF (dont le GPS)
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return null;
  const max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.72));
}

function setupEmit() {
  $('#btnNeed').onclick = () => openEmit('besoin');
  $('#emitCancel').onclick = () => $('#emitModal').classList.add('hidden');

  $('#emitPhoto').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    photoBlob = await compressPhoto(f);
    if (!photoBlob) { toast('Image illisible', true); return; }
    $('#emitAttach').textContent = `📷 ${(photoBlob.size / 1024).toFixed(0)} Ko` + (recBlob ? ' + 🎙️' : '');
  };

  $('#emitRec').onclick = async () => {
    if (mediaRec?.state === 'recording') { mediaRec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recMime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      mediaRec = new MediaRecorder(stream, recMime ? { mimeType: recMime } : undefined);
      const chunks = [];
      mediaRec.ondataavailable = e => chunks.push(e.data);
      mediaRec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        recBlob = new Blob(chunks, { type: recMime || 'audio/webm' });
        recMime = recBlob.type;
        if (recBlob.size > 1_400_000) { recBlob = null; toast('Vocal trop long', true); }
        $('#emitRec').textContent = '🎙️ Vocal';
        $('#emitAttach').textContent = (photoBlob ? '📷 + ' : '') + (recBlob ? `🎙️ ${(recBlob.size / 1024).toFixed(0)} Ko` : '');
      };
      mediaRec.start();
      $('#emitRec').textContent = '⏹️ Stop (60 s max)';
      setTimeout(() => { if (mediaRec?.state === 'recording') mediaRec.stop(); }, 60000);
    } catch { toast('Micro non disponible', true); }
  };

  $('#refugeAnimals').onclick = () => $('#refugeAnimals').classList.toggle('on');
  $('#emitPlace').onclick = () => {
    const type = chipsValues($('#emitTypes'))[0];
    const title = $('#emitTitleInput').value.trim();
    if (!type) return toast('Choisissez une catégorie', true);
    if (!title) return toast('Un titre court est requis', true);
    if (type === 'refuge' && !(+$('#refugePlaces').value >= 1)) return toast('Indiquez le nombre de places', true);
    const kind = $('#emitModal').dataset.kind;
    $('#emitModal').classList.add('hidden');
    startPlacing({
      kind, type, title, message: $('#emitMsg').value.trim(), private_message: $('#emitPriv').value.trim(),
      places: type === 'refuge' ? +$('#refugePlaces').value : null,
      animals: type === 'refuge' ? $('#refugeAnimals').classList.contains('on') : null,
    },
      parseFloat($('#emitModal').dataset.prefillLat) || null,
      parseFloat($('#emitModal').dataset.prefillLng) || null);
  };
}

/* Placement façon VTC : le repère est FIXE au centre de l'écran, on déplace la
   carte dessous — précis au doigt, pas de conflit drag/pan, le pin jamais caché. */
function startPlacing(draft, lat, lng) {
  placing = { draft };
  const pin = $('#centerPin');
  pin.textContent = TYPE_META[draft.type].emoji;
  pin.classList.remove('hidden');
  $('#mainBtns').classList.add('hidden');
  $('#placeBar').classList.remove('hidden');
  if (lat != null) map.setView([lat, lng], Math.max(map.getZoom(), 14));
  else locateForPlacing(false); // tentative silencieuse, message clair si échec
  map.on('move', placeMoveCheck);
  placeMoveCheck();
}
function placeMoveCheck() {
  const c = map.getCenter();
  const z = inDangerZone(c.lat, c.lng);
  const w = $('#placeWarn');
  if (z) { w.textContent = `⚠️ zone « ${z.label} » — placez le point de rencontre en retrait !`; w.classList.remove('hidden'); }
  else w.classList.add('hidden');
}
async function locateForPlacing(manual) {
  const r = await getPositionVerbose();
  if (r.pos) { map.setView([r.pos.lat, r.pos.lng], Math.max(map.getZoom(), 15)); if (manual) toast('Repère sur votre position 🎯'); }
  else toast(GEO_MSG[r.error] || GEO_MSG.unavailable, true);
}
function stopPlacing() {
  placing = null;
  map.off('move', placeMoveCheck);
  $('#centerPin').classList.add('hidden');
  $('#placeBar').classList.add('hidden');
  $('#mainBtns').classList.remove('hidden');
}

async function submitPing() {
  const ll = map.getCenter(); // le repère est au centre de la carte
  const d = placing.draft;
  const fd = new FormData();
  fd.append('kind', d.kind); fd.append('type', d.type);
  fd.append('title', d.title); fd.append('message', d.message);
  fd.append('private_message', d.private_message || '');
  if (d.places) fd.append('places', d.places);
  if (d.animals != null) fd.append('animals', d.animals ? '1' : '0');
  fd.append('lat', ll.lat.toFixed(6)); fd.append('lng', ll.lng.toFixed(6));
  if (photoBlob) fd.append('photo', photoBlob, 'photo.jpg');
  if (recBlob) fd.append('audio', recBlob, 'voice.' + (recMime.includes('mp4') ? 'm4a' : recMime.includes('ogg') ? 'ogg' : 'webm'));
  $('#placeOk').disabled = true;
  try {
    const r = await api('/api/pings', { method: 'POST', body: fd });
    stopPlacing();
    $('#doneTitle').textContent = d.kind === 'besoin' ? '✅ SOS publié' : '✅ Refuge publié';
    $('#doneModal').classList.remove('hidden');
    $('#doneShare').onclick = () => sharePing({ id: r.id, title: d.title });
    poll();
  } catch (e) { toast(e.message, true); }
  $('#placeOk').disabled = false;
}

/* ---------- notifications push ---------- */
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined' && Notification.permission !== 'denied'; }
function isIosNoPush() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  return ios && !window.navigator.standalone && !('PushManager' in window);
}
async function subscribePush() {
  if (!pushSupported()) return null;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return null;
  const reg = await navigator.serviceWorker.ready;
  const key = state?.vapidKey; if (!key) return null;
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: arr });
  } catch { return null; }
}
async function askNotifPermission() {
  // pour l'émetteur / demandeur : un abonnement minimal suffit à recevoir ses notifications ciblées
  if (!pushSupported() || Notification.permission === 'granted') return;
  const sub = await subscribePush();
  if (sub) await api('/api/watch', { json: { ...currentWatchPrefs(), subscription: sub } }).catch(() => {});
}
function currentWatchPrefs() {
  const w = state?.me?.watch;
  return {
    cats: w ? w.cats.split(',').filter(Boolean) : [],
    lat: w?.lat, lng: w?.lng, radiusKm: w?.radius_km || 20,
  };
}

// Diagnostic notifications : dire POURQUOI ça ne marche pas et comment débloquer
// (un refus de permission ne peut jamais être contourné par le site — choix des navigateurs)
function notifDiagnostic() {
  if (!window.isSecureContext)
    return '🔒 Connexion non sécurisée : notifications impossibles. Utilisez l\'adresse HTTPS du site.';
  if (isIosNoPush())
    return '📱 iPhone : ajoutez d\'abord le site à l\'écran d\'accueil (Partager → Sur l\'écran d\'accueil), puis revenez activer.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined')
    return '❌ Ce navigateur ne prend pas en charge les notifications. Astuce : onglet ouvert, les alertes s\'affichent quand même dans la page.';
  switch (Notification.permission) {
    case 'granted':
      return state?.me?.watch?.subscribed ? '✅ Notifications actives sur cet appareil.'
        : '🟡 Autorisées — cliquez Enregistrer pour les activer.';
    case 'denied':
      return '🚫 Bloquées pour ce site. Pour débloquer : cadenas (ou ⋮) dans la barre d\'adresse → Autorisations → Notifications → Autoriser, puis revenez et ré-enregistrez. En attendant, onglet ouvert = alertes dans la page.';
    default:
      return '🔔 Le navigateur demandera votre accord au moment d\'enregistrer.';
  }
}

/* ---------- panneau je dépanne ---------- */
function setupHelp() {
  const panel = $('#helpPanel');
  chipsToggle($('#helpCats'));
  $('#helpRadius').oninput = e => $('#helpRadiusVal').textContent = e.target.value + ' km';
  $('#btnHelp').onclick = () => {
    const w = state?.me?.watch;
    if (w) {
      const watched = w.cats.split(',');
      $('#helpCats').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', watched.includes(c.dataset.v)));
      $('#helpRadius').value = w.radius_km; $('#helpRadiusVal').textContent = w.radius_km + ' km';
      $('#helpNotif').checked = !!w.subscribed;
    }
    $('#helpIosHint').hidden = true; // remplacé par le diagnostic détaillé
    $('#notifStatus').textContent = notifDiagnostic();
    panel.classList.remove('hidden');
  };
  $('#helpCancel').onclick = () => panel.classList.add('hidden');
  $('#helpOffer').onclick = () => { panel.classList.add('hidden'); openEmit('offre'); };
  $('#helpStop').onclick = async () => {
    try {
      await api('/api/watch/stop', { method: 'POST', json: {} });
      toast('Disponibilité désactivée');
      panel.classList.add('hidden');
      poll(); // le bouton « Je dépanne » réapparaît
    } catch (e) { toast(e.message, true); }
  };
  $('#helpSave').onclick = async () => {
    const cats = chipsValues($('#helpCats'));
    if (!cats.length) return toast('Cochez au moins une catégorie à surveiller', true);
    const wantNotif = $('#helpNotif').checked;
    // la position ne sert qu'à filtrer les alertes dans le rayon choisi
    let pos = { lat: state?.me?.watch?.lat, lng: state?.me?.watch?.lng };
    const got = await getPosition();
    if (got) pos = got;
    else if (pos.lat == null) { const c = map.getCenter(); pos = { lat: c.lat, lng: c.lng }; toast('Position GPS indisponible — centre de la carte utilisé'); }
    let sub = null;
    if (wantNotif) {
      sub = await subscribePush();
      if (!sub && isIosNoPush()) toast('iPhone : ajoutez le site à l’écran d’accueil pour les notifications', true);
      else if (!sub) toast('Notifications refusées par le navigateur', true);
    }
    try {
      await api('/api/watch', {
        json: { cats, lat: pos.lat, lng: pos.lng, radiusKm: +$('#helpRadius').value, subscription: sub || undefined },
      });
      toast('Alertes configurées 🔔');
      $('#notifStatus').textContent = notifDiagnostic();
      if (wantNotif && !sub) return; // panneau laissé ouvert : le diagnostic explique quoi faire
      panel.classList.add('hidden');
      poll();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- profil ---------- */
function setupProfile() {
  chipsToggle($('#pfProf'), false);
  $('#btnProfile').onclick = () => {
    const me = state?.me || {};
    $('#pfName').value = me.name || '';
    $('#pfProf').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === me.prof));
    $('#profileModal').classList.remove('hidden');
  };
  $('#pfCancel').onclick = () => $('#profileModal').classList.add('hidden');
  $('#pfSave').onclick = async () => {
    try {
      await api('/api/onboard', { json: { name: $('#pfName').value.trim(), profession: chipsValues($('#pfProf'))[0] || null } });
      toast('Profil enregistré 👤');
      $('#profileModal').classList.add('hidden');
      poll();
    } catch (e) { toast(e.message, true); }
  };
  $('#pfHelp').onclick = () => { $('#profileModal').classList.add('hidden'); $('#btnHelp').click(); };
  $('#pfInfo').onclick = () => { $('#profileModal').classList.add('hidden'); $('#infoModal').classList.remove('hidden'); };
  $('#pfReplay').onclick = () => {
    $('#profileModal').classList.add('hidden');
    obGoto(1);
    $('#obName').value = state?.me?.name || '';
    $('#onboarding').classList.remove('hidden');
  };
}

/* ---------- onboarding ---------- */
function obGoto(n) {
  for (let i = 1; i <= 5; i++) $('#ob' + i).classList.toggle('hidden', i !== n);
}
function setupOnboarding() {
  if (!localStorage.getItem('onboarded')) $('#onboarding').classList.remove('hidden');
  chipsToggle($('#obProf'), false);
  $('#obNext1').onclick = () => obGoto(2);
  $('#obNext2').onclick = () => obGoto(3);
  $('#obNext3').onclick = () => {
    if (!$('#obName').value.trim()) { toast('Votre prénom est nécessaire 🙏', true); $('#obName').focus(); return; }
    obGoto(4);
  };
  $('#obAccept').onclick = async () => {
    await api('/api/onboard', { json: { name: $('#obName').value.trim(), profession: chipsValues($('#obProf'))[0] || null } }).catch(() => {});
    poll(); // rafraîchit state.me immédiatement
    localStorage.setItem('onboarded', '1');
    obGoto(5);
  };
  $('#obNeed').onclick = () => { $('#onboarding').classList.add('hidden'); openEmit('besoin'); };
  $('#obHelp').onclick = () => { $('#onboarding').classList.add('hidden'); $('#btnHelp').click(); };
  $('#obRefuge').onclick = () => { $('#onboarding').classList.add('hidden'); openEmit('offre'); };
  $('#obSkip').onclick = () => $('#onboarding').classList.add('hidden');
}

/* ---------- init ---------- */
function setupUI() {
  $('#filters').querySelectorAll('.chip[data-f]').forEach(ch => ch.onclick = () => {
    $('#filters').querySelectorAll('.chip[data-f]').forEach(o => o.classList.remove('on'));
    ch.classList.add('on'); filter = ch.dataset.f; render();
  });
  $('#fireToggle').onclick = () => setFireLayer(!fireOn);
  $('#infoBtn').onclick = () => $('#infoModal').classList.remove('hidden');
  $('#infoClose').onclick = () => $('#infoModal').classList.add('hidden');
  $('#sheetClose').onclick = closeSheet;
  $('#placeCancel').onclick = stopPlacing;
  $('#placeLocate').onclick = () => locateForPlacing(true);
  $('#placeOk').onclick = submitPing;
  $('#doneClose').onclick = () => $('#doneModal').classList.add('hidden');
  $('#doneNotif').onclick = async () => {
    await askNotifPermission();
    const ok = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    toast(ok ? 'Notifications activées 🔔' : 'Notifications indisponibles sur cet appareil', !ok);
  };
  setupEmit(); setupHelp(); setupOnboarding(); setupProfile();
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  initMap();
  setupUI();
  await poll();
  const m = location.hash.match(/^#p=([A-Za-z0-9]+)/);
  if (m && state) {
    const p = state.pings.find(x => x.id === m[1]);
    if (p) { map.setView([p.lat, p.lng], 14); openSheet(p.id); }
    else toast('Cette fiche n’existe plus (clôturée ou expirée)', true);
  }
}
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#p=([A-Za-z0-9]+)/);
  if (m && state) { const p = state.pings.find(x => x.id === m[1]); if (p) { map.setView([p.lat, p.lng], 14); openSheet(p.id); } }
});
boot();
