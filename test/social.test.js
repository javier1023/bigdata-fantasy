'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-social-'));
process.env.DATA_DIR = dir;
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
process.env.CRON_SECRET = 'cron123';
delete process.env.BLOB_READ_WRITE_TOKEN;

const laliga = require('../src/laliga');
const ff = require('../src/futbolfantasy');
const idTok = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
let exchanged = [], refreshed = [], logins = 0, rtOk = true;
laliga.login = async () => { logins++; throw new Error('no debería usarse'); };
laliga.exchangeCode = async (code, verifier) => {
  exchanged.push({ code, verifier });
  if (code === 'usado') throw Object.assign(new Error('mal'), { code: 'GRANT_INVALID', b2c: 'AADB2C90080' });
  return { accessToken: 'acc-1', refreshToken: 'rt-1', idToken: idTok({ emails: ['alex@icloud.com'], idp: 'apple.com' }), expiresIn: 60, refreshExpiresIn: null };
};
laliga.refreshSocial = async rt => {
  refreshed.push(rt);
  if (!rtOk) throw Object.assign(new Error('caducado'), { code: 'GRANT_INVALID' });
  return { accessToken: 'acc-' + (refreshed.length + 1), refreshToken: 'rt-' + (refreshed.length + 1), expiresIn: 86400 };
};
laliga.leagues = async token => { assert.match(token, /^acc-/); return [{ id: 'L1', name: 'Liga', team: { id: 'T1' } }]; };
laliga.fetchPublic = async () => ({ players: [], teams: [], types: [], calendar: null });
laliga.fetchLeagueData = async (token, league) => ({ league, standing: [], activity: [], squads: [], fetchedAt: new Date().toISOString() });
laliga.marketValue = async () => [];
ff.fetchProbabilities = async () => ({ probs: {} });

const app = require('../src/app');
const users = require('../src/users');
const crypto = require('crypto');

