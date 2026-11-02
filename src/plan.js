'use strict';
/**
 * Freemium: qué ve cada usuario. El recorte se hace en el servidor, antes de enviar los datos.
 *
 * Plan efectivo:
 *  - Dueño (email en OWNER_EMAIL, o LALIGA_EMAIL si no hay OWNER_EMAIL): completo, salvo que active
 *    "ver como plan básico" desde Mi cuenta (campo user.preview = 'free').
 *  - Testers: lista que el dueño gestiona desde Mi cuenta (config/testers.json en el almacén),
 *    más los de la variable opcional TESTER_EMAILS. Plan completo.
 *  - Beta abierta (config/beta.json, interruptor en Mi cuenta; por defecto ENCENDIDA mientras no se guarde otra cosa;
 *    BETA_OPEN=0/1 en el entorno manda sobre el ajuste): todo el mundo tiene el plan completo. El código de candados,
 *    compra e interruptor de venta no se toca: al apagar la beta vuelve todo como estaba.
 *  - Resto: user.plan ('free' por defecto; 'premium' si se lo da el admin) o pase de temporada pagado con Stripe (src/billing.js).
 *
 * Plan básico (3 bloqueos):
 *  1. Liquidez total y caja estimada de los OTROS mánagers (se quitan compras/ventas/recompensas agregadas).
 *  2. Mercado completo: solo se envían los movimientos de las últimas 24 h (lo que usa Hoy).
 *  3. Jornadas futuras: solo se envía la jornada actual.
 *  4. Rentabilidad de los jugadores de OTROS mánagers (precio de compra, beneficio, ex-jugadores): no se envía.
 *  6. Ficha del futbolista: solo el próximo partido de su equipo.
 *  5. Protecciones de rivales que acaban en menos de 24 h: solo se envía la más próxima; el resto va sin fecha (lockHidden).
 *  7. Vigilar rivales (feed y avisos de sus movimientos): solo Premium; en básico se enseña como anzuelo.
 *  Resumen semanal y predicción de puntos: plan básico (sin bloqueo).
 */
const users = require('./users');
const billing = require('./billing');
const store = require('./store');

const TESTERS_KEY = 'config/testers.json';
const DEFAULT_TESTERS = ['alejandroperis16@gmail.com']; // primer tester pedido por Javier (24/9)
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
let testersCache = null;

/** Lista de testers guardada (si no existe todavía, la inicial). */
async function getTesters() {
  if (testersCache && Date.now() - testersCache.t < 60e3) return testersCache.list;
  const doc = await store.get(TESTERS_KEY, { fresh: true }).catch(() => null);
  const l = doc && Array.isArray(doc.emails) ? doc.emails : DEFAULT_TESTERS.slice();
  testersCache = { t: Date.now(), list: l };
  return l;
}
async function setTesters(emails) {
  const l = [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))].slice(0, 200);
  await store.put(TESTERS_KEY, { emails: l, updatedAt: new Date().toISOString() });
  testersCache = { t: Date.now(), list: l };
  return l;
}

const BETA_KEY = 'config/beta.json';
let betaCache = null;
/** ¿Beta abierta? (todos con plan completo) */
async function getBeta() {
  if (process.env.BETA_OPEN === '1') return true;
  if (process.env.BETA_OPEN === '0') return false;
  if (betaCache && Date.now() - betaCache.t < 60e3) return betaCache.on;
  const doc = await store.get(BETA_KEY, { fresh: true }).catch(() => null);
  const on = doc && typeof doc.on === 'boolean' ? doc.on : true;
  betaCache = { t: Date.now(), on };
  return on;
}
async function setBeta(on) {
  await store.put(BETA_KEY, { on: !!on, updatedAt: new Date().toISOString() });
  betaCache = { t: Date.now(), on: !!on };
  return !!on;
}

