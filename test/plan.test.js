'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.CREDS_KEY = process.env.CREDS_KEY || 'clave-de-prueba-0123456789abcdef';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'plan-'));
delete process.env.BLOB_READ_WRITE_TOKEN;
const secure = require('../src/secure');
const { planFor, applyPlan, getTesters, setTesters } = require('../src/plan');

const u = (email, extra) => ({ uid: 'x', email: secure.encrypt(email), pass: secure.encrypt('p'), ...extra });
const now = new Date('2026-09-24T10:00:00Z');
const snap = {
  fetchedAt: now.toISOString(),
  managers: [
    { id: '1', name: 'Yo', isMe: true, realCash: 5, purchases: 1, sales: 2, rewards: 3, squad: [{ profit: 1 }], exPlayers: [], exProfit: 0 },
    { id: '2', name: 'Rival', isMe: false, realCash: null, purchases: 10, sales: 20, rewards: 30, exProfit: 4, exPlayers: [{ profit: 3, buyPrice: 1, sellPrice: 4 }], squad: [{ profit: 7, buyPrice: 3, value: 10, yesterday: 9, clauseLockedUntil: '2026-09-24T15:00:00Z' }, { profit: 1, buyPrice: 1, value: 2, yesterday: 2, clauseLockedUntil: '2026-09-24T12:00:00Z' }, { profit: 1, value: 2, clauseLockedUntil: '2026-09-28T12:00:00Z' }] }
  ],
  activity: [{ date: '2026-09-24T08:00:00Z' }, { date: '2026-09-20T08:00:00Z' }],
  fixtures: { week: 6, weeks: [{ week: 6 }, { week: 7 }, { week: 8 }], next: { 9: [{ week: 6 }, { week: 7 }, { week: 8 }] } }
};

test('plan: dueño, vista previa, testers y resto', () => {
  process.env.OWNER_EMAIL = 'Javi@Mail.com';
  process.env.TESTER_EMAILS = 'amigo@mail.com, otro@mail.com';
  assert.deepStrictEqual(planFor(u('javi@mail.com')), { plan: 'premium', owner: true, tester: false, preview: false, pass: null, beta: false, betaOpen: false });
  assert.strictEqual(planFor(u('javi@mail.com', { preview: 'free' })).plan, 'free');
  assert.strictEqual(planFor(u('AMIGO@mail.com')).plan, 'premium');
  assert.strictEqual(planFor(u('amigo@mail.com')).tester, true);
  assert.strictEqual(planFor(u('nadie@mail.com')).plan, 'free');
  assert.strictEqual(planFor(u('nadie@mail.com', { preview: 'free', plan: 'premium' })).plan, 'premium');
  delete process.env.OWNER_EMAIL; process.env.LALIGA_EMAIL = 'javi@mail.com';
  assert.strictEqual(planFor(u('javi@mail.com')).owner, true);
  delete process.env.LALIGA_EMAIL;
  assert.strictEqual(planFor(u('javi@mail.com')).owner, false);
});

