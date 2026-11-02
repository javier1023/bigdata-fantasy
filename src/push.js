'use strict';
/**
 * Notificaciones push (Web Push) de "Vigilar rivales" (Premium).
 * - Claves VAPID: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY si están en el entorno. Si no, se generan una vez y se
 *   guardan en el almacén (config/vapid.json, la privada cifrada con la clave maestra). Sin configurar nada.
 * - Perfil de cada usuario: push (suscripciones de sus móviles, máx. 5), watch (nombres que vigila),
 *   watchSince (desde cuándo vigila a cada uno) y pushSent (ids de movimientos ya avisados).
 * - Índice config/push-index.json { uid: { leagueId, watch } } con quien tiene push activas. Tras CUALQUIER recarga
 *   de una liga (cron nocturno o alguien de la liga que abre la app / toca ⟳) se avisa a todos los que vigilan a un
 *   mánager de esa liga, sin listar el almacén (listar cuenta como operación cara en Vercel Blob).
 * No hace peticiones extra a LaLiga: usa la actividad que ya trae la recarga.
 */
const webpush = require('web-push');
const store = require('./store');
const users = require('./users');
const secure = require('./secure');
const plans = require('./plan');

const VAPID_KEY = 'config/vapid.json';
const INDEX_KEY = 'config/push-index.json';
const SUBJECT = process.env.VAPID_SUBJECT || 'https://fantasy-app-pink.vercel.app';
const MAX_SUBS = 5;
const MAX_AGE_MS = 48 * 3600e3; // no se avisa de movimientos de hace más de 2 días
const PER_RUN = 3; // como mucho 3 notificaciones por usuario y recarga; el resto va resumido
// Servicios de push conocidos (evita que el servidor haga peticiones a direcciones arbitrarias)
const PUSH_HOST = /(^|\.)(push\.apple\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.microsoft\.com)$/i;

let vapidCache = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidCache = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
    return vapidCache;
  }
  const doc = await store.get(VAPID_KEY, { fresh: true }).catch(() => null);
  if (doc && doc.publicKey && doc.privateKey) {
    try { vapidCache = { publicKey: doc.publicKey, privateKey: secure.decrypt(doc.privateKey) }; return vapidCache; }
    catch (e) { console.error('VAPID guardada ilegible (¿cambió CREDS_KEY?): se generan claves nuevas'); }
  }
  const k = webpush.generateVAPIDKeys();
  await store.put(VAPID_KEY, { publicKey: k.publicKey, privateKey: secure.encrypt(k.privateKey), createdAt: new Date().toISOString() });
  vapidCache = k;
  return k;
}
const publicKey = async () => (await vapid()).publicKey;

