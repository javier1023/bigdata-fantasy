'use strict';
/**
 * Recargas.
 * - Común (shared.json, igual para todos): jugadores, equipos, calendario, valor de ayer de cada jugador y
 *   % de titularidad de futbolfantasy. Se descarga una vez y la reutilizan todos los usuarios.
 * - Por usuario (snap/<uid>.json): login en LaLiga con sus credenciales, su liga (clasificación, actividad,
 *   plantillas) y los históricos de valor que necesitan sus cuentas.
 * - Cron diario: refresca lo común y luego a cada usuario, del más antiguo al más reciente, mientras quede tiempo.
 */
const laliga = require('./laliga');
const { build, neededPlayerIds, yesterdayValue, dayOf } = require('./snapshot');
const store = require('./store');
const users = require('./users');
const futbolfantasy = require('./futbolfantasy');
const push = require('./push');
const { bidEstimate } = require('../public/calc');

const SHARED = 'shared.json';
const snapKey = uid => 'snap/' + uid + '.json';
let sharedRunning = null;
const running = new Map();
const LOGIN_COOLDOWN_MS = 30 * 60 * 1000;
const lastLoginFailure = new Map();

function refreshShared() {
  if (sharedRunning) return sharedRunning;
  sharedRunning = (async () => {
    const t0 = Date.now();
    const pub = await laliga.fetchPublic();
    const ffP = futbolfantasy.fetchProbabilities(pub.players).catch(e => ({ error: e.message }));
    const ids = pub.players.map(p => String(p.id));
    const hist = await laliga.pool(ids, 16, id => laliga.marketValue(id));
    const fetchedAt = new Date().toISOString();
    const today = dayOf(fetchedAt);
    const yesterday = {}, bids = {};
    pub.players.forEach((p, i) => {
      const id = String(p.id), value = Number(p.marketValue || 0);
      yesterday[id] = yesterdayValue(hist[i], today, value);
      const estimate = bidEstimate(hist[i], value, fetchedAt);
      if (estimate) bids[id] = estimate.levels;
    });
    const ff = await ffP;
    let titularidad;
    if (ff.error) {
      console.error('futbolfantasy:', ff.error);
      const prev = await store.get(SHARED).catch(() => null);
      titularidad = prev && prev.titularidad && prev.titularidad.probs ? { ...prev.titularidad, error: ff.error } : { error: ff.error };
    } else {
      titularidad = { week: ff.week, fetchedAt: ff.fetchedAt, probs: ff.probs, matches: ff.matches, players: ff.players, unmatched: ff.unmatched, source: futbolfantasy.LIST_URL };
    }
    const shared = { fetchedAt, players: pub.players, teams: pub.teams, types: pub.types, calendar: pub.calendar, yesterday, bids, titularidad, ms: Date.now() - t0 };
    await store.put(SHARED, shared);
    return shared;
  })().finally(() => { sharedRunning = null; });
  return sharedRunning;
}

/** Datos comunes con una antigüedad máxima; si son más viejos (o no hay), se descargan. */
async function getShared(maxAgeMs) {
  const s = await store.get(SHARED);
  if (s && Date.now() - new Date(s.fetchedAt).getTime() < maxAgeMs) return s;
  return refreshShared();
}

/**
 * Recarga la liga de un usuario. opts.token: token recién obtenido en el login (evita un segundo login).
 * Si las credenciales guardadas ya no valen, marca el perfil y lanza RELOGIN (el usuario tiene que volver a entrar).
 */
