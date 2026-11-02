'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-refresh-fail-'));
process.env.DATA_DIR = dir;
process.env.CREDS_KEY = 'clave-de-prueba-0123456789abcdef';
delete process.env.BLOB_READ_WRITE_TOKEN;
const laliga = require('../src/laliga');
const ff = require('../src/futbolfantasy');
laliga.login = async () => 'token';
laliga.leagues = async () => [{ id: 'L', name: 'Liga', team: { id: 'T', money: 100 } }];
laliga.fetchPublic = async () => ({ players: [], teams: [], types: [], calendar: null });
laliga.marketValue = async () => [];
ff.fetchProbabilities = async () => ({ probs: {} });
let fail = true, attempts = 0;
laliga.fetchLeagueData = async (token, league) => {
  attempts++;
  if (fail) throw new Error('API 503 en la liga');
  return { league, standing: [], activity: [], squads: [], fetchedAt: new Date().toISOString() };
};
const app = require('../src/app');
const users = require('../src/users');
const secure = require('../src/secure');
test('fallo upstream no condena una cuenta vieja a 30 minutos; retry tras backoff', async t => {
  const server = app.listen(0); t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const uid = secure.userId('alejandro@example.test');
  await users.save({uid,email:secure.encrypt('alejandro@example.test'),pass:secure.encrypt('clave'),sv:'v1',auth:'password',lastRefreshAt:'2026-09-24T00:00:00Z'});
  const cookie = 'ff_session=' + secure.signSession({u:uid,v:'v1',e:Date.now()+3600e3});
  const post = () => fetch(base+'/api/refresh',{method:'POST',headers:{cookie}});
  const first = await post(); assert.equal(first.status,502); assert.equal(attempts,1);
  const second = await post(); assert.equal(second.status,429); assert.ok(Number((await second.json()).retryAfter)<=15);
  const file=path.join(dir,'limits',encodeURIComponent('refresh:'+uid).replace(/%/g,'_')+'.json');
  assert.ok(JSON.parse(fs.readFileSync(file,'utf8')).until-Date.now()<=15000);
  // Advance the local lease without waiting 15 real seconds; upstream now works.
  fs.writeFileSync(file,JSON.stringify({until:0,token:'expired'})); fail=false;
  const third=await post(); assert.equal(third.status,200,await third.clone().text());
  assert.equal(attempts,2);
  const fourth=await post(); assert.equal(fourth.status,429); assert.ok(Number((await fourth.json()).retryAfter)>1700);
});