test('plan básico: sin liquidez de rivales, mercado 24 h y solo la jornada actual', () => {
  const f = applyPlan(snap, { plan: 'free' }, now.getTime());
  const me = f.managers[0], rival = f.managers[1];
  assert.strictEqual(me.purchases, 1); assert.strictEqual(me.realCash, 5);
  assert.strictEqual(rival.purchases, undefined); assert.strictEqual(rival.sales, undefined); assert.strictEqual(rival.rewards, undefined);
  assert.strictEqual(rival.liquidityLocked, true);
  assert.strictEqual(rival.exProfit, null); assert.strictEqual(rival.squad[0].profit, null); assert.strictEqual(rival.squad[0].buyPrice, null);
  assert.strictEqual(rival.squad[0].value, 10); assert.strictEqual(rival.squad[0].yesterday, 9);
  assert.strictEqual(rival.exPlayers[0].profit, 3); assert.strictEqual(rival.exPlayers[0].sellPrice, 4); assert.strictEqual(rival.exHidden, 0);
  assert.strictEqual(me.squad[0].profit, 1);
  // protecciones < 24 h: se ve la más próxima (12:00), la de las 15:00 va oculta, la del día 28 intacta
  assert.strictEqual(rival.squad[1].clauseLockedUntil, '2026-09-24T12:00:00Z');
  assert.strictEqual(rival.squad[0].clauseLockedUntil, null); assert.strictEqual(rival.squad[0].lockHidden, true);
  assert.strictEqual(rival.squad[2].clauseLockedUntil, '2026-09-28T12:00:00Z');
  assert.strictEqual(f.locksHidden, 1);
  assert.deepStrictEqual(f.fixtures.next['9'].map(x => x.week), [6]); assert.strictEqual(f.fixtures.nextHidden['9'], 2);
  assert.strictEqual(snap.fixtures.next['9'].length, 3);
  assert.strictEqual(snap.managers[1].squad[0].clauseLockedUntil, '2026-09-24T15:00:00Z');
  assert.strictEqual(f.activity.length, 1); assert.strictEqual(f.activityHidden, 1);
  assert.deepStrictEqual(f.fixtures.weeks.map(w => w.week), [6]); assert.strictEqual(f.fixtures.weeksHidden, 2);
  assert.deepStrictEqual(f.plan.locked, ['liquidity', 'market', 'weeks', 'profit', 'locks', 'playerTx', 'watch']);
  const p = applyPlan(snap, { plan: 'premium' });
  assert.strictEqual(p.managers[1].purchases, 10); assert.strictEqual(p.activity.length, 2); assert.strictEqual(p.fixtures.weeks.length, 3);
  assert.deepStrictEqual(p.plan.locked, []);
});

test('testers guardados: lista inicial, añadir y quitar', async () => {
  delete process.env.TESTER_EMAILS; process.env.OWNER_EMAIL = 'javi@mail.com';
  assert.deepStrictEqual(await getTesters(), ['alejandroperis16@gmail.com']);
  assert.strictEqual(planFor(u('Alejandroperis16@gmail.com'), await getTesters()).plan, 'premium');
  assert.deepStrictEqual(await setTesters(['alejandroperis16@gmail.com', 'Nuevo@Mail.com', 'no-es-email', 'nuevo@mail.com']), ['alejandroperis16@gmail.com', 'nuevo@mail.com']);
  assert.strictEqual(planFor(u('nuevo@mail.com'), await getTesters()).tester, true);
  await setTesters(['nuevo@mail.com']);
  assert.strictEqual(planFor(u('alejandroperis16@gmail.com'), await getTesters()).plan, 'free');
});

test('plan básico: rentabilidad histórica, solo las 10 ventas más recientes', () => {
  const ex = Array.from({ length: 13 }, (_, i) => ({ player: 'J' + i, profit: i, buyPrice: 1, sellPrice: 2 }));
  const out = applyPlan({ fetchedAt: '2026-09-24T10:00:00Z', managers: [{ id: '2', isMe: false, squad: [], exPlayers: ex, exProfit: 5 }] }, { plan: 'free' });
  const r = out.managers[0];
  assert.strictEqual(r.exPlayers.length, 10); assert.strictEqual(r.exPlayers[9].profit, 9); assert.strictEqual(r.exHidden, 3); assert.strictEqual(r.exProfit, null);
});

test('plan básico: movimientos del jugador bloqueados, solo se cuenta lo antiguo', () => {
  const out = applyPlan({ fetchedAt: '2026-09-24T10:00:00Z', managers: [], activity: [{ playerId: 7, amount: 5, date: '2026-09-20T10:00:00Z' }, { playerId: 7, amount: 6, date: '2026-09-24T09:00:00Z' }] }, { plan: 'free' });
  assert.ok(out.plan.locked.includes('playerTx')); assert.strictEqual(out.txHidden[7], 1); assert.strictEqual(out.activity.length, 1);
  assert.deepStrictEqual(applyPlan({ managers: [] }, { plan: 'premium' }).plan.locked, []);
});

