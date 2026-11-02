'use strict';
/**
 * Perfiles de usuario. Cada perfil es una cuenta de LaLiga Fantasy: se crea la primera vez que alguien entra
 * con su email y contraseña del juego. Se guarda en users/<uid>.json con el email y la contraseña cifrados
 * (hacen falta para la recarga diaria automática, que vuelve a hacer login en LaLiga).
 */
const laliga = require('./laliga');
const store = require('./store');
const secure = require('./secure');

const key = uid => 'users/' + uid + '.json';
const get = uid => store.get(key(uid), { fresh: true });
const save = user => store.put(key(user.uid), user);
async function remove(uid) { await store.del(key(uid)); await store.del('snap/' + uid + '.json'); }
async function all() {
  const keys = await store.list('users/');
  const out = [];
  for (const k of keys) { const u = await store.get(k, { fresh: true }); if (u && u.uid) out.push(u); }
  return out;
}

const creds = user => ({ email: secure.decrypt(user.email), password: user.pass ? secure.decrypt(user.pass) : null });

/** Días que avisamos antes de que caduque el acceso con Google/Apple/Facebook (LaLiga lo limita a 90 días). */
const SOCIAL_WARN_DAYS = 7;
/** Estado del acceso con red social: null si entra con contraseña. */
function socialStatus(user) {
  if (!user || user.auth !== 'social') return null;
  const exp = Date.parse(user.socialExpiresAt || '') || 0;
  const daysLeft = exp ? Math.max(0, Math.floor((exp - Date.now()) / 864e5)) : null;
  return { expiresAt: user.socialExpiresAt || null, daysLeft, warn: daysLeft != null && daysLeft <= SOCIAL_WARN_DAYS };
}
/** Mensaje para volver a entrar según cómo entra el usuario. */
const reloginMessage = user => user && user.auth === 'social'
  ? 'Tu acceso con Google, Apple o Facebook ha caducado (LaLiga lo corta a los 90 días). Vuelve a entrar con "Entro con Google, Apple o Facebook"; es 1 minuto.'
  : 'Tu contraseña del fantasy ha cambiado. Vuelve a entrar.';
/**
 * Ligas globales/oficiales (p. ej. "LALIGA Fantástica", miles de mánagers) frente a ligas privadas con amigos.
 * La API no documenta el tipo, así que se mira cualquier señal: banderas de oficial/pública/patrocinada,
 * campos de tipo con esos valores o un número de mánagers mayor que el de una liga privada.
 * Si alguna global se cuela, refresh.js la detecta al leer la clasificación (más de 40 equipos) y la oculta.
 */
