'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const laliga = require('./laliga');
const users = require('./users');
const store = require('./store');
const secure = require('./secure');
const plans = require('./plan');
const { refreshUser, refreshAll, loadSnapshot } = require('./refresh');
const push = require('./push');
const billing = require('./billing');
const rateLimit = require('./rate-limit');
const ai = require('./ai');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// Webhook de Stripe: necesita el cuerpo sin parsear para comprobar la firma (va antes de express.json)
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try { res.json(await billing.webhook(req.body.toString('utf8'), req.get('stripe-signature'))); }
  catch (e) { console.error('stripe webhook:', e.message); res.status(e.status || 500).json({ error: e.message }); }
});
app.use(express.json({ limit: '10kb' }));

const COOKIE = 'ff_session';
const SESSION_DAYS = 90;
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = req => {
  const m = String(req.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
const secureFlag = req => (req.secure || req.get('x-forwarded-proto') === 'https') ? '; Secure' : '';
function setSession(req, res, user) {
  const token = secure.signSession({ u: user.uid, v: user.sv, e: Date.now() + SESSION_DAYS * 864e5 });
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}`);
}
const clearSession = (req, res) => res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);

/** Sesión obligatoria: cookie firmada + perfil existente con la misma versión de sesión. */
async function requireUser(req, res, next) {
  try {
    const p = secure.verifySession(cookieOf(req));
    if (!p) return res.status(401).json({ error: 'Inicia sesión', code: 'LOGIN' });
    const user = await users.get(p.u);
    if (!user || user.sv !== p.v) { clearSession(req, res); return res.status(401).json({ error: 'Inicia sesión', code: 'LOGIN' }); }
    if (user.credsInvalid) { clearSession(req, res); return res.status(401).json({ error: users.reloginMessage(user), code: 'RELOGIN', social: user.auth === 'social' }); }
    req.user = user;
    // Última vez que usó la app (para la lista de usuarios del admin); se guarda como mucho una vez cada 5 minutos
    if (!user.lastSeenAt || Date.now() - Date.parse(user.lastSeenAt) > 5 * 60e3) {
      const seen = new Date().toISOString(); user.lastSeenAt = seen;
      users.get(user.uid).then(u => { if (u && u.sv === user.sv) return users.save({ ...u, lastSeenAt: seen }); }).catch(() => {});
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ---- límites de intentos de login (por email y por IP; en memoria de cada instancia) ----
const fails = new Map(); // clave -> { n, until }
const ipHits = new Map(); // ip -> [timestamps]
function loginBlocked(emailKey, ip) {
  const f = fails.get(emailKey);
  if (f && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  const hits = (ipHits.get(ip) || []).filter(t => Date.now() - t < 15 * 60e3);
  ipHits.set(ip, hits);
  if (hits.length >= 20) return 15 * 60;
  return 0;
}
function noteLogin(emailKey, ip, ok) {
  ipHits.set(ip, (ipHits.get(ip) || []).concat(Date.now()));
  if (ok) { fails.delete(emailKey); return; }
  const f = fails.get(emailKey) || { n: 0 };
  f.n++; f.until = Date.now() + Math.min(f.n, 10) * 60e3; // 1 min, 2 min, ... hasta 10 min
  fails.set(emailKey, f);
}

const errStatus = e => e.code === 'RELOGIN' || e.code === 'NO_USER' ? 401 : e.code === 'LOGIN_COOLDOWN' ? 429 : 502;

app.get('/api/health', (req, res) => res.json({ ok: true, key: secure.keySource() }));

/** Parte común a los dos logins: sesión, avisos y primera carga de la liga. */
async function finishLogin(req, res, r, ok) {
  setSession(req, res, r.user);
  if (!r.user.leagues.length) {
    noteFailure(r.user.auth === 'social' ? '(Google/Apple/Facebook)' : users.creds(r.user).email, (r.user.hiddenLeagues || []).length ? 'onlyglobal' : 'noleagues', '').catch(() => {});
    return res.json({ ok: true, warning: (r.user.hiddenLeagues || []).length
      ? ok + ', pero con esta cuenta solo estás en ligas globales. Esta web es para ligas privadas con amigos.'
      : ok + ', pero esta cuenta no está en ninguna liga.' + (r.user.auth === 'social' ? '' : ' Si en la app oficial entras con Facebook, Google o Apple, usa "Entro con Google, Apple o Facebook".') });
  }
  // Primera carga de su liga con el token recién obtenido (sin segundo login)
  const had = await loadSnapshot(r.user.uid);
  if (!had) {
    try { await refreshUser(r.user.uid, { token: r.token }); }
    catch (e) { return res.json({ ok: true, pickLeague: r.first && r.user.leagues.length > 1, warning: 'Sesión iniciada, pero la primera carga de tu liga falló: ' + e.message + '. Dale a recargar en un rato.' }); }
  } else {
    refreshUser(r.user.uid, { token: r.token }).catch(() => {}); // refresca en segundo plano
  }
  res.json({ ok: true, leagues: r.user.leagues, leagueId: r.user.leagueId, pickLeague: r.first && r.user.leagues.length > 1 });
}

// ---- modo avanzado: cuentas de Google, Apple o Facebook (PKCE con jwt.ms; ver laliga.js) ----
// El code_verifier viaja cifrado en una cookie HttpOnly de 20 min: no hace falta guardarlo en el servidor.
const PKCE_COOKIE = 'ff_pkce';
const pkceOf = req => {
  const m = String(req.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + PKCE_COOKIE + '=([^;]+)'));
  if (!m) return null;
  try { const p = JSON.parse(secure.decrypt(decodeURIComponent(m[1]))); return p && p.e > Date.now() ? p : null; } catch (e) { return null; }
};
app.post('/api/auth/social/start', (req, res) => {
  try {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(12).toString('base64url');
    const blob = secure.encrypt(JSON.stringify({ v: verifier, s: state, e: Date.now() + 20 * 60e3 }));
    res.append('Set-Cookie', `${PKCE_COOKIE}=${encodeURIComponent(blob)}; Path=/api/auth/social; HttpOnly; SameSite=Lax; Max-Age=1200${secureFlag(req)}`);
    res.json({ url: laliga.socialAuthorizeUrl(challenge, state) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Lo que pega el usuario: la dirección completa de jwt.ms (…?code=…&state=…) o solo el código. */
function parsePasted(text) {
  const t = String(text || '').trim().replace(/\s+/g, '');
  if (!t) return {};
  // Solo vale la dirección completa (https://jwt.ms/?code=…). Cualquier otra cosa (p. ej. el texto que muestra
  // la página) se rechaza aquí sin llamar a LaLiga, para no gastar el código de un solo uso.
  if (!/^https?:\/\//i.test(t)) return { notUrl: true };
  if (!/[?#&](code|error)=/.test(t)) return {};
  const q = new URLSearchParams(t.slice(t.search(/[?#]/) + 1).replace(/#/g, '&'));
  return { code: q.get('code') || '', state: q.get('state') || '', error: q.get('error') || '', errorDescription: q.get('error_description') || '' };
}

/** LaLiga caída o en mantenimiento: su API da un error 5xx al pedir las ligas (o los datos de una liga). */
const laligaDown = e => /^API 5\d\d en \/api\/v1\/competition\/1\/leagues/.test(String((e && e.message) || ''));
const DOWN_MSG = ok => 'LaLiga está caída o en mantenimiento ahora mismo 🛠️ No es cosa tuya ni de tu cuenta: ' + ok + ', pero su servidor no está devolviendo las ligas. Vuelve a probar en un rato.';

app.post('/api/auth/social/finish', async (req, res) => {
  const pasted = String((req.body || {}).url || '');
  if (!pasted || pasted.length > 6000) return res.status(400).json({ code: 'EMPTY', error: 'Pega aquí la dirección completa de la página jwt.ms.' });
  const p = parsePasted(pasted);
  if (p.error) {
    const cancelled = /access_denied|AADB2C90091/i.test(p.error + ' ' + p.errorDescription);
    return res.status(400).json({ code: 'SOCIAL_ERROR', error: cancelled ? 'Has cancelado el inicio de sesión. Vuelve al paso 1 y prueba otra vez.' : 'LaLiga devolvió un error en lugar del código (' + (p.errorDescription || p.error).split(/[\r\n]/)[0].slice(0, 200) + '). Vuelve al paso 1.' });
  }
  if (p.notUrl) return res.status(400).json({ code: 'NOT_URL', error: 'Eso que has pegado es el contenido de la página, no su dirección. Vuelve a jwt.ms y copia la dirección de la barra de arriba (empieza por https://jwt.ms/?code=): botón Compartir → Copiar. Tu código sigue valiendo si no han pasado unos minutos.' });
  if (!p.code) return res.status(400).json({ code: 'NO_CODE', error: 'Eso no parece la dirección de jwt.ms: tiene que empezar por https://jwt.ms/?code= . Copia la dirección completa de la barra de Safari (o con Compartir → Copiar) y pégala aquí.' });
  const pk = pkceOf(req);
  if (!pk) return res.status(400).json({ code: 'PKCE_EXPIRED', error: 'Han pasado más de 20 minutos o se ha cerrado la web. Vuelve al paso 1 y toca "Abrir login de LaLiga" otra vez.' });
  if (p.state && p.state !== pk.s) return res.status(400).json({ code: 'STATE', error: 'Ese enlace es de un intento anterior. Usa el del último "Abrir login de LaLiga" (o empieza otra vez desde el paso 1).' });
  const ipKey = 'social:' + req.ip;
  const wait = loginBlocked(ipKey, req.ip);
  if (wait) return res.status(429).json({ code: 'TOO_MANY', error: `Demasiados intentos seguidos. Espera ${wait < 90 ? wait + ' s' : Math.ceil(wait / 60) + ' min'} y vuelve a probar.` });
  res.append('Set-Cookie', `${PKCE_COOKIE}=; Path=/api/auth/social; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`); // un solo intento por código
  let r;
  try {
    r = await users.socialLogin(p.code, pk.v);
    noteLogin(ipKey, req.ip, true);
  } catch (e) {
    if (!laligaDown(e)) noteLogin(ipKey, req.ip, false); // una caída de LaLiga no cuenta como intento fallido
    const kind = e.code === 'GRANT_INVALID' ? 'social-code' : e.stage === 'leagues' ? 'leagues' : e.code === 'LALIGA_DOWN' ? 'laliga' : 'social-other';
    console.error('login social fallido', kind, e.b2c || '', e.message);
    noteFailure('(Google/Apple/Facebook)', kind, e.b2c || '').catch(() => {});
    if (kind === 'social-code') return res.status(401).json({ code: 'CODE_INVALID', error: 'LaLiga no aceptó el código: caduca a los pocos minutos y solo vale una vez. Vuelve al paso 1 y hazlo seguido (' + (e.b2c || 'invalid_grant') + ').' });
    if (kind === 'leagues' && laligaDown(e)) return res.status(502).json({ code: 'LALIGA_DOWN', error: DOWN_MSG('has entrado bien') });
    if (kind === 'leagues') return res.status(502).json({ code: 'LEAGUES', error: 'Has entrado bien, pero LaLiga no devolvió tus ligas (' + e.message + '). Prueba de nuevo en un rato.' });
    if (kind === 'laliga') return res.status(502).json({ code: 'LALIGA_DOWN', error: 'LaLiga no responde ahora mismo (' + e.message + '). Prueba de nuevo en un rato.' });
    return res.status(502).json({ code: 'SOCIAL_OTHER', error: 'No se pudo completar el acceso: ' + e.message });
  }
  return finishLogin(req, res, r, 'Has entrado');
});

app.post('/api/auth/login', async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  const password = String((req.body || {}).password || '');
  if (!email || !password || email.length > 200 || password.length > 200) return res.status(400).json({ error: 'Escribe tu email y tu contraseña de LaLiga Fantasy' });
  let emailKey;
  try { emailKey = secure.userId(email); } catch (e) { return res.status(500).json({ error: e.message }); }
  const wait = loginBlocked(emailKey, req.ip);
  if (wait) return res.status(429).json({ code: 'TOO_MANY', error: `Demasiados intentos fallidos seguidos. Espera ${wait < 90 ? wait + ' s' : Math.ceil(wait / 60) + ' min'} y vuelve a probar (esto no significa que la contraseña esté mal).` });
  let r;
  try {
    r = await users.login(email, password);
    noteLogin(emailKey, req.ip, true);
  } catch (e) {
    if (!laligaDown(e)) noteLogin(emailKey, req.ip, false); // una caída de LaLiga no cuenta como intento fallido
    const kind = e.code === 'LOGIN_FAILED' ? 'password' : e.code === 'LOGIN_OTHER' ? 'account' : e.stage === 'leagues' ? 'leagues' : 'laliga';
    console.error('login fallido', kind, e.b2c || '', e.message);
    noteFailure(email, kind, e.b2c || '').catch(() => {});
    if (kind === 'password') return res.status(401).json({ code: 'BAD_PASSWORD', error: 'Email o contraseña incorrectos: LaLiga los rechaza. Usa los mismos con los que entras en la app oficial del Fantasy. Si en la app oficial entras con Google, Apple o Facebook, usa el botón "Entro con Google, Apple o Facebook" de abajo.' });
    if (kind === 'account') return res.status(403).json({ code: 'ACCOUNT', error: 'La contraseña no es el problema: LaLiga no deja entrar con esta cuenta ahora mismo (' + (e.b2c || 'sin código') + (e.detail ? ': ' + e.detail : '') + '). Entra en la app oficial para ver qué pide.' });
    if (kind === 'leagues' && laligaDown(e)) return res.status(502).json({ code: 'LALIGA_DOWN', error: DOWN_MSG('tu email y tu contraseña están bien') });
    if (kind === 'leagues') return res.status(502).json({ code: 'LEAGUES', error: 'Email y contraseña correctos, pero LaLiga no devolvió tus ligas (' + e.message + '). Prueba de nuevo en un rato.' });
    return res.status(502).json({ code: 'LALIGA_DOWN', error: 'Tu contraseña no es el problema: LaLiga no responde ahora mismo (' + e.message + '). Prueba de nuevo en un rato.' });
  }
  return finishLogin(req, res, r, 'Email y contraseña correctos');
});

app.post('/api/auth/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

/** Borra el perfil: credenciales cifradas y datos de su liga. */
app.post('/api/auth/delete', requireUser, async (req, res) => {
  await push.syncIndex({ uid: req.user.uid, push: [] }).catch(() => {});
  // Su email de contacto de la bienvenida también se borra
  try {
    let c = ''; if (req.user.contactEmail) c = secure.decrypt(req.user.contactEmail);
    if (c) { const l = (await store.get(CONTACTS_KEY, { fresh: true })) || []; await store.put(CONTACTS_KEY, l.filter(x => { try { return secure.decrypt(x.email) !== c; } catch (e) { return true; } })); }
  } catch (e) { /* nada */ }
  try { const f = (await store.get(FEEDBACK_KEY, { fresh: true })) || []; if (f.some(x => x.uid === req.user.uid)) await store.put(FEEDBACK_KEY, f.filter(x => x.uid !== req.user.uid)); } catch (e) { /* nada */ }
  await users.remove(req.user.uid);
  clearSession(req, res);
  res.json({ ok: true });
});

// --- Habla con la IA ---
const aiLastAsk = new Map(); // uid -> ts de su última respuesta (puerta de 8 s entre preguntas)

app.get('/api/ai/quota', requireUser, async (req, res) => {
  const limit = ai.LIMIT();
  const q = await ai.quota(req.user.uid);
  res.json({ on: !!process.env.GEMINI_API_KEY, limit, used: q.n, left: Math.max(0, limit - q.n) });
});

app.post('/api/ai/ask', requireUser, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'La IA aún no está activada', code: 'AI_OFF' });
  const question = String((req.body && req.body.question) || '').trim();
  if (question.length < 3) return res.status(400).json({ error: 'Escribe una pregunta un poco más larga', code: 'AI_SHORT' });
  if (question.length > ai.MAX_Q) return res.status(400).json({ error: 'Pregunta demasiado larga', code: 'AI_LONG' });
  const limit = ai.LIMIT();
  const q = await ai.quota(req.user.uid);
  if (q.n >= limit) return res.status(429).json({ error: 'Mañana más: has gastado tus preguntas de hoy', code: 'AI_LIMIT', left: 0 });
  const wait = 8000 - (Date.now() - (aiLastAsk.get(req.user.uid) || 0));
  if (wait > 0) return res.status(429).json({ error: `Espera ${Math.ceil(wait / 1000)} s entre preguntas`, code: 'AI_WAIT', left: Math.max(0, limit - q.n) });
  try {
    const snap = await ai.loadSnapshot(req.user.uid);
    if (!snap) return res.status(409).json({ error: 'Todavía no hay datos de tu liga; recarga primero', code: 'AI_NO_DATA' });
    const answer = await ai.askGemini(question, ai.context(snap));
    const after = await ai.useOne(req.user.uid);
    aiLastAsk.set(req.user.uid, Date.now());
    res.json({ answer, left: Math.max(0, limit - after.n) });
  } catch (e) {
    if (e && e.quota) return res.status(503).json({ error: 'La IA gratuita está saturada hoy; prueba mañana', code: 'AI_GOOGLE_QUOTA' });
    res.status(502).json({ error: 'La IA no ha podido contestar ahora', code: 'AI_FAIL' });
  }
});

app.get('/api/me', requireUser, async (req, res) => {
  res.json({ email: users.maskedEmail(req.user), leagues: req.user.leagues || [], leagueId: req.user.leagueId, createdAt: req.user.createdAt, social: users.socialStatus(req.user), plan: plans.planFor(req.user, await plans.getTesters(), await plans.getBeta()) });
});

/** Feedback desde "Contacta con el creador" (Mi cuenta). Se guarda cifrado; solo lo lee el admin en su panel. */
const FEEDBACK_KEY = 'config/feedback.json';
app.post('/api/feedback', requireUser, async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Escribe algo antes de enviar' });
  try {
    const l = (await store.get(FEEDBACK_KEY, { fresh: true })) || [];
    if (l.filter(x => x.uid === req.user.uid && Date.now() - Date.parse(x.at) < 864e5).length >= 20) return res.status(429).json({ error: 'Has enviado muchos mensajes hoy. Si es urgente, escribe a bigdatafantasy@gmail.com' });
    l.unshift({ uid: req.user.uid, text: secure.encrypt(text), at: new Date().toISOString() });
    await store.put(FEEDBACK_KEY, l.slice(0, 1000));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/** Marca la bienvenida de la beta como vista para este usuario (no se le vuelve a enseñar en ningún móvil). */
app.post('/api/me/welcome', requireUser, async (req, res) => {
  const u = await users.get(req.user.uid);
  if (!u.welcomeSeenAt) await users.save({ ...u, welcomeSeenAt: new Date().toISOString() });
  res.json({ ok: true });
});
/** Emails de contacto dejados en la bienvenida ANTES de entrar (puede que nunca lleguen a tener cuenta). Cifrados. */
const CONTACTS_KEY = 'config/beta-contacts.json';
app.post('/api/contact', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!plans.EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Ese email no parece válido' });
  try {
    const l = (await store.get(CONTACTS_KEY, { fresh: true })) || [];
    const dec = x => { try { return secure.decrypt(x.email); } catch (e) { return ''; } };
    if (!l.some(x => dec(x) === email)) {
      if (l.length >= 5000) return res.json({ ok: true }); // tope anti-abuso
      l.unshift({ email: secure.encrypt(email), at: new Date().toISOString() });
      await store.put(CONTACTS_KEY, l);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/** Email personal de contacto que deja el tester en la bienvenida de la beta (cifrado; solo lo ve el admin). */
app.post('/api/me/contact', requireUser, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!plans.EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Ese email no parece válido' });
  const u = await users.get(req.user.uid);
  await users.save({ ...u, contactEmail: secure.encrypt(email), contactAt: new Date().toISOString() });
  res.json({ ok: true });
});

/** Solo el dueño: alternar entre ver la app como plan básico o completo. */
app.post('/api/plan/preview', requireUser, async (req, res) => {
  const info = plans.planFor(req.user);
  if (!info.owner) return res.status(403).json({ error: 'Solo disponible para el administrador' });
  req.user.preview = (req.body || {}).mode === 'free' ? 'free' : null;
  await users.save(req.user);
  res.json({ ok: true, plan: plans.planFor(req.user, await plans.getTesters(), await plans.getBeta()) });
});

/** Solo el dueño: ver, añadir y quitar testers (acceso completo). */
const requireOwner = (req, res, next) => plans.planFor(req.user).owner ? next() : res.status(403).json({ error: 'Solo disponible para el administrador' });
/** Últimos logins fallidos (para que el admin vea si es contraseña u otra cosa). Nunca se guarda la contraseña. */
const FAIL_KEY = 'config/login-failures.json';
async function noteFailure(email, kind, b2c) {
  const l = ((await store.get(FAIL_KEY, { fresh: true })) || []).filter(x => Date.now() - Date.parse(x.at) < 7 * 864e5);
  l.unshift({ email: String(email).toLowerCase().slice(0, 200), kind, b2c, at: new Date().toISOString() });
  await store.put(FAIL_KEY, l.slice(0, 40));
}
app.get('/api/admin/login-failures', requireUser, requireOwner, async (req, res) => {
  try { res.json({ failures: ((await store.get(FAIL_KEY, { fresh: true })) || []).filter(x => Date.now() - Date.parse(x.at) < 7 * 864e5) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/feedback', requireUser, requireOwner, async (req, res) => {
  try {
    const l = (await store.get(FEEDBACK_KEY, { fresh: true })) || [];
    const cache = {};
    const who = async uid => {
      if (uid in cache) return cache[uid];
      const u = await users.get(uid); let email = '', contact = '';
      if (u) { try { email = secure.decrypt(u.email); } catch (e) {} try { if (u.contactEmail) contact = secure.decrypt(u.contactEmail); } catch (e) {} }
      if (email.startsWith('sub:')) email = 'Cuenta ' + ((u && u.provider) || 'social') + ' sin email';
      return (cache[uid] = { email: email || 'usuario borrado', contact: contact || null });
    };
    const out = [];
    for (const x of l.slice(0, 200)) { let text = ''; try { text = secure.decrypt(x.text); } catch (e) {} out.push({ ...(await who(x.uid)), text, at: x.at }); }
    res.json({ count: l.length, feedback: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/** Admin: usuarios registrados (email, plan, alta, último login y última vez activo). Nunca contraseñas. */
app.get('/api/admin/users', requireUser, requireOwner, async (req, res) => {
  try {
    const testers = await plans.getTesters(), beta = await plans.getBeta();
    const list = (await users.all()).map(u => {
      let email = ''; try { email = secure.decrypt(u.email); } catch (e) {}
      if (email.startsWith('sub:')) email = 'Cuenta ' + (u.provider || 'social') + ' sin email (' + u.uid.slice(0, 6) + ')';
      const pl = plans.planFor(u, testers, beta);
      let contact = ''; try { if (u.contactEmail) contact = secure.decrypt(u.contactEmail); } catch (e) {}
      return { email, role: pl.owner ? 'admin' : pl.tester ? 'tester' : pl.beta ? 'beta' : pl.plan === 'premium' ? 'premium' : 'básico',
        createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null, lastSeenAt: u.lastSeenAt || u.lastLoginAt || null,
        contact: contact || null, leagues: (u.leagues || []).length, needsRelogin: !!u.credsInvalid, social: u.auth === 'social' ? users.socialStatus(u) : null };
    }).sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    // Emails de la bienvenida cuyo dueño aún no ha entrado (ningún usuario los tiene como contacto)
    const known = new Set(list.map(u => u.contact).filter(Boolean));
    const pending = ((await store.get(CONTACTS_KEY, { fresh: true })) || []).map(x => { let e = ''; try { e = secure.decrypt(x.email); } catch (err) {} return { email: e, at: x.at }; })
      .filter(x => x.email && !known.has(x.email));
    res.json({ count: list.length, users: list, pendingContacts: pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/** Admin: campos simples de sus propias ligas tal como las devuelve LaLiga (para afinar qué liga es global). */
app.get('/api/admin/league-meta', requireUser, requireOwner, (req, res) => res.json({ leagues: req.user.leagueMeta || [], hidden: req.user.hiddenLeagues || [], big: req.user.bigLeagues || [] }));
app.get('/api/testers', requireUser, requireOwner, async (req, res) => res.json({ emails: await plans.getTesters() }));
app.post('/api/testers', requireUser, requireOwner, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!plans.EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Email no válido' });
  let l = await plans.getTesters();
  l = b.remove ? l.filter(e => e !== email) : l.concat(email);
  res.json({ emails: await plans.setTesters(l) });
});

/** Vigilar rivales: lista de vigilados (se guarda en el servidor para poder mandar push con la app cerrada). */
app.post('/api/watch', requireUser, async (req, res) => {
  try { const u = await push.setWatch(req.user, (req.body || {}).names); res.json({ ok: true, watch: u.watch }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
/** Notificaciones push: clave pública VAPID, alta y baja de la suscripción de este móvil. */
app.get('/api/push/key', requireUser, async (req, res) => {
  try { res.json({ publicKey: await push.publicKey() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/push/subscribe', requireUser, async (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.watch)) await push.setWatch(req.user, b.watch);
    const u = await push.subscribe(req.user, b.subscription, req.get('user-agent'));
    const w = b.welcome ? await push.sendWelcome(u, b.subscription.endpoint).catch(() => ({ delivered: 0 })) : { delivered: 0 };
    res.json({ ok: true, devices: (u.push || []).length, welcome: w.delivered > 0 });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/push/unsubscribe', requireUser, async (req, res) => {
  try { const u = await push.unsubscribe(req.user, (req.body || {}).endpoint); res.json({ ok: true, devices: (u.push || []).length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Pase de temporada (Stripe). Apagado hasta que el admin enciende la venta. */
const originOf = req => (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
app.post('/api/billing/checkout', requireUser, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.consent) return res.status(400).json({ error: 'Marca la casilla para continuar' });
    res.json(await billing.createCheckout(req.user, originOf(req), new Date().toISOString(), plans.planFor(req.user).owner));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/billing/confirm', requireUser, async (req, res) => {
  try { res.json(await billing.confirm(req.user, req.query.session_id)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
/** Admin: beta abierta (todos con plan completo) encendida / apagada. */
app.post('/api/admin/beta', requireUser, requireOwner, async (req, res) => {
  try { res.json({ beta: await plans.setBeta(!!(req.body || {}).on) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
/** Admin: venta del pase apagada / solo el admin (pruebas) / encendida para todos. */
app.post('/api/admin/billing', requireUser, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    await billing.setSwitch(['off', 'owner', 'on'].includes(b.state) ? b.state : !!b.on);
    res.json(await billing.info(true));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Cambiar de liga (si la cuenta tiene varias). */
app.post('/api/league', requireUser, async (req, res) => {
  const id = String((req.body || {}).leagueId || '');
  if (!(req.user.leagues || []).some(l => l.id === id)) return res.status(400).json({ error: 'Liga no válida' });
  req.user.leagueId = id;
  await users.save(req.user);
  try { const s = await refreshUser(req.user.uid); res.json({ ok: true, fetchedAt: s.fetchedAt }); }
  catch (e) { res.status(errStatus(e)).json({ error: e.message, code: e.code }); }
});

/** Evento .ics a la hora de fin de protección con alarma m minutos antes (botón "Añadir a Calendar" de la app). No expone datos: solo devuelve lo que recibe. */
app.get('/api/ics', (req, res) => {
  const at = new Date(String(req.query.at || ''));
  if (isNaN(at)) return res.status(400).send('Fecha no válida');
  const clean = v => String(v || '').slice(0, 300).replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1');
  const f = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const mins = Math.max(0, Math.min(1440, parseInt(req.query.m, 10) || 0));
  const start = at, stop = new Date(at.getTime() + 5 * 60e3); // el evento es la hora exacta en que acaba la protección
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fantasy-app//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', 'UID:' + f(at) + '-' + crypto.createHash('sha1').update(String(req.query.t || '')).digest('hex').slice(0, 12) + '@fantasy-app',
    'DTSTAMP:' + f(new Date()), 'DTSTART:' + f(start), 'DTEND:' + f(stop),
    'SUMMARY:' + clean(req.query.t || 'Fin de protección'), 'DESCRIPTION:' + clean(req.query.d),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + clean(req.query.t || 'Fin de protección'), 'TRIGGER:-PT' + mins + 'M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8').set('Content-Disposition', 'inline; filename="proteccion.ics"').send(ics);
});

app.get('/api/data', requireUser, async (req, res) => {
  try {
    let snap = await loadSnapshot(req.user.uid);
    if (!snap) snap = await refreshUser(req.user.uid);
    res.set('Cache-Control', 'no-store').json({ ...plans.applyPlan(snap, plans.planFor(req.user, await plans.getTesters(), await plans.getBeta())), billing: await billing.info(plans.planFor(req.user).owner), me: { email: users.maskedEmail(req.user), leagueId: req.user.leagueId, social: users.socialStatus(req.user), watch: Array.isArray(req.user.watch) ? req.user.watch : null, push: (req.user.push || []).length, welcomeSeen: !!req.user.welcomeSeenAt } });
  } catch (e) {
    if (errStatus(e) === 401) clearSession(req, res);
    if (laligaDown(e)) return res.status(502).json({ code: 'LALIGA_DOWN', error: 'LaLiga está caída o en mantenimiento ahora mismo 🛠️ No es cosa tuya ni de tu cuenta. Vuelve a probar en un rato.' });
    res.status(errStatus(e)).json({ error: e.message, code: e.code });
  }
});

/** ⟳ de la app: recarga su liga (y lo común si tiene más de 30 min, para traer el % de titularidad fresco). */
app.post('/api/refresh', requireUser, async (req, res) => {
  try {
    // Shared across Vercel instances: one in-flight manual refresh; cooldown after success.
    // Claim first, before any call to the upstream login or league API.
    const key = 'refresh:' + req.user.uid;
    // A short in-flight lease protects LaLiga while the request runs. Only a completed
    // refresh starts the 30-minute cooldown; a failed one gets a brief backoff.
    const gate = await rateLimit.claim(key, 3 * 60e3);
    if (!gate.ok) return res.set('Retry-After', String(gate.retryAfter)).status(429).json({ code: 'REFRESH_COOLDOWN', error: 'Podrás volver a recargar en ' + Math.ceil(gate.retryAfter / 60) + ' min.', retryAfter: gate.retryAfter });
    let succeeded = false;
    try {
      const snap = await refreshUser(req.user.uid, { sharedMaxAgeMs: 30 * 60e3, viewer: true });
      res.json({ ok: true, fetchedAt: snap.fetchedAt, activity: snap.activity.length, ms: snap.refreshMs });
      succeeded = true;
    } finally {
      // A stale completion may not overwrite a newer claim. Failure allows retry
      // after 15s; if the function crashes the 3-minute lease expires by itself.
      await rateLimit.settle(key, gate.token, succeeded ? 30 * 60e3 : 15e3)
        .catch(e => console.error('refresh gate settle:', e.message));
    }
  } catch (e) {
    if (errStatus(e) === 401) clearSession(req, res);
    if (laligaDown(e)) return res.status(502).json({ code: 'LALIGA_DOWN', error: 'LaLiga está caída o en mantenimiento ahora mismo 🛠️ No es cosa tuya ni de tu cuenta. Sigues viendo los últimos datos guardados; vuelve a recargar en un rato.' });
    res.status(errStatus(e)).json({ error: e.message, code: e.code });
  }
});

/** Cron diario de Vercel (GET con Authorization: Bearer CRON_SECRET si está configurado). Solo devuelve contadores. */
let lastCron = 0;
app.get('/api/refresh', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (secret ? !safeEq(bearer, secret) : !/vercel-cron/i.test(req.get('user-agent') || '')) return res.status(401).json({ error: 'No autorizado' });
  if (Date.now() - lastCron < 10 * 60e3) return res.status(429).json({ error: 'Ya se ha ejecutado hace poco' });
  lastCron = Date.now();
  try { res.json({ ok: true, ...(await refreshAll()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

const mvCache = new Map();
app.get('/api/player/:id/history', requireUser, async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'id no válido' });
  const hit = mvCache.get(id);
  if (hit && Date.now() - hit.t < 3 * 3600 * 1000) return res.json(hit.data);
  try {
    const stored = await store.get('history/' + id + '.json', { fresh: true });
    if (stored && Date.now() - Date.parse(stored.fetchedAt) < 3 * 3600e3) { mvCache.set(id, { t: Date.parse(stored.fetchedAt), data: stored.data }); return res.json(stored.data); }
    // Per-account requests and global per-player miss cap. Shared gate prevents a new
    // serverless instance from repeating the LaLiga request on every cold start.
    const view = await rateLimit.claim('history-user:' + req.user.uid, 2 * 1000);
    if (!view.ok) return res.set('Retry-After', String(view.retryAfter)).status(429).json({ error: 'Espera un momento antes de abrir otra ficha.', retryAfter: view.retryAfter });
    const gate = await rateLimit.claim('history:' + id, 30 * 1000);
    if (!gate.ok) return res.set('Retry-After', String(gate.retryAfter)).status(429).json({ error: 'El histórico está actualizándose. Reintenta en un minuto.', retryAfter: gate.retryAfter });
    const raw = await laliga.get(laliga.CMP + '/player/' + id + '/market-value');
    const data = (Array.isArray(raw) ? raw : []).map(x => ({ date: String(x.date).slice(0, 10), value: Number(x.marketValue) }));
    await store.put('history/' + id + '.json', { fetchedAt: new Date().toISOString(), data });
    mvCache.set(id, { t: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

module.exports = app;