function refreshUser(uid, opts = {}) {
  if (running.has(uid)) return running.get(uid);
  const job = (async () => {
    const t0 = Date.now();
    const user = await users.get(uid);
    if (!user) throw Object.assign(new Error('Sesión no válida'), { code: 'NO_USER' });
    if (user.credsInvalid) throw Object.assign(new Error(users.reloginMessage(user)), { code: 'RELOGIN' });
    let token = opts.token;
    if (!token && user.auth === 'social') {
      // Modo avanzado (Google/Apple/Facebook): refresh token en vez de contraseña
      if (Date.now() - (lastLoginFailure.get(uid) || 0) < LOGIN_COOLDOWN_MS) throw Object.assign(new Error('LaLiga rechazó el último intento; se podrá reintentar en unos minutos.'), { code: 'LOGIN_COOLDOWN' });
      try { token = await users.socialAccessToken(user); }
      catch (e) {
        if (e.code === 'GRANT_INVALID') {
          lastLoginFailure.set(uid, Date.now());
          const u2 = (await users.get(uid)) || user; u2.credsInvalid = true; await users.save(u2);
          throw Object.assign(new Error(users.reloginMessage(user)), { code: 'RELOGIN' });
        }
        throw e;
      }
    }
    if (!token) {
      if (Date.now() - (lastLoginFailure.get(uid) || 0) < LOGIN_COOLDOWN_MS) throw Object.assign(new Error('LaLiga rechazó el último login; se podrá reintentar en unos minutos.'), { code: 'LOGIN_COOLDOWN' });
      const c = users.creds(user);
      try { token = await laliga.login(c.email, c.password); }
      catch (e) {
        if (e.code === 'LOGIN_FAILED') {
          lastLoginFailure.set(uid, Date.now());
          if (/\(400\)|\(401\)/.test(e.message)) { user.credsInvalid = true; await users.save(user); throw Object.assign(new Error('Tu contraseña del fantasy ha cambiado. Vuelve a entrar.'), { code: 'RELOGIN' }); }
        }
        throw e;
      }
    }
    const rawLeagues = await laliga.leagues(token);
    const bigLeagues = (user.bigLeagues || []).slice();
    let split = users.splitLeagues(rawLeagues, { bigLeagues });
    let league, data, shared;
    for (let tries = 0; ; tries++) {
      const ls = split.leagues;
      league = ls.find(l => l.id === String(user.leagueId)) || ls[0];
      if (!league) throw new Error(split.hiddenLeagues.length ? 'Tu cuenta solo está en ligas globales (' + split.hiddenLeagues.map(l => l.name).join(', ') + '). Esta app es para ligas privadas con amigos.' : 'Tu cuenta no está en ninguna liga');
      const full = rawLeagues.find(l => String(l.id) === league.id);
      try {
        [shared, data] = await Promise.all([getShared(opts.sharedMaxAgeMs || 20 * 3600e3), laliga.fetchLeagueData(token, full)]);
        break;
      } catch (e) {
        // Liga enorme (global) que no se detectó por sus campos: se oculta y se prueba la siguiente
        if (e.code !== 'BIG_LEAGUE' || tries > 3) throw e;
        bigLeagues.push(league.id);
        split = users.splitLeagues(rawLeagues, { bigLeagues });
      }
    }
    const ls = split.leagues;
    const raw = { ...data, players: shared.players, teams: shared.teams, types: shared.types, calendar: shared.calendar, yesterday: shared.yesterday, bids: shared.bids, bidFetchedAt: shared.fetchedAt };
    const ids = neededPlayerIds(raw);
    const hist = await laliga.pool(ids, 16, id => laliga.marketValue(id));
    const histories = {};
    ids.forEach((id, i) => { histories[id] = hist[i]; });
    const snapshot = build(raw, histories);
    snapshot.titularidad = shared.titularidad;
    snapshot.leagues = ls;
    snapshot.hiddenLeagues = split.hiddenLeagues;
    snapshot.leagueId = league.id;
    snapshot.refreshMs = Date.now() - t0;
    await store.put(snapKey(uid), snapshot);
    const fresh = (await users.get(uid)) || user;
    Object.assign(fresh, { leagues: ls, hiddenLeagues: split.hiddenLeagues, bigLeagues, leagueMeta: users.leagueMeta(rawLeagues), leagueId: league.id, lastRefreshAt: snapshot.fetchedAt });
    await users.save(fresh);
    // Push de "Vigilar rivales" para quien vigila a alguien de esta liga (sin peticiones extra a LaLiga)
    try {
      if ((fresh.push || []).length) await push.syncIndex(fresh);
      await push.notifyLeague(league.id, snapshot.activity, { viewerUid: opts.viewer ? uid : null }); }
    catch (e) { console.error('push liga:', e.message); }
    return snapshot;
  })().finally(() => running.delete(uid));
  running.set(uid, job);
  return job;
}

const loadSnapshot = uid => store.get(snapKey(uid), { fresh: true });

/** Cron: común + usuarios (los más atrasados primero) hasta agotar el presupuesto de tiempo. */
async function refreshAll(budgetMs = 95000) {
  const t0 = Date.now();
  await refreshShared();
  const list = (await users.all()).filter(u => !u.credsInvalid)
    .sort((a, b) => String(a.lastRefreshAt || '').localeCompare(String(b.lastRefreshAt || '')));
  let ok = 0, failed = 0, skipped = 0;
  for (const u of list) {
    if (Date.now() - t0 > budgetMs) { skipped++; continue; }
    try { await refreshUser(u.uid); ok++; } catch (e) { failed++; console.error('refresh ' + u.uid.slice(0, 6) + ':', e.message); }
  }
  return { users: list.length, ok, failed, skipped, ms: Date.now() - t0 };
}

module.exports = { refreshShared, getShared, refreshUser, refreshAll, loadSnapshot };


