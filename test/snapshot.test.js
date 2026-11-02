const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../src/snapshot.js');

test('catalog carries last 5 jornadas (null when the player did not score that week)', () => {
  const players = [
    { id: 1, nickname: 'A', teamId: 9, positionId: 4, marketValue: 1000, weekPoints: [7, 1, 2, 3, 4, 5, 6].map(w => ({ weekNumber: w, points: w * 2 })) },
    { id: 2, nickname: 'B', teamId: 9, positionId: 1, marketValue: 500, weekPoints: [{ weekNumber: 5, points: -1 }] }
  ];
  const raw = { fetchedAt: '2026-09-24T06:00:00Z', league: { id: 'L', name: 'L' }, standing: [], squads: [], activity: [], players, teams: [], types: [] };
  const snap = build(raw, {});
  assert.deepStrictEqual(snap.weeks, [3, 4, 5, 6, 7]);
  assert.deepStrictEqual(snap.players.find(p => p.id === '1').last5, [6, 8, 10, 12, 14]);
  assert.deepStrictEqual(snap.players.find(p => p.id === '2').last5, [null, null, -1, null, null]);
});

test('fixtures get team names and are sorted by date', () => {
  const { buildFixtures } = require('../src/snapshot.js');
  const f = buildFixtures({ week: 8, matches: [
    { id: 2, matchDate: '2026-10-11T16:15:00+02:00', localId: 16, visitorId: 26, matchState: 1 },
    { id: 1, matchDate: '2026-10-10T21:00:00+02:00', localId: 3, visitorId: 9, matchState: 1 }
  ] }, { 3: { name: 'Athletic Club', short: 'ATH', badge: 'b3' } });
  assert.strictEqual(f.week, 8);
  assert.deepStrictEqual(f.matches.map(m => m.id), ['1', '2']);
  assert.strictEqual(f.matches[0].home.name, 'Athletic Club');
  assert.strictEqual(f.matches[1].home.name, 'Equipo 16');
  assert.strictEqual(buildFixtures(null, {}), null);
});

test('next 5 matches per team with home/away, skipping played ones', () => {
  const { buildFixtures } = require('../src/snapshot.js');
  const upcoming = [];
  for (let w = 8; w <= 13; w++) upcoming.push({ week: w, matches: [
    { id: w, matchDate: `2026-10-${10 + w}T18:00:00+02:00`, localId: w % 2 ? 3 : 9, visitorId: w % 2 ? 9 : 3, matchState: w === 8 ? 7 : 1 }
  ] });
  const f = buildFixtures({ week: 8, matches: upcoming[0].matches, upcoming }, { 3: { name: 'Athletic', short: 'ATH' }, 9: { name: 'Barça', short: 'BAR' } });
  assert.strictEqual(f.next['3'].length, 5);
  assert.deepStrictEqual(f.next['3'].map(x => x.week), [9, 10, 11, 12, 13]);
  assert.deepStrictEqual(f.next['3'].map(x => x.home), [true, false, true, false, true]);
  assert.strictEqual(f.next['9'][0].oppShort, 'ATH');
});


test('market displays only active official listings and keeps missing market distinct from empty', () => {
  const raw = { fetchedAt: '2026-09-25T08:00:00Z', league: { id:'L', name:'Liga' }, standing:[], squads:[], activity:[], teams:[], types:[],
    players:[{ id:1,nickname:'Uno',marketValue:1000000 },{ id:2,nickname:'Dos',marketValue:2000000 }],
    bids:{'1':{conservative:900000,risky:1000000,optimistic:1100000}},
    market:{elements:[
      {id:'m1',discr:'marketPlayerLeague',playerMaster:{id:1},salePrice:950000,expirationDate:'2026-09-26T08:00:00Z',numberOfBids:3},
      {id:'old',discr:'marketPlayerLeague',playerMaster:{id:2},salePrice:2000000,expirationDate:'2026-09-24T08:00:00Z'},
      {id:'ad',discr:'advertisement',playerMaster:{id:2},salePrice:0,expirationDate:'2026-09-26T08:00:00Z'}]}};
  const snap=build(raw,{});
  assert.deepStrictEqual(snap.market,[{id:'m1',playerId:'1',salePrice:950000,expires:'2026-09-26T08:00:00Z',bids:3}]);
  assert.strictEqual(snap.players.find(p=>p.id==='1').bid.optimistic,1100000);
  assert.strictEqual(snap.players.find(p=>p.id==='2').bid,null);
  assert.deepStrictEqual(build({...raw,market:[]},{}).market,[]);
  const failed=build({...raw,market:undefined,marketError:'API 503'},{});
  assert.strictEqual(failed.market,null);
  assert.strictEqual(failed.marketError,'API 503');
});

