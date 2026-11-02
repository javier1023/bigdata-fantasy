'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbill-'));
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
process.env.OWNER_EMAIL = 'dueno@x.com';
const billing = require('../src/billing');
const plans = require('../src/plan');
const users = require('../src/users');
const secure = require('../src/secure');

const mkUser = async email => { const u = { uid: secure.userId(email), sv: 1, email: secure.encrypt(email), pass: undefined, leagueId: 'L1' }; await users.save(u); return u; };
const sign = (body, secret, t) => { t = t || Math.floor(Date.now() / 1000); return `t=${t},v1=` + crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex'); };

test('sin clave o con el interruptor apagado no se vende', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  assert.strictEqual((await billing.info()).enabled, false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  assert.strictEqual((await billing.info()).enabled, false, 'interruptor apagado por defecto');
  const u = await mkUser('a@x.com');
  await assert.rejects(billing.createCheckout(u, 'https://x'), /aún no está disponible/);
  await billing.setSwitch(true);
  const i = await billing.info();
  assert.strictEqual(i.enabled, true); assert.strictEqual(i.mode, 'test'); assert.strictEqual(i.priceText, '4,99 €');
  assert.match(i.terms, /parte proporcional/);
  await billing.setSwitch(false);
});

test('modo "solo yo": solo el admin puede comprar', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  const u = await mkUser('b@x.com');
  await billing.setSwitch('owner');
  assert.strictEqual((await billing.info(false)).enabled, false, 'un usuario normal no ve la compra');
  assert.strictEqual((await billing.info(true)).enabled, true, 'el admin sí');
  assert.strictEqual((await billing.info(true)).state, 'owner');
  assert.strictEqual((await billing.info(true)).switchOn, false);
  await assert.rejects(billing.createCheckout(u, 'https://x', null, false), /aún no está disponible/);
  await billing.setSwitch('off');
  assert.strictEqual((await billing.info(true)).enabled, false, 'apagada: ni el admin');
  await billing.setSwitch('on');
  assert.strictEqual((await billing.info(false)).enabled, true, 'todos');
  await billing.setSwitch(false);
  assert.strictEqual(await billing.switchState(), 'off');
});

test('checkout: crea la sesión con el uid y las condiciones', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  await billing.setSwitch(true);
  const u = await mkUser('b@x.com');
  const orig = global.fetch; let seen;
  global.fetch = async (url, o) => { seen = { url, body: new URLSearchParams(o.body) }; return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); };
  try {
    const r = await billing.createCheckout(u, 'https://app.example', '2026-09-24T17:00:00Z');
    assert.strictEqual(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.strictEqual(seen.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.strictEqual(seen.body.get('client_reference_id'), u.uid);
    assert.strictEqual(seen.body.get('line_items[0][price_data][unit_amount]'), '499');
    assert.strictEqual(seen.body.get('mode'), 'payment');
    assert.match(seen.body.get('custom_text[submit][message]'), /devolvemos la parte proporcional/);
    assert.strictEqual(seen.body.get('success_url'), 'https://app.example/?pago={CHECKOUT_SESSION_ID}');
  } finally { global.fetch = orig; await billing.setSwitch(false); }
});

test('webhook: firma, activación del pase, plan premium y devolución completa', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_prueba';
  const u = await mkUser('c@x.com');
  const session = { object: 'checkout.session', id: 'cs_test_2', payment_status: 'paid', client_reference_id: u.uid, amount_total: 499, currency: 'eur', payment_intent: 'pi_2', livemode: false, created: Math.floor(Date.now() / 1000), metadata: { uid: u.uid } };
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
  await assert.rejects(billing.webhook(body, sign(body, 'otro')), /Firma/);
  await assert.rejects(billing.webhook(body, sign(body, 'whsec_prueba', Math.floor(Date.now() / 1000) - 1000)), /Firma/);
  await billing.webhook(body, sign(body, 'whsec_prueba'));
  let fresh = await users.get(u.uid);
  assert.strictEqual(fresh.pass.session, 'cs_test_2');
  assert.strictEqual(plans.planFor(fresh, []).plan, 'premium');
  assert.ok(plans.planFor(fresh, []).pass.test);
  // pase de prueba no vale con clave real
  process.env.STRIPE_SECRET_KEY = 'sk_live_x';
  assert.strictEqual(plans.planFor(fresh, []).plan, 'free');
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  // devolución parcial (prorrata) no quita el pase; completa sí
  const partial = JSON.stringify({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_2', refunded: false, amount_refunded: 200 } } });
  await billing.webhook(partial, sign(partial, 'whsec_prueba'));
  assert.strictEqual(plans.planFor(await users.get(u.uid), []).plan, 'premium');
  const full = JSON.stringify({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_2', refunded: true, amount_refunded: 499 } } });
  await billing.webhook(full, sign(full, 'whsec_prueba'));
  fresh = await users.get(u.uid);
  assert.strictEqual(plans.planFor(fresh, []).plan, 'free');
});

test('pase caducado vuelve a básico', () => {
  const u = { pass: { until: '2020-01-01T00:00:00Z', livemode: true } };
  assert.strictEqual(billing.passActive(u), false);
});

