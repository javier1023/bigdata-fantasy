'use strict';
/**
 * Cliente mínimo de la API de LaLiga Fantasy. Solo lectura.
 * Login: Azure B2C (flujo "resource owner password") con las credenciales de las variables de entorno.
 */
const CLIENT_ID = 'fec9e3fd-8f88-45ab-8cbd-b70b9d65dde0';
const API = 'https://fantasy-api.llt-services.com';
const CMP = API + '/api/v1/competition/1';

/**
 * Login con email y contraseña. LaLiga retiró (24/9/2026) la política de contraseña directa (B2C_1A_ResourceOwnerv2,
 * ahora da 404), así que se hace lo mismo que el navegador en su página de login web: se abre la página de la
 * política de la app (PKCE), se mandan email y contraseña al formulario (SelfAsserted), se confirma y LaLiga
 * redirige con un código de un solo uso, que se canjea por el token. No se ve nada en pantalla.
 */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Códigos de B2C que significan "email o contraseña no válidos"
const BAD_CREDS = ['AADB2C90053', 'AADB2C90225', 'AADB2C90054'];

function jar() {
  const c = new Map();
  return {
    take(res) { const l = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean); l.forEach(x => { const kv = String(x).split(';')[0]; const i = kv.indexOf('='); if (i > 0) c.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }); },
    header() { return [...c].map(([k, v]) => k + '=' + v).join('; '); }
  };
}
const down = (msg, e) => Object.assign(new Error('No se pudo contactar con el login de LaLiga: ' + (e ? e.message : msg)), { code: 'LALIGA_DOWN' });
function other(msg, b2c, status) {
  const err = new Error('Login fallido: ' + msg);
  err.code = status >= 500 ? 'LALIGA_DOWN' : 'LOGIN_OTHER'; err.b2c = b2c || ''; err.detail = msg;
  return err;
}

