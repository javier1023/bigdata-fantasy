const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'lg-'));
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
const users = require('../src/users');

test('ligas: se ocultan las globales y las detectadas como enormes; quedan las privadas', () => {
  const raw = [
    { id: 1, name: 'LALIGA Fantástica', isOfficial: true },
    { id: 2, name: 'mi-liga', managersNumber: 11 },
    { id: 3, name: 'prueba', managersNumber: 1 },
    { id: 4, name: 'Global DAZN', type: 'sponsored' },
    { id: 5, name: 'Otra enorme', managersNumber: 18700 },
    { id: 6, name: 'Sin datos' }
  ];
  const r = users.splitLeagues(raw, { bigLeagues: ['6'] });
  assert.deepStrictEqual(r.leagues.map(l => l.name), ['mi-liga', 'prueba']);
  assert.deepStrictEqual(r.hiddenLeagues.map(l => l.id), ['1', '4', '5', '6']);
  assert.deepStrictEqual(users.leagueMeta([{ id: 1, name: 'x', money: 5, team: { a: 1 } }]), [{ id: 1, name: 'x' }]);
});

