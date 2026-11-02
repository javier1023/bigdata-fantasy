'use strict';
/**
 * Pase de temporada (Premium) con Stripe Checkout. Pago único, sin renovación.
 * Variables de entorno:
 *  - STRIPE_SECRET_KEY      sk_test_... (pruebas) o sk_live_... (real). Sin ella, no se muestra la compra (premium manual como hasta ahora).
 *  - STRIPE_WEBHOOK_SECRET  whsec_... del endpoint /api/stripe/webhook (Stripe → Developers → Webhooks).
 *  - PASS_PRICE_CENTS       precio en céntimos (por defecto 499 = 4,99 €).
 *  - PASS_UNTIL             fin del pase (por defecto 2027-06-30T23:59:59+02:00, temporada 2026/27).
 *  - PASS_NAME              nombre del producto en Stripe.
 * Interruptor: aunque haya clave, la venta está APAGADA hasta que el administrador la enciende en Mi cuenta
 * (config/billing.json en el almacén) o con PAYMENTS_ON=1. Apagada, la app se comporta como antes (premium manual).
 * La activación llega por dos caminos (lo que ocurra antes): el webhook de Stripe y la comprobación al volver
 * del pago (/api/billing/confirm). Los dos verifican el pago directamente con Stripe.
 */
const crypto = require('crypto');
const store = require('./store');
const users = require('./users');

const API = 'https://api.stripe.com/v1';
const key = () => String(process.env.STRIPE_SECRET_KEY || '').trim();
const configured = () => /^(sk|rk)_(test|live)_/.test(key());
const SWITCH_KEY = 'config/billing.json';
let switchCache = null;
const STATES = ['off', 'owner', 'on'];
/** Estado del interruptor: 'off' (nadie compra), 'owner' (solo el admin, para probar) u 'on' (todos). */
async function switchState() {
  if (process.env.PAYMENTS_ON === '1') return 'on';
  if (switchCache && Date.now() - switchCache.t < 60e3) return switchCache.state;
  const d = await store.get(SWITCH_KEY, { fresh: true }).catch(() => null);
  const state = d && STATES.includes(d.state) ? d.state : (d && d.on ? 'on' : 'off');
  switchCache = { t: Date.now(), state };
  return state;
}
const switchOn = async () => (await switchState()) === 'on';
async function setSwitch(v) {
  const state = v === true ? 'on' : STATES.includes(v) ? v : 'off';
  await store.put(SWITCH_KEY, { state, on: state === 'on', updatedAt: new Date().toISOString() });
  switchCache = { t: Date.now(), state };
  return state;
}
/** Venta activa para este usuario: clave de Stripe puesta Y interruptor encendido (o en "solo yo" y es el admin). */
const enabled = async owner => {
  if (!configured()) return false;
  const st = await switchState();
  return st === 'on' || (st === 'owner' && !!owner);
};
const live = () => /^(sk|rk)_live_/.test(key());
const price = () => Math.max(50, parseInt(process.env.PASS_PRICE_CENTS, 10) || 499);
const until = () => process.env.PASS_UNTIL || '2027-06-30T23:59:59+02:00';
const passName = () => process.env.PASS_NAME || 'Pase de temporada BigData Fantasy 2026/27';
const eur = c => (c / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const untilText = () => new Date(until()).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });

/** Condiciones de compra (se enseñan en la app y en la página de pago de Stripe). */
function terms() {
  return `Pago único de ${eur(price())}, sin renovación automática. Premium hasta el ${untilText()}. ` +
    'Si LaLiga corta el acceso a sus datos y la app deja de funcionar, te devolvemos la parte proporcional de los días que queden.';
}

async function info(owner) {
  const on = await enabled(owner);
  const state = await switchState();
  return { enabled: on, configured: configured(), switchOn: state === 'on', state, mode: configured() ? (live() ? 'live' : 'test') : null, price: price(), priceText: eur(price()), until: until(), untilText: untilText(), terms: terms() };
}

/** ¿Tiene un pase pagado y vigente? Los pases de pruebas no valen cuando la clave es real. */
function passActive(user, now) {
  const p = user && user.pass;
  if (!p || p.revoked) return false;
  if (p.livemode === false && live()) return false;
  return (now || Date.now()) < Date.parse(p.until);
}