const MAX_PRIVATE = 25;
function isGlobalLeague(l) {
  if (!l || typeof l !== 'object') return false;
  for (const [k, v] of Object.entries(l)) {
    if (/^(is)?(official|public|global|sponsored|general)$/i.test(k) && v === true) return true;
    if (/type|kind|category|mode|class/i.test(k)) {
      const t = typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.name || v.code || v.type || v.id || '') : '';
      if (/offic|global|public|sponsor|general|dazn/i.test(t)) return true;
    }
    if (/sponsor|brand|partner/i.test(k) && v && v !== 'none') return true;
    if (/(manager|team|member|participant|user|player)s?(number|count|total|amount|size)?$|^(number|num|total|count)(of)?(managers|teams|members|participants|users)/i.test(k)
        && typeof v === 'number' && v > MAX_PRIVATE && !/id$/i.test(k)) return true;
  }
  return false;
}
const leagueList = ls => (Array.isArray(ls) ? ls : []).filter(l => !isGlobalLeague(l)).map(l => ({ id: String(l.id), name: l.name }));
const hiddenLeagueList = ls => (Array.isArray(ls) ? ls : []).filter(isGlobalLeague).map(l => ({ id: String(l.id), name: l.name, reason: 'global' }));
/** Ligas elegibles (privadas) y ocultas (globales o detectadas como enormes al cargarlas). */
function splitLeagues(raw, user) {
  const big = new Set((user && user.bigLeagues) || []);
  const all = Array.isArray(raw) ? raw : [];
  const hid = l => isGlobalLeague(l) || big.has(String(l.id));
  return {
    leagues: all.filter(l => !hid(l)).map(l => ({ id: String(l.id), name: l.name })),
    hiddenLeagues: all.filter(hid).map(l => ({ id: String(l.id), name: l.name, reason: 'global' }))
  };
}
/** Solo campos simples de cada liga (para diagnosticar el tipo si hiciera falta); nada anidado. */
const leagueMeta = ls => (Array.isArray(ls) ? ls : []).map(l => Object.fromEntries(Object.entries(l || {}).filter(([k, v]) => ['number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length <= 80)).filter(([k]) => !/money|budget|cash|token/i.test(k))));

/** Login contra LaLiga (un solo intento). Crea o actualiza el perfil. Devuelve { user, token }. */
async function login(email, password) {
  email = String(email || '').trim();
  const token = await laliga.login(email, password);
  let raw;
  try { raw = await laliga.leagues(token); } catch (e) { e.stage = 'leagues'; throw e; }
  const uid = secure.userId(email);
  const prev = await get(uid);
  const { leagues: ls, hiddenLeagues } = splitLeagues(raw, prev);
  const now = new Date().toISOString();
  const leagueId = prev && ls.some(l => l.id === prev.leagueId) ? prev.leagueId : (ls[0] ? ls[0].id : null);
  const user = {
    uid, email: secure.encrypt(email), pass: secure.encrypt(password),
    leagues: ls, leagueId, sv: prev && prev.sv ? prev.sv : 1,
    createdAt: prev ? prev.createdAt : now, lastLoginAt: now, lastRefreshAt: prev ? prev.lastRefreshAt || null : null,
    credsInvalid: false, hiddenLeagues, bigLeagues: prev && prev.bigLeagues ? prev.bigLeagues : [], leagueMeta: leagueMeta(raw)
  };
  await save(user);
  return { user, token, first: !prev };
}

/**
 * Login del modo avanzado (Google/Apple/Facebook): canjea el código pegado por tokens, comprueba con LaLiga que
 * valen (lee sus ligas) y crea o actualiza el perfil. El refresh token se guarda cifrado igual que las contraseñas.
 * Un solo intento: el código es de un solo uso.
 */
async function socialLogin(code, verifier) {
  const t = await laliga.exchangeCode(code, verifier);
  if (!t.refreshToken) throw Object.assign(new Error('LaLiga no devolvió el permiso para recargar cada noche (refresh token)'), { code: 'LOGIN_OTHER' });
  const c = laliga.idClaims(t.idToken);
  const email = String(c.email || (Array.isArray(c.emails) && c.emails[0]) || c.signInNames_emailAddress || '').trim();
  const sub = String(c.oid || c.sub || '');
  if (!email && !sub) throw Object.assign(new Error('LaLiga no devolvió a qué cuenta pertenece el acceso'), { code: 'LOGIN_OTHER' });
  const ident = email || ('sub:' + sub);
  let raw;
  try { raw = await laliga.leagues(t.accessToken); } catch (e) { e.stage = 'leagues'; throw e; }
  const uid = secure.userId(ident);
  const prev = await get(uid);
  const { leagues: ls, hiddenLeagues } = splitLeagues(raw, prev);
  const now = new Date();
  const leagueId = prev && ls.some(l => l.id === prev.leagueId) ? prev.leagueId : (ls[0] ? ls[0].id : null);
  const user = {
    ...(prev || {}), // conservar ajustes, permisos, plan y contacto al migrar el mismo uid
    uid, email: secure.encrypt(ident), auth: 'social', pass: null,
    rt: secure.encrypt(t.refreshToken),
    at: secure.encrypt(t.accessToken), atExpiresAt: new Date(now.getTime() + t.expiresIn * 1000).toISOString(),
    socialAt: now.toISOString(), socialExpiresAt: new Date(now.getTime() + laliga.SOCIAL_DAYS * 864e5).toISOString(),
    provider: String(c.idp || c.identityProvider || '').slice(0, 60) || null,
    leagues: ls, leagueId, sv: prev && prev.sv ? prev.sv : 1,
    createdAt: prev ? prev.createdAt : now.toISOString(), lastLoginAt: now.toISOString(), lastRefreshAt: prev ? prev.lastRefreshAt || null : null,
    credsInvalid: false, hiddenLeagues, bigLeagues: prev && prev.bigLeagues ? prev.bigLeagues : [], leagueMeta: leagueMeta(raw)
  };
  await save(user);
  return { user, token: t.accessToken, first: !prev, hasEmail: !!email };
}

/**
 * Token de acceso para un usuario del modo avanzado: reutiliza el guardado si le quedan más de 10 min; si no,
 * usa el refresh token (y guarda el nuevo que devuelve LaLiga). Si LaLiga lo rechaza, lanza GRANT_INVALID.
 */
async function socialAccessToken(user) {
  if (user.at && Date.parse(user.atExpiresAt || '') - Date.now() > 10 * 60e3) {
    try { return secure.decrypt(user.at); } catch (e) { /* sigue */ }
  }
  const t = await laliga.refreshSocial(secure.decrypt(user.rt));
  const fresh = (await get(user.uid)) || user;
  fresh.at = secure.encrypt(t.accessToken);
  fresh.atExpiresAt = new Date(Date.now() + t.expiresIn * 1000).toISOString();
  if (t.refreshToken) fresh.rt = secure.encrypt(t.refreshToken);
  fresh.lastTokenRefreshAt = new Date().toISOString();
  await save(fresh);
  Object.assign(user, { at: fresh.at, atExpiresAt: fresh.atExpiresAt, rt: fresh.rt });
  return t.accessToken;
}

/** Email enmascarado para mostrar en la app (ja***@gmail.com). */
function maskedEmail(user) {
  try {
    const e = secure.decrypt(user.email);
    if (e.startsWith('sub:')) return 'Cuenta de ' + (user.provider || 'Google/Apple/Facebook');
    const [a, d] = e.split('@');
    return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '***') + '@' + (d || '');
  } catch (err) { return ''; }
}

module.exports = { get, save, remove, all, creds, login, socialLogin, socialAccessToken, socialStatus, reloginMessage, SOCIAL_WARN_DAYS, leagueList, splitLeagues, leagueMeta, isGlobalLeague, maskedEmail };