function cleanSub(s) {
  if (!s || typeof s !== 'object') return null;
  const endpoint = String(s.endpoint || '');
  const keys = s.keys || {};
  let u;
  try { u = new URL(endpoint); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOST.test(u.hostname) || endpoint.length > 1000) return null;
  const p256dh = String(keys.p256dh || ''), auth = String(keys.auth || '');
  if (!/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{8,100}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

async function readIndex() {
  const d = await store.get(INDEX_KEY, { fresh: true }).catch(() => null);
  return d && d.users && typeof d.users === 'object' ? d : { users: {} };
}
/** Actualiza la entrada del usuario en el índice (solo escribe si cambia). */
async function syncIndex(user) {
  const idx = await readIndex();
  const want = (user.push || []).length && (user.watch || []).length ? { leagueId: String(user.leagueId || ''), watch: user.watch.slice() } : null;
  const cur = idx.users[user.uid] || null;
  if (JSON.stringify(cur) === JSON.stringify(want)) return;
  if (want) idx.users[user.uid] = want; else delete idx.users[user.uid];
  idx.updatedAt = new Date().toISOString();
  await store.put(INDEX_KEY, idx);
}

async function subscribe(user, sub, ua) {
  const s = cleanSub(sub);
  if (!s) throw Object.assign(new Error('Suscripción no válida'), { status: 400 });
  const fresh = (await users.get(user.uid)) || user;
  const list = (fresh.push || []).filter(x => x.endpoint !== s.endpoint);
  list.unshift({ ...s, ua: String(ua || '').slice(0, 120), createdAt: new Date().toISOString() });
  fresh.push = list.slice(0, MAX_SUBS);
  await users.save(fresh);
  await syncIndex(fresh);
  return fresh;
}

async function unsubscribe(user, endpoint) {
  const fresh = (await users.get(user.uid)) || user;
  const before = (fresh.push || []).length;
  fresh.push = (fresh.push || []).filter(x => x.endpoint !== String(endpoint || ''));
  if (fresh.push.length !== before) { await users.save(fresh); await syncIndex(fresh); }
  return fresh;
}

/** Lista de vigilados (nombres de mánager). Los nuevos empiezan a contar desde ahora: no se avisa de lo anterior. */
async function setWatch(user, names) {
  const clean = [...new Set((Array.isArray(names) ? names : []).map(n => String(n || '').trim()).filter(n => n && n.length <= 80))].slice(0, 40);
  const fresh = (await users.get(user.uid)) || user;
  const since = { ...(fresh.watchSince || {}) };
  const now = new Date().toISOString();
  clean.forEach(n => { if (!since[n]) since[n] = now; });
  Object.keys(since).forEach(n => { if (!clean.includes(n)) delete since[n]; });
  const same = JSON.stringify(fresh.watch || null) === JSON.stringify(clean);
  fresh.watch = clean; fresh.watchSince = since;
  if (!same) await users.save(fresh);
  if ((fresh.push || []).length) await syncIndex(fresh);
  return fresh;
}

// ---- texto de los avisos (igual que en la app) ----
const mill = v => (v / 1e6).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' M';
const MOVE = {
  buy: r => r.typeId === 31,
  sell: r => r.typeId === 33,
  trade: r => r.category === 'Mercado' && r.buyer && r.seller && r.buyer !== 'LALIGA' && r.seller !== 'LALIGA',
  lock: r => r.category === 'Blindaje'
};
const isMove = r => MOVE.buy(r) || MOVE.sell(r) || MOVE.trade(r) || MOVE.lock(r);
const involves = (r, n) => [r.buyer, r.seller, r.manager].includes(n);
function line(r, n) {
  const p = r.player, a = r.amount ? ' por ' + mill(r.amount) : '';
  if (MOVE.lock(r)) return `${n} blinda a ${p}`;
  if (MOVE.buy(r)) return `${n} ficha a ${p} del mercado${a}`;
  if (MOVE.sell(r)) return `${n} vende a ${p} a LALIGA${a}`;
  return r.buyer === n ? `${n} le compra ${p} a ${r.seller}${a}` : `${n} le vende ${p} a ${r.buyer}${a}`;
}

/** Movimientos nuevos de sus vigilados para un usuario (más recientes primero). */
function pendingFor(user, activity, now) {
  const sent = new Set(user.pushSent || []);
  const since = user.watchSince || {};
  const t = now || Date.now();
  const out = [];
  (user.watch || []).forEach(n => (activity || []).forEach(r => {
    if (!isMove(r) || !involves(r, n) || sent.has(r.id)) return;
    const d = Date.parse(r.date);
    if (!(d > (since[n] ? Date.parse(since[n]) : 0)) || t - d > MAX_AGE_MS) return;
    if (!out.some(x => x.r.id === r.id)) out.push({ r, n });
  }));
  return out.sort((a, b) => (a.r.date < b.r.date ? 1 : -1));
}

function messagesFor(pending) {
  const shown = pending.slice(0, PER_RUN).map(x => ({ title: '👀 ' + x.n, body: line(x.r, x.n), tag: 'watch-' + x.r.id, url: '/#vigilar' }));
  const rest = pending.length - shown.length;
  if (rest > 0) shown[shown.length - 1].body += ` (y ${rest} movimiento${rest > 1 ? 's' : ''} más)`;
  return shown;
}

/** Envía un mensaje a todas las suscripciones del usuario. Devuelve las que siguen vivas. */
async function sendAll(subs, msg) {
  const k = await vapid();
  const alive = [];
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), {
        vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 12 * 3600, urgency: 'high', timeout: 8000
      });
      alive.push(s); delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) continue; // el móvil ya no acepta esta suscripción
      console.error('push', e.statusCode || '', String(e.body || e.message).slice(0, 200));
      alive.push(s);
    }
  }
  return { alive, delivered };
}

/**
 * Tras recargar una liga: avisa a quien vigila a alguien de esa liga.
 * opts.viewerUid: usuario que está mirando la app en ese momento (ya ve el aviso dentro): se marca como avisado sin push.
 */
async function notifyLeague(leagueId, activity, opts = {}) {
  const idx = await readIndex();
  const cand = Object.entries(idx.users).filter(([, v]) => v && String(v.leagueId) === String(leagueId) && (v.watch || []).length);
  if (!cand.length) return { candidates: 0, sent: 0 };
  let testers = null, beta = null, sent = 0;
  for (const [uid, entry] of cand) {
    if (!pendingFor({ watch: entry.watch, watchSince: null, pushSent: [] }, activity).length) continue; // sin movimientos recientes: ni se lee el perfil
    try {
      const user = await users.get(uid);
      if (!user || !(user.push || []).length || String(user.leagueId) !== String(leagueId)) { if (user) await syncIndex(user); continue; }
      testers = testers || await plans.getTesters();
      if (beta === null) beta = await plans.getBeta();
      if (plans.planFor(user, testers, beta).plan !== 'premium') continue;
      const pending = pendingFor(user, activity);
      if (!pending.length) continue;
      let alive = user.push;
      if (uid !== opts.viewerUid) {
        for (const m of messagesFor(pending)) { const r = await sendAll(alive, m); alive = r.alive; sent += r.delivered; }
      }
      user.pushSent = (user.pushSent || []).concat(pending.map(x => x.r.id)).slice(-300);
      const lost = alive.length !== user.push.length;
      user.push = alive;
      await users.save(user);
      if (lost) await syncIndex(user);
    } catch (e) { console.error('notify ' + uid.slice(0, 6) + ':', e.message); }
  }
  return { candidates: cand.length, sent };
}

/** Aviso de prueba al activar las notificaciones en un móvil. */
async function sendWelcome(user, endpoint) {
  const s = (user.push || []).find(x => x.endpoint === endpoint);
  if (!s) return { delivered: 0 };
  const names = (user.watch || []).slice(0, 3).join(', ');
  return sendAll([s], { title: '🔔 Avisos activados', body: names ? 'Te avisaremos cuando se muevan ' + names + '.' : 'Elige a quién vigilar y te avisaremos de sus movimientos.', tag: 'welcome', url: '/#vigilar' });
}

module.exports = { publicKey, subscribe, unsubscribe, setWatch, notifyLeague, sendWelcome, pendingFor, messagesFor, cleanSub, line, syncIndex };