function form(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === 'object') form(v, name, out); else out.append(name, String(v));
  }
  return out;
}
async function stripe(method, path, body) {
  if (!configured()) throw Object.assign(new Error('Pagos no configurados'), { status: 503 });
  const r = await fetch(API + path, {
    method, headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: body ? form(body).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Stripe: ' + ((j.error && j.error.message) || r.status)), { status: 502 });
  return j;
}

async function createCheckout(user, origin, consentAt, owner) {
  if (!(await enabled(owner))) throw Object.assign(new Error('La compra del pase aún no está disponible'), { status: 503 });
  if (passActive(user)) throw Object.assign(new Error('Ya tienes el pase de temporada'), { status: 409 });
  const s = await stripe('POST', '/checkout/sessions', {
    mode: 'payment', locale: 'es', client_reference_id: user.uid,
    line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: price(), product_data: { name: passName(), description: 'Premium hasta el ' + untilText() + '. Pago único.' } } } },
    metadata: { uid: user.uid, consentAt: consentAt || '' },
    payment_intent_data: { metadata: { uid: user.uid }, description: passName() },
    custom_text: { submit: { message: terms() } },
    success_url: origin + '/?pago={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/?pago=cancelado'
  });
  return { url: s.url, id: s.id };
}

/** Activa el pase a partir de una sesión de Checkout pagada (idempotente). */
async function grantFromSession(s) {
  if (!s || s.object !== 'checkout.session' || s.payment_status !== 'paid') return null;
  const uid = s.client_reference_id || (s.metadata && s.metadata.uid);
  if (!uid) return null;
  const user = await users.get(uid);
  if (!user) { console.error('pago sin usuario', s.id); return null; }
  if (user.pass && user.pass.session === s.id) return user;
  user.pass = {
    until: until(), paidAt: new Date((s.created || Date.now() / 1000) * 1000).toISOString(), amount: s.amount_total, currency: s.currency,
    session: s.id, paymentIntent: s.payment_intent || null, livemode: !!s.livemode, consentAt: (s.metadata && s.metadata.consentAt) || null
  };
  await users.save(user);
  if (s.payment_intent) await store.put('billing/pi/' + s.payment_intent + '.json', { uid, session: s.id });
  return user;
}

/** Al volver de Stripe: comprueba la sesión con Stripe y activa si está pagada. */
async function confirm(user, sessionId) {
  if (!/^cs_(test|live)_[\w]+$/.test(String(sessionId || ''))) throw Object.assign(new Error('Pago no válido'), { status: 400 });
  const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(sessionId));
  if (s.client_reference_id !== user.uid) throw Object.assign(new Error('Este pago no es de tu cuenta'), { status: 403 });
  const u = await grantFromSession(s);
  return { paid: s.payment_status === 'paid', active: passActive(u || user) };
}

/** Firma del webhook (cabecera Stripe-Signature: t=...,v1=...). */
function verify(raw, header, secret, now) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(',').filter(x => x.trim().startsWith('v1=')).map(x => x.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs((now || Date.now()) / 1000 - t) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

async function webhook(raw, header) {
  if (!verify(raw, header, String(process.env.STRIPE_WEBHOOK_SECRET || '').trim())) throw Object.assign(new Error('Firma no válida'), { status: 400 });
  const ev = JSON.parse(raw);
  const o = ev.data && ev.data.object;
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await grantFromSession(o);
  else if (ev.type === 'charge.refunded' && o && o.refunded && o.payment_intent) {
    // Devolución completa: se retira el pase (una devolución parcial, como la prorrata, no lo toca)
    const ref = await store.get('billing/pi/' + o.payment_intent + '.json', { fresh: true });
    const user = ref && await users.get(ref.uid);
    if (user && user.pass && user.pass.paymentIntent === o.payment_intent) { user.pass.revoked = new Date().toISOString(); await users.save(user); }
  }
  return { received: true, type: ev.type };
}

module.exports = { info, terms, passActive, createCheckout, confirm, webhook, verify, grantFromSession, enabled, configured, setSwitch, switchState };

