'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
process.env.DATA_DIR = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'fantasy-migration-'));
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
const laliga = require('../src/laliga');
const secure = require('../src/secure');
const users = require('../src/users');
const idToken = 'x.' + Buffer.from(JSON.stringify({emails:['old@example.com']})).toString('base64url') + '.y';
laliga.exchangeCode = async () => ({accessToken:'access',refreshToken:'refresh',idToken,expiresIn:3600});
laliga.leagues = async () => [{id:'L1',name:'Liga',team:{id:'T1'}}];
test('la migración por el mismo email quita pass y conserva ajustes del perfil antiguo', async () => {
  const uid = secure.userId('old@example.com');
  const old = {uid,email:secure.encrypt('old@example.com'),pass:secure.encrypt('old-secret'),sv:7,
    createdAt:'2026-09-01T12:00:00Z',lastRefreshAt:'2026-09-24T12:00:00Z',
    leagues:[{id:'L1',name:'Liga'}],leagueId:'L1',plan:'premium',preview:'free',
    contactEmail:secure.encrypt('contact@example.com'),welcomeSeenAt:'2026-09-10T12:00:00Z',
    watch:['Mar'],push:[{endpoint:'https://push.example.test/abc'}],passNote:'other preference'};
  await users.save(old);
  const {user} = await users.socialLogin('one-use-code','verifier');
  assert.equal(user.uid,uid); assert.equal(user.auth,'social'); assert.equal(user.pass,null);
  for(const k of ['sv','createdAt','lastRefreshAt','leagueId','plan','preview','contactEmail','welcomeSeenAt','watch','push','passNote'])
    assert.deepEqual(user[k],old[k],k);
  assert.equal(secure.decrypt(user.rt),'refresh');
});

