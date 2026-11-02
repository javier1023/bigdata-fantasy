'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-'));
process.env.DATA_DIR = dir;
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
process.env.CRON_SECRET = 'cron123';
delete process.env.BLOB_READ_WRITE_TOKEN;

// LaLiga y futbolfantasy simulados: nadie sale a internet
const laliga = require('../src/laliga');
const ff = require('../src/futbolfantasy');
let logins = 0;
laliga.login = async (email, password) => {
  logins++;
  if (password !== 'buena') throw Object.assign(new Error('Login fallido (400): mal'), { code: 'LOGIN_FAILED' });
  return 'tok-' + email;
};
laliga.leagues = async token => [{ id: 'L1', name: 'Liga de prueba', team: { id: 'T1', money: 5000000 } }];
laliga.fetchPublic = async () => ({ players: [{ id: 1, nickname: 'A', teamId: 9, positionId: 4, marketValue: 1000, weekPoints: [] }], teams: [], types: [], calendar: null });
laliga.fetchLeagueData = async (token, league) => ({ league, standing: [], activity: [], squads: [], fetchedAt: new Date().toISOString() });
laliga.marketValue = async () => [];
ff.fetchProbabilities = async () => ({ week: 8, fetchedAt: new Date().toISOString(), probs: { 1: { prob: 90, role: 'titular' } }, matches: 1, players: 1, unmatched: 0 });

const app = require('../src/app');

test('login con credenciales de LaLiga, perfil cifrado, sesión, datos propios, logout y borrado', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });

  assert.strictEqual((await fetch(base + '/api/data')).status, 401);
  assert.strictEqual((await fetch(base + '/')).status, 200);

  // contraseña mala: 401 y luego bloqueo temporal para ese email
  assert.strictEqual((await post('/api/auth/login', { email: 'ana@x.es', password: 'mala' })).status, 401);
  assert.strictEqual((await post('/api/auth/login', { email: 'ana@x.es', password: 'buena' })).status, 429);

  // otro usuario entra bien
  const r = await post('/api/auth/login', { email: 'Javi@X.es', password: 'buena' });
  assert.strictEqual(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /ff_session=.+HttpOnly/);
  const cookie = setCookie.split(';')[0];

  // en disco no hay ni email ni contraseña en claro
  const files = fs.readdirSync(path.join(dir, 'users'));
  assert.strictEqual(files.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'users', files[0]), 'utf8');
  assert.ok(!/javi@x\.es/i.test(raw) && !raw.includes('buena'));

  const d = await fetch(base + '/api/data', { headers: { cookie } });
  assert.strictEqual(d.status, 200);
  const snap = await d.json();
  assert.strictEqual(snap.league.name, 'Liga de prueba');
  assert.strictEqual(snap.titularidad.probs['1'].prob, 90);
  assert.match(snap.me.email, /^ja\*\*\*@x\.es$/i);

  // refresh manual: vuelve a hacer login con la contraseña descifrada
  const before = logins;
  assert.strictEqual((await post('/api/refresh', {}, cookie)).status, 200);
  assert.strictEqual(logins, before + 1);

  // cookie manipulada no vale
  assert.strictEqual((await fetch(base + '/api/data', { headers: { cookie: cookie.slice(0, -2) + 'xx' } })).status, 401);

  // cron: sin secreto 401; con secreto recarga a todos
  assert.strictEqual((await fetch(base + '/api/refresh')).status, 401);
  const c = await fetch(base + '/api/refresh', { headers: { authorization: 'Bearer cron123' } });
  assert.strictEqual(c.status, 200);
  assert.strictEqual((await c.json()).ok, 1);

  // logout borra la cookie
  const lo = await post('/api/auth/logout', {}, cookie);
  assert.match(lo.headers.get('set-cookie'), /Max-Age=0/);

  // borrar cuenta: desaparece el perfil y la sesión deja de valer
  assert.strictEqual((await post('/api/auth/delete', {}, cookie)).status, 200);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'users')).length, 0);
  assert.strictEqual((await fetch(base + '/api/data', { headers: { cookie } })).status, 401);
});

test('cifrado: ida y vuelta, y un texto manipulado se rechaza', () => {
  const s = require('../src/secure');
  const e = s.encrypt('mi-contraseña');
  assert.notStrictEqual(e, s.encrypt('mi-contraseña')); // IV aleatorio
  assert.strictEqual(s.decrypt(e), 'mi-contraseña');
  const parts = e.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => s.decrypt(parts.join('.')));
  assert.strictEqual(s.userId('A@b.com'), s.userId(' a@B.com '));
});