async function login(email, password) {
  if (!email || !password) throw new Error('Faltan LALIGA_EMAIL / LALIGA_PASSWORD');
  const crypto = require('crypto');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const J = jar();
  const go = async (url, opt = {}) => {
    let r;
    try { r = await fetch(url, { redirect: 'manual', ...opt, headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', Cookie: J.header(), ...(opt.headers || {}) } }); }
    catch (e) { throw down('', e); }
    J.take(r);
    return r;
  };
  // 1. Página de login
  let r = await go(socialAuthorizeUrl(challenge, crypto.randomBytes(8).toString('hex')));
  const html = await r.text();
  if (r.status >= 500) throw down('HTTP ' + r.status);
  const csrf = (html.match(/"csrf"\s*:\s*"([^"]+)"/) || [])[1];
  const tx = (html.match(/"transId"\s*:\s*"([^"]+)"/) || [])[1];
  const tenant = (html.match(/"tenant"\s*:\s*"([^"]+)"/) || [])[1];
  const policy = (html.match(/"policy"\s*:\s*"([^"]+)"/) || [])[1] || SOCIAL_POLICY;
  const api = (html.match(/"api"\s*:\s*"([^"]+)"/) || [])[1] || 'CombinedSigninAndSignup';
  if (!csrf || !tx || !tenant) throw other('la página de login de LaLiga ha cambiado (HTTP ' + r.status + ')', '', r.status);
  if (/captcha/i.test(html)) throw other('LaLiga pide un captcha en su login', '', 403);
  const pwField = /"ID"\s*:\s*"password_login"/.test(html) ? 'password_login' : 'password';
  const host = 'https://login.laliga.es';
  const q = 'tx=' + encodeURIComponent(tx) + '&p=' + encodeURIComponent(policy);
  // 2. Email y contraseña
  r = await go(host + tenant + '/SelfAsserted?' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
    body: new URLSearchParams({ request_type: 'RESPONSE', signInName: email, [pwField]: password }).toString()
  });
  const sa = await r.json().catch(() => ({}));
  if (String(sa.status) !== '200') {
    const code = sa.errorCode || (String(sa.message || '').match(/AADB2C\d+/) || [])[0] || '';
    if (BAD_CREDS.includes(code)) { const e = new Error('Login fallido: email o contraseña no válidos (' + code + ')'); e.code = 'LOGIN_FAILED'; e.b2c = code; throw e; }
    throw other(String(sa.message || ('HTTP ' + r.status)), code, r.status >= 500 ? r.status : 400);
  }
  // 3. Confirmar: LaLiga redirige a jwt.ms con el código (puede haber algún salto intermedio)
  let url = host + tenant + '/api/' + api + '/confirmed?rememberMe=false&csrf_token=' + encodeURIComponent(csrf) + '&' + q;
  let code = null;
  for (let i = 0; i < 6 && !code; i++) {
    r = await go(url);
    const loc = r.headers.get('location');
    const found = s => { const m = String(s || '').match(/[?#&]code=([^&#"'\s]+)/); return m ? decodeURIComponent(m[1]) : null; };
    if (loc && loc.startsWith(SOCIAL_REDIRECT)) { code = found(loc); if (!code) { const m = loc.match(/error_description=([^&]+)/); throw other(m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : 'LaLiga no devolvió el código', (decodeURIComponent((loc.match(/AADB2C\d+/) || [''])[0])), 400); } break; }
    if (loc) { url = new URL(loc, url).toString(); continue; }
    const body = await r.text();
    const fm = body.match(/name=['"]code['"][^>]*value=['"]([^'"]+)/);
    code = fm ? fm[1] : found(body);
    if (!code) throw other('LaLiga pide un paso más en su login (HTTP ' + r.status + '). Entra en la app oficial para ver qué pide.', (body.match(/AADB2C\d+/) || [''])[0], r.status >= 500 ? r.status : 400);
  }
  if (!code) throw other('LaLiga no devolvió el código de acceso', '', 400);
  // 4. Canjear el código por el token
  const t = await exchangeCode(code, verifier);
  return t.accessToken;
}

/**
 * Modo avanzado para cuentas creadas con Google, Apple o Facebook (no tienen contraseña de LaLiga, así que el
 * login con contraseña de arriba nunca les vale). Es el mismo flujo que usa la app oficial (PKCE, cliente de la
 * app de LaLiga), con la página de Microsoft jwt.ms como destino: el usuario inicia sesión en la web de LaLiga,
 * acaba en jwt.ms y copia la dirección (lleva un código de un solo uso) en nuestra web. El código se canjea aquí
 * por un token de acceso (24 h) y un refresh token (hasta 90 días desde ese login), que el cron usa cada noche.
 */
const SOCIAL_POLICY = 'B2C_1A_5ULAIP_PARAMETRIZED_SIGNIN';
const SOCIAL_CLIENT = 'af88bcff-1157-40a0-b579-030728aacf0b';
const SOCIAL_REDIRECT = 'https://jwt.ms';
const SOCIAL_BASE = 'https://login.laliga.es/laligadspprob2c.onmicrosoft.com';
const SOCIAL_TOKEN_URL = SOCIAL_BASE + '/' + SOCIAL_POLICY + '/oauth2/v2.0/token';
const SOCIAL_DAYS = 90;

function socialAuthorizeUrl(challenge, state) {
  const q = new URLSearchParams({
    p: SOCIAL_POLICY, client_id: SOCIAL_CLIENT, response_type: 'code', redirect_uri: SOCIAL_REDIRECT,
    scope: 'openid offline_access', code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'login'
  });
  return SOCIAL_BASE + '/oauth2/v2.0/authorize?' + q;
}

async function socialToken(params) {
  const body = new URLSearchParams({ client_id: SOCIAL_CLIENT, scope: 'openid offline_access', ...params });
  let r;
  try { r = await fetch(SOCIAL_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
  catch (e) { throw Object.assign(new Error('No se pudo contactar con el login de LaLiga: ' + e.message), { code: 'LALIGA_DOWN' }); }
  const j = await r.json().catch(() => ({}));
  // Con scope "openid offline_access" B2C puede devolver solo id_token + refresh_token (sin access_token): la API
  // del Fantasy acepta el id_token como Bearer, igual que hace la app oficial.
  const bearer = j.access_token || j.id_token;
  if (!r.ok || !bearer) {
    const desc = String(j.error_description || '').split(/\r?\n/)[0];
    const b2c = (desc.match(/AADB2C\d+/) || [])[0] || '';
    const err = new Error('LaLiga rechazó el ' + (params.grant_type === 'refresh_token' ? 'refresh token' : 'código') + ' (' + r.status + (r.ok ? ', sin token en la respuesta: ' + Object.keys(j).join(',') : '') + '): ' + desc);
    err.code = r.status >= 500 ? 'LALIGA_DOWN' : (j.error === 'invalid_grant' || r.status === 400) ? 'GRANT_INVALID' : 'LOGIN_OTHER';
    err.b2c = b2c; err.detail = desc.replace(/^AADB2C\d+:\s*/, '');
    throw err;
  }
  const exp = Number((idClaims(bearer) || {}).exp) || 0;
  const expiresIn = j.access_token ? Number(j.expires_in) || 3600 : Number(j.id_token_expires_in) || (exp ? Math.max(60, exp - Math.floor(Date.now() / 1000)) : 3600);
  return { accessToken: bearer, refreshToken: j.refresh_token || null, idToken: j.id_token || null, expiresIn, refreshExpiresIn: Number(j.refresh_token_expires_in) || null };
}
const exchangeCode = (code, verifier) => socialToken({ grant_type: 'authorization_code', code, redirect_uri: SOCIAL_REDIRECT, code_verifier: verifier });
const refreshSocial = refreshToken => socialToken({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Datos del id_token (sin verificar la firma: viene directo de LaLiga por HTTPS en nuestra propia petición). */
function idClaims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')) || {}; } catch (e) { return {}; }
}

async function get(url, token) {
  const headers = { 'x-app': 'Fantasy-web' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'x-lang=es', { headers });
  if (!r.ok) throw new Error('API ' + r.status + ' en ' + url.replace(API, ''));
  return r.json();
}

/** Ejecuta tareas con un límite de concurrencia para no saturar la API. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

const marketValue = id => get(CMP + '/player/' + id + '/market-value').catch(() => []);
const leagueMarket = (token, id) => get(CMP + '/league/' + encodeURIComponent(id) + '/market', token);

/** Ligas del usuario (con su equipo y su caja). */
const leagues = token => get(CMP + '/leagues', token);

/** Datos públicos comunes a todos los usuarios (sin token). */
async function fetchPublic() {
  const [players, teams, types, calendar] = await Promise.all([
    get(CMP + '/players'),
    get(API + '/api/v3/teams-master'),
    get(API + '/api/v5/activity-types'),
    fetchCalendar().catch(() => null)
  ]);
  return { players, teams, types, calendar };
}

/** Datos privados de una liga: clasificación, actividad y plantillas. Necesita el token del usuario. */
async function fetchLeagueData(token, league) {
  const standing = await get(CMP + '/leagues/' + league.id + '/standing', token);
  if (Array.isArray(standing) && standing.length > 40) throw Object.assign(new Error('Liga global con ' + standing.length + ' equipos'), { code: 'BIG_LEAGUE' });
  const activity = [];
  const seen = new Set();
  for (let p = 0; p < 80; p++) {
    let page;
    try { page = await get(CMP + '/leagues/' + league.id + '/activity/' + p, token); }
    catch (e) { if (p > 0) break; throw e; }
    if (!Array.isArray(page) || page.length === 0) break;
    page.forEach(a => { if (!seen.has(String(a.id))) { seen.add(String(a.id)); activity.push(a); } });
  }
  const [squads, marketResult] = await Promise.all([
    pool(standing, 4, s => get(CMP + '/leagues/' + league.id + '/teams/' + s.team.id, token)),
    leagueMarket(token, league.id).then(value => ({ value })).catch(error => ({ error: error.message }))
  ]);
  return { league, standing, activity, squads, market: marketResult.value, marketError: marketResult.error || null, fetchedAt: new Date().toISOString() };
}

/** Jornada actual (o la siguiente si la actual ya terminó) con sus partidos, más las 5 siguientes
 *  (para "próximos partidos" de cada jugador). Público, sin token. */
async function fetchCalendar() {
  const cur = await get(CMP + '/week/current');
  const week = Number(cur.weekNumber);
  const weeks = [];
  for (let w = week; w <= Math.min(38, week + 5); w++) weeks.push(w);
  const lists = await Promise.all(weeks.map(w => get(CMP + '/calendar?weekNumber=' + w).catch(() => [])));
  const upcoming = weeks.map((w, i) => ({ week: w, matches: Array.isArray(lists[i]) ? lists[i] : [] }));
  const first = upcoming[0].matches;
  const done = first.length && first.every(m => Number(m.matchState) === 7);
  const shown = done && upcoming[1] && upcoming[1].matches.length ? upcoming[1] : upcoming[0];
  return {
    week: shown.week, matches: shown.matches,
    opens: shown === upcoming[0] ? (cur.openingWeekDate || null) : null,
    closes: shown === upcoming[0] ? (cur.closingWeekDate || null) : null,
    upcoming
  };
}

module.exports = { socialAuthorizeUrl, exchangeCode, refreshSocial, idClaims, SOCIAL_DAYS, SOCIAL_REDIRECT, login, get, pool, marketValue, leagueMarket, leagues, fetchPublic, fetchLeagueData, fetchCalendar, API, CMP };