const DAY_MS = 864e5;
const list = v => String(v || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
const ownerEmails = () => list(process.env.OWNER_EMAIL || process.env.LALIGA_EMAIL);
const testerEmails = extra => list(process.env.TESTER_EMAILS).concat((extra || []).map(e => String(e).toLowerCase()));

function emailOf(user) {
  try { return String(users.creds(user).email || '').trim().toLowerCase(); } catch (e) { return ''; }
}

function planFor(user, testers, beta) {
  const email = emailOf(user);
  const owner = !!email && ownerEmails().includes(email);
  const tester = !owner && !!email && testerEmails(testers).includes(email);
  const preview = owner && user.preview === 'free';
  let plan;
  if (owner) plan = preview ? 'free' : 'premium';
  else if (tester) plan = 'premium';
  else plan = user.plan === 'premium' || billing.passActive(user) ? 'premium' : 'free';
  const byBeta = !!beta && !owner && plan !== 'premium';
  if (byBeta) plan = 'premium';
  const pass = billing.passActive(user) ? { until: user.pass.until, paidAt: user.pass.paidAt, test: user.pass.livemode === false } : null;
  return { plan, owner, tester, preview, pass, beta: byBeta, betaOpen: !!beta };
}

const EX_FREE = 10;
const LOCKS = ['liquidity', 'market', 'weeks', 'profit', 'locks', 'playerTx', 'watch'];

function applyPlan(snap, info, now) {
  const out = { ...snap, plan: { ...info, locked: info.plan === 'premium' ? [] : LOCKS.slice() } };
  if (info.plan === 'premium') return out;
  out.managers = (snap.managers || []).map(m => {
    if (m.isMe) return m;
    const { purchases, sales, rewards, realCash, exProfit, ...rest } = m;
    return {
      ...rest, realCash: null, liquidityLocked: true, profitLocked: true, exProfit: null,
      squad: (m.squad || []).map(({ buyPrice, profit, profitPct, ...p }) => ({ ...p, buyPrice: null, profit: null, profitPct: null })),
      // Rentabilidad histórica: las 10 ventas más recientes completas; del resto solo se envía cuántas hay
      exPlayers: (m.exPlayers || []).slice(0, EX_FREE),
      exHidden: Math.max(0, (m.exPlayers || []).length - EX_FREE)
    };
  });
  const t = now || Date.now();
  // Protecciones de toda la liga (también las propias) que acaban en menos de 24 h: solo se ve UNA, la más próxima.
  // Las de rivales se recortan aquí; las propias conservan el dato (es suyo) pero se marcan para mostrarlas tapadas en las listas.
  const soon = [];
  out.managers.forEach(m => m.squad.forEach(p => { const l = p.clauseLockedUntil ? new Date(p.clauseLockedUntil) - t : 0; if (l > 0 && l < DAY_MS) soon.push({ p, l, mine: m.isMe }); }));
  if (soon.length > 1) out.managers = out.managers.map(m => m.isMe ? { ...m, squad: m.squad.map(p => ({ ...p })) } : m);
  soon.sort((a, b) => a.l - b.l).slice(1).forEach(x => {
    if (x.mine) { const own = out.managers.find(m => m.isMe).squad.find(p => p.playerId === x.p.playerId); if (own) own.lockSoonHidden = true; }
    else { x.p.clauseLockedUntil = null; x.p.lockHidden = true; }
  });
  out.locksHidden = Math.max(0, soon.length - 1);
  const since = new Date(snap.fetchedAt).getTime() - DAY_MS;
  const all = snap.activity || [];
  out.activity = all.filter(r => new Date(r.date).getTime() >= since);
  out.activityHidden = all.length - out.activity.length;
  // El mercado completo es Premium también para anuncios vigentes.
  out.market = [];
  out.marketLocked = true;
  // Ficha del futbolista: los movimientos en la liga son Premium; de los antiguos solo se envía cuántos hay por jugador
  const txHidden = {};
  all.forEach(r => { if (r.amount && r.playerId != null && new Date(r.date).getTime() < since) txHidden[r.playerId] = (txHidden[r.playerId] || 0) + 1; });
  out.txHidden = txHidden;
  if (snap.fixtures && Array.isArray(snap.fixtures.weeks)) {
    out.fixtures = { ...snap.fixtures, weeks: snap.fixtures.weeks.slice(0, 1), weeksHidden: Math.max(0, snap.fixtures.weeks.length - 1) };
  }
  // Ficha del futbolista: solo el próximo partido de cada equipo
  if (snap.fixtures && snap.fixtures.next) {
    const next = {}, nextHidden = {};
    Object.entries(snap.fixtures.next).forEach(([k, l]) => { next[k] = (l || []).slice(0, 1); nextHidden[k] = Math.max(0, (l || []).length - 1); });
    out.fixtures = { ...(out.fixtures || snap.fixtures), next, nextHidden };
  }
  return out;
}

module.exports = { planFor, applyPlan, getTesters, setTesters, getBeta, setBeta, EMAIL_RE, LOCKS, list };

