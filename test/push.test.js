'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpush-'));
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
process.env.OWNER_EMAIL = 'dueno@x.com';
process.env.BETA_OPEN = '0'; // estos tests comprueban el filtro por plan
const webpush = require('web-push');
const push = require('../src/push');
const users = require('../src/users');
const secure = require('../src/secure');

const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
const act = [
  { id: 'a3', date: ago(1), typeId: 31, category: 'Mercado', buyer: 'Alex', seller: 'LALIGA', manager: 'Alex', player: 'Rodri', amount: 30e6 },
  { id: 'a2', date: ago(2), typeId: 1, category: 'Mercado', buyer: 'Marc', seller: 'Alex', manager: 'Marc', player: 'Pedri', amount: 22e6 },
  { id: 'a1', date: ago(100), typeId: 33, category: 'Mercado', buyer: 'LALIGA', seller: 'Alex', manager: 'Alex', player: 'Isco', amount: 5e6 },
  { id: 'r1', date: ago(1), typeId: 20, category: 'Recompensa', manager: 'Alex', player: '', amount: 1e6 }
];

test('pendingFor: solo movimientos recientes, posteriores a empezar a vigilar y no avisados', () => {
  const u = { watch: ['Alex'], watchSince: { Alex: ago(1.5) }, pushSent: [] };
  assert.deepStrictEqual(push.pendingFor(u, act).map(x => x.r.id), ['a3']);
  u.watchSince.Alex = ago(500);
  assert.deepStrictEqual(push.pendingFor(u, act).map(x => x.r.id), ['a3', 'a2']); // a1 tiene más de 48 h
  u.pushSent = ['a3'];
  assert.deepStrictEqual(push.pendingFor(u, act).map(x => x.r.id), ['a2']);
});

test('texto de los avisos', () => {
  assert.match(push.line(act[0], 'Alex'), /^Alex ficha a Rodri del mercado por 30,0 M$/);
  assert.match(push.line(act[1], 'Alex'), /^Alex le vende Pedri a Marc por 22,0 M$/);
  const many = Array.from({ length: 5 }, (_, i) => ({ r: { ...act[0], id: 'x' + i }, n: 'Alex' }));
  const m = push.messagesFor(many);
  assert.strictEqual(m.length, 3);
  assert.match(m[2].body, /y 2 movimientos más/);
});

test('cleanSub: solo servicios de push conocidos', () => {
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  assert.ok(push.cleanSub({ endpoint: 'https://web.push.apple.com/abc', keys }));
  assert.ok(push.cleanSub({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }));
  assert.strictEqual(push.cleanSub({ endpoint: 'https://evil.example/abc', keys }), null);
  assert.strictEqual(push.cleanSub({ endpoint: 'http://web.push.apple.com/abc', keys }), null);
});

test('notifyLeague: envía a quien vigila, respeta el plan y marca lo avisado', async () => {
  const sent = [];
  webpush.sendNotification = async (sub, body) => { sent.push({ sub: sub.endpoint, msg: JSON.parse(body) }); if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('gone'), { statusCode: 410 }); return {}; };
  const mk = async (email, extra) => { const u = { uid: secure.userId(email), sv: 1, email: secure.encrypt(email), pass: secure.encrypt('x'), leagueId: 'L1', ...extra }; await users.save(u); return u; };
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
  const owner = await mk('dueno@x.com', {});
  await push.setWatch(owner, ['Alex']);
  const o2 = await users.get(owner.uid); o2.watchSince = { Alex: ago(10) }; await users.save(o2);
  await push.subscribe(o2, { endpoint: 'https://web.push.apple.com/ok', keys }, 'iPhone');
  await push.subscribe(await users.get(owner.uid), { endpoint: 'https://web.push.apple.com/gone', keys }, 'iPhone');
  const free = await mk('gratis@x.com', {});
  await push.setWatch(free, ['Alex']);
  const f2 = await users.get(free.uid); f2.watchSince = { Alex: ago(10) }; await users.save(f2);
  await push.subscribe(f2, { endpoint: 'https://web.push.apple.com/free', keys }, 'iPhone');

  const r = await push.notifyLeague('L1', act);
  assert.strictEqual(r.candidates, 2);
  const titles = sent.filter(s => s.sub.endsWith('/ok')).map(s => s.msg.body);
  assert.deepStrictEqual(titles, ['Alex ficha a Rodri del mercado por 30,0 M', 'Alex le vende Pedri a Marc por 22,0 M']);
  assert.ok(!sent.some(s => s.sub.endsWith('/free')), 'plan básico no recibe push');
  const after = await users.get(owner.uid);
  assert.deepStrictEqual(after.push.map(s => s.endpoint), ['https://web.push.apple.com/ok'], 'la suscripción caducada se borra');
  assert.deepStrictEqual(after.pushSent.sort(), ['a2', 'a3']);
  sent.length = 0;
  await push.notifyLeague('L1', act);
  assert.strictEqual(sent.length, 0, 'no repite avisos');
  // Otra liga: nada
  await push.notifyLeague('L2', [{ ...act[0], id: 'z' }]);
  assert.strictEqual(sent.length, 0);
});

test('claves VAPID: se generan una vez y se reutilizan', async () => {
  const a = await push.publicKey();
  assert.match(a, /^[\w-]{80,90}$/);
  const doc = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'config/vapid.json'), 'utf8'));
  assert.strictEqual(doc.publicKey, a);
  assert.ok(!/^[\w-]{43}$/.test(doc.privateKey), 'la privada se guarda cifrada');
});