test('modo avanzado: PKCE, código pegado, refresh token cifrado, cron con refresh y aviso de caducidad', async (t) => {
  const srv = app.listen(0); t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });

  // sin haber empezado: no hay verifier
  assert.strictEqual((await post('/api/auth/social/finish', { url: 'https://jwt.ms/?code=abc&state=x' })).status, 400);

  const s = await post('/api/auth/social/start');
  const { url } = await s.json();
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://jwt.ms');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('client_id'), 'af88bcff-1157-40a0-b579-030728aacf0b');
  const state = u.searchParams.get('state');
  const pk = s.headers.get('set-cookie').split(';')[0];

  // texto que no es la URL: ni siquiera se llama a LaLiga
  const n0 = exchanged.length;
  assert.strictEqual((await (await post('/api/auth/social/finish', { url: 'hola' }, pk)).json()).code, 'NOT_URL');
  assert.strictEqual((await (await post('/api/auth/social/finish', { url: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ilg1ZVhrNHh5b2pORnVtMWtsMll0djhkbE5QNC1jNTdkTzZRR1RWQndhTmsiLCJ0eXAiOiJKV1QifQ.eyJleHAiOjE3' }, pk)).json()).code, 'NOT_URL');
  assert.strictEqual((await (await post('/api/auth/social/finish', { url: 'https://jwt.ms/' }, pk)).json()).code, 'NO_CODE');
  assert.strictEqual(exchanged.length, n0);
  // state de otro intento
  assert.strictEqual((await (await post('/api/auth/social/finish', { url: 'https://jwt.ms/?code=abcdef&state=otro' }, pk)).json()).code, 'STATE');
  // cancelado en LaLiga
  assert.strictEqual((await (await post('/api/auth/social/finish', { url: 'https://jwt.ms/?error=access_denied&error_description=AADB2C90091&state=' + state }, pk)).json()).code, 'SOCIAL_ERROR');

  // bueno (con espacios/saltos que mete a veces el pegado)
  const f = await post('/api/auth/social/finish', { url: ' https://jwt.ms/?code=CODIGO123\n&state=' + state + ' ' }, pk);
  assert.strictEqual(f.status, 200, await f.clone().text());
  const verifier = exchanged[exchanged.length - 1].verifier;
  assert.strictEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), u.searchParams.get('code_challenge'));
  assert.strictEqual(exchanged[exchanged.length - 1].code, 'CODIGO123');
  const cookie = f.headers.get('set-cookie').split(/,(?=\s*ff_)/).map(c => c.split(';')[0].trim()).find(c => c.startsWith('ff_session='));
  assert.ok(cookie);

  // el mismo verifier no se puede reutilizar (cookie borrada)
  assert.match(f.headers.get('set-cookie'), /ff_pkce=;/);

  // perfil: refresh token cifrado, nada en claro
  const uid = require('../src/secure').userId('alex@icloud.com');
  const raw = fs.readFileSync(path.join(dir, 'users', uid + '.json'), 'utf8');
  assert.ok(!raw.includes('rt-1') && !raw.includes('acc-1') && !raw.includes('alex@icloud.com'));
  const user = await users.get(uid);
  assert.strictEqual(user.auth, 'social'); assert.ok(!user.pass);

  // me: estado del acceso social, sin aviso recién entrado
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  assert.strictEqual(me.social.daysLeft, 89); assert.strictEqual(me.social.warn, false);
  assert.match(me.email, /^al\*\*\*@icloud\.com$/);

  // ⟳ con token de acceso casi caducado (60 s): usa el refresh token y guarda el nuevo
  const r1 = await post('/api/refresh', {}, cookie);
  assert.strictEqual(r1.status, 200, await r1.clone().text());
  assert.deepStrictEqual(refreshed, ['rt-1']);
  assert.strictEqual(logins, 0);
  const u2 = await users.get(uid);
  assert.strictEqual(require('../src/secure').decrypt(u2.rt), 'rt-2');
  // segunda recarga: el token de acceso (24 h) aún vale, no gasta refresh
  const repeated = await post('/api/refresh', {}, cookie);
  assert.strictEqual(repeated.status, 429);
  assert.ok(Number(repeated.headers.get('retry-after')) > 0);
  assert.strictEqual(refreshed.length, 1);

  // aviso: quedan 5 días
  u2.socialExpiresAt = new Date(Date.now() + 5.5 * 864e5).toISOString(); await users.save(u2);
  const d = await (await fetch(base + '/api/data', { headers: { cookie } })).json();
  assert.strictEqual(d.me.social.daysLeft, 5); assert.strictEqual(d.me.social.warn, true);

  // refresh token rechazado por LaLiga: hay que volver a entrar, con mensaje de redes sociales
  u2.atExpiresAt = new Date(0).toISOString(); await users.save(u2);
  rtOk = false;
  // Expire the local test gate to exercise LaLiga's rejected refresh token.
  fs.writeFileSync(path.join(dir, 'limits', encodeURIComponent('refresh:' + uid).replace(/%/g, '_') + '.json'), JSON.stringify({ until: 0 }));
  const r2 = await post('/api/refresh', {}, cookie);
  assert.strictEqual(r2.status, 401);
  assert.match((await r2.json()).error, /Google, Apple o Facebook/);
  assert.strictEqual((await users.get(uid)).credsInvalid, true);

  // volver a entrar lo arregla y renueva los 90 días
  const s2 = await post('/api/auth/social/start');
  const st2 = new URL((await s2.json()).url).searchParams.get('state');
  const f2 = await post('/api/auth/social/finish', { url: 'https://jwt.ms/?code=OTRO456&state=' + st2 }, s2.headers.get('set-cookie').split(';')[0]);
  assert.strictEqual(f2.status, 200);
  const u3 = await users.get(uid);
  assert.strictEqual(u3.credsInvalid, false); assert.strictEqual(users.socialStatus(u3).daysLeft, 89);

  // código caducado/usado
  const s3 = await post('/api/auth/social/start');
  const st3 = new URL((await s3.json()).url).searchParams.get('state');
  const f3 = await post('/api/auth/social/finish', { url: 'https://jwt.ms/?code=usado&state=' + st3 }, s3.headers.get('set-cookie').split(';')[0]);
  assert.strictEqual((await f3.json()).code, 'CODE_INVALID');
});

test('canje sin access_token: usa el id_token como Bearer', async () => {
  const real = require('../src/laliga');
  delete require.cache[require.resolve('../src/laliga')];
  const fresh = require('../src/laliga');
  require.cache[require.resolve('../src/laliga')].exports = real; // no romper el otro test
  const id = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, emails: ['a@b.es'] })).toString('base64url') + '.s';
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id_token: id, refresh_token: 'rt', id_token_expires_in: 3600 }) });
  try {
    const t = await fresh.exchangeCode('c', 'v');
    assert.strictEqual(t.accessToken, id); assert.strictEqual(t.refreshToken, 'rt'); assert.strictEqual(t.expiresIn, 3600);
  } finally { global.fetch = orig; }
});

