'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../public/calc.js');
const { valueOn, dayOf } = require('../src/snapshot');

const rules = { startingCash: 100e6, dailyVideoBonus: 100e3 };
const rival = { joined: '2026-07-27T10:00:00+02:00', sales: 50e6, rewards: 2e6, purchases: 120e6, squadValue: 200e6, squadValueYesterday: 190e6, realCash: null };

test('días desde el alta, hoy incluido', () => {
  assert.strictEqual(C.daysInclusive('2026-07-27', '2026-09-23'), 59);
  assert.strictEqual(C.daysInclusive('2026-08-15', '2026-09-23'), 40);
});

test('caja estimada de un rival = 100 M + vídeos + ventas + recompensas − compras − cláusulas', () => {
  const l = C.liquidity(rival, rules, { today: '2026-09-23', clauses: 10e6 });
  assert.strictEqual(l.videos, 5.9e6);
  assert.strictEqual(l.cash, 100e6 + 5.9e6 + 50e6 + 2e6 - 120e6 - 10e6);
  assert.strictEqual(l.total, l.cash + 200e6);
});

test('para el usuario se usa la caja real y se ignoran las cláusulas', () => {
  const me = Object.assign({}, rival, { realCash: 123805054 });
  const l = C.liquidity(me, rules, { today: '2026-09-23', clauses: 99e6 });
  assert.strictEqual(l.real, true);
  assert.strictEqual(l.cash, 123805054);
  assert.strictEqual(l.clauses, 0);
});

test('variación diaria de la plantilla', () => {
  const c = C.squadChange(rival);
  assert.strictEqual(c.diff, 10e6);
  assert.ok(Math.abs(c.pct - 10 / 190) < 1e-12);
});

test('valor de mercado en un día concreto', () => {
  const h = [{ date: '2026-07-01T00:00:00', marketValue: 1 }, { date: '2026-08-01T00:00:00', marketValue: 2 }, { date: '2026-08-03T00:00:00', marketValue: 3 }];
  assert.strictEqual(valueOn(h, '2026-08-02'), 2);
  assert.strictEqual(valueOn(h, '2026-06-01'), 1);
  assert.strictEqual(valueOn([], '2026-06-01'), null);
  assert.strictEqual(dayOf('2026-09-23T23:30:00Z'), '2026-09-24');
});

test('valor de ayer: último publicado antes de hoy', () => {
  const { yesterdayValue } = require('../src/snapshot');
  const h = [{ date: '2026-09-21T00:00:00', marketValue: 10 }, { date: '2026-09-22T00:00:00', marketValue: 12 }, { date: '2026-09-23T00:00:00', marketValue: 15 }];
  assert.strictEqual(yesterdayValue(h, '2026-09-23', 15), 12);
  assert.strictEqual(yesterdayValue(null, '2026-09-23', 15), 15);
});

test('predicción: racha, rival, casa/fuera y estado', () => {
  const C = require('../public/calc.js');
  const players = [
    { id: '1', teamId: 'A', position: 'Delantero', last5: [4, 6, 8, 10, 12] },
    { id: '2', teamId: 'B', position: 'Defensa', last5: [1, 1, 1, 1, 1] },
    { id: '3', teamId: 'C', position: 'Defensa', last5: [9, 9, 9, 9, 9] }
  ];
  const teams = C.teamForms(players);
  const p = { last5: [4, 6, 8, 10, 12], avg: 8, status: 'ok' };
  const easy = C.predict(p, { teams, next: { opp: 'B', home: true, week: 6 } });
  const hard = C.predict(p, { teams, next: { opp: 'C', home: false, week: 6 } });
  assert.ok(easy.points > hard.points);
  assert.strictEqual(easy.week, 6);
  assert.ok(easy.why.includes('rival flojo') && hard.why.includes('rival fuerte'));
  assert.strictEqual(C.predict({ ...p, status: 'injured' }, { teams }).points, 0);
  assert.strictEqual(C.predict({ last5: [null, null], avg: 0 }, {}), null);
  const lowProb = C.predict(p, { teams, prob: 10 });
  assert.ok(lowProb.points < C.predict(p, { teams, prob: 95 }).points);
});