test('plan básico: de las protecciones <24 h de toda la liga (propias incluidas) solo se ve una', () => {
  const at = h => new Date(Date.parse('2026-09-24T10:00:00Z') + h * 36e5).toISOString();
  const snap = { fetchedAt: '2026-09-24T10:00:00Z', managers: [
    { id: '1', isMe: true, squad: [{ playerId: 'a', clauseLockedUntil: at(1) }, { playerId: 'b', clauseLockedUntil: at(30) }], exPlayers: [] },
    { id: '2', isMe: false, squad: [{ playerId: 'c', clauseLockedUntil: at(2) }, { playerId: 'd', clauseLockedUntil: at(3) }, { playerId: 'e', clauseLockedUntil: at(4) }, { playerId: 'f', clauseLockedUntil: at(5) }, { playerId: 'g', clauseLockedUntil: at(6) }], exPlayers: [] }
  ] };
  const out = applyPlan(snap, { plan: 'free' }, Date.parse('2026-09-24T10:00:00Z'));
  const [me, rival] = out.managers;
  assert.strictEqual(me.squad[0].lockSoonHidden, undefined); assert.strictEqual(me.squad[0].clauseLockedUntil, at(1));
  assert.ok(rival.squad.every(p => p.lockHidden && p.clauseLockedUntil === null));
  assert.strictEqual(out.locksHidden, 5);
  assert.strictEqual(snap.managers[0].squad[0].lockSoonHidden, undefined);
  const snap2 = { fetchedAt: snap.fetchedAt, managers: [{ ...snap.managers[0], squad: [{ playerId: 'a', clauseLockedUntil: at(8) }] }, { ...snap.managers[1], squad: [{ playerId: 'c', clauseLockedUntil: at(2) }] }] };
  const out2 = applyPlan(snap2, { plan: 'free' }, Date.parse('2026-09-24T10:00:00Z'));
  assert.strictEqual(out2.managers[0].squad[0].lockSoonHidden, true); assert.strictEqual(out2.managers[0].squad[0].clauseLockedUntil, at(8));
  assert.strictEqual(out2.managers[1].squad[0].lockHidden, undefined); assert.strictEqual(snap2.managers[0].squad[0].lockSoonHidden, undefined);
});

test('beta abierta: todos con plan completo, sin tocar dueño en vista básica', async () => {
  const p = require('../src/plan');
  delete process.env.BETA_OPEN;
  assert.strictEqual(await p.getBeta(), true, 'por defecto abierta');
  const u = { plan: 'free', email: null };
  const r = p.planFor(u, [], true);
  assert.strictEqual(r.plan, 'premium'); assert.strictEqual(r.beta, true);
  assert.strictEqual(p.planFor(u, [], false).plan, 'free');
  assert.strictEqual(p.applyPlan({ managers: [] }, r).plan.locked.length, 0);
  await p.setBeta(false); assert.strictEqual(await p.getBeta(), false);
  process.env.BETA_OPEN = '1'; assert.strictEqual(await p.getBeta(), true); delete process.env.BETA_OPEN;
  await p.setBeta(true);
});

test('plan básico oculta anuncios vigentes del mercado además del historial', () => {
  const { applyPlan } = require('../src/plan');
  const snap = { fetchedAt: '2026-09-25T08:00:00Z', managers:[], activity:[], players:[], market:[{ playerId:'1',salePrice:1200000 }] };
  const free = applyPlan(snap,{ plan:'free' });
  assert.deepStrictEqual(free.market,[]);
  assert.strictEqual(free.marketLocked,true);
  const premium = applyPlan(snap,{ plan:'premium' });
  assert.strictEqual(premium.market.length,1);
  assert.strictEqual(premium.marketLocked,undefined);
});

