'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/calc');
const d = (n) => new Date(Date.UTC(2026,8,n)).toISOString().slice(0,10);
const laporte = [41756714,41970614,42474436,43279281,44080759,44999019].map((v,i)=>({date:d(20+i),marketValue:v}));
test('Laporte: uses daily momentum and acceleration, not bids from managers',()=>{
  const b=C.bidEstimate(laporte,44999019,'2026-09-25T06:00:00Z');
  assert.equal(C.dailyValues(laporte).at(-1).change,918260);
  assert.deepEqual(b.levels,{conservative:47100000,risky:50500000,optimistic:53900000});
  assert.equal(b.max,53900000); assert.ok(b.max>44999019);
  assert.equal(b.forecast,49553578); assert.ok(b.floorProfit<0); assert.ok(b.forecast-b.max<0); assert.ok(b.upsideProfit>0);
  assert.equal(b.latest,'2026-09-25');
});
test('frenada vs aceleración affects the cap; falling player still has lower cap than rising one',()=>{
  const base=50e6;
  const accelerate=[0,100000,300000,600000,1000000,1500000].map((v,i)=>({date:d(20+i),marketValue:base+v}));
  const slow=[0,500000,900000,1200000,1400000,1500000].map((v,i)=>({date:d(20+i),marketValue:base+v}));
  assert.ok(C.bidEstimate(accelerate,base+1500000,'2026-09-25T06:00:00Z').max>C.bidEstimate(slow,base+1500000,'2026-09-25T06:00:00Z').max);
  const fall=[0,-200000,-500000,-900000,-1400000,-2000000].map((v,i)=>({date:d(20+i),marketValue:base+v}));
  assert.ok(C.bidEstimate(fall,base-2000000,'2026-09-25T06:00:00Z').max<C.bidEstimate(slow,base+1500000,'2026-09-25T06:00:00Z').max);
});
test('stale, missing days or inconsistent current value do not manufacture a bid',()=>{
  assert.equal(C.bidEstimate(laporte,44999019,'2026-10-01T06:00:00Z'),null);
  assert.equal(C.bidEstimate(laporte,46000000,'2026-09-25T06:00:00Z'),null);
  assert.equal(C.bidEstimate(laporte.filter(x=>x.date!==d(22)),44999019,'2026-09-25T06:00:00Z'),null);
  assert.equal(C.dailyValues(laporte.filter(x=>x.date!==d(22))).find(x=>x.date===d(23)).change,null);
});

test('falling value can place every theoretical bid below the legal floor',()=>{
  const value=48000000;
  const fall=[0,-200000,-500000,-900000,-1400000,-2000000].map((v,i)=>({date:d(20+i),marketValue:50000000+v}));
  const b=C.bidEstimate(fall,value,'2026-09-25T06:00:00Z');
  assert.ok(b);
  assert.ok(b.levels.conservative<value && b.levels.risky<value && b.levels.optimistic>=value);
  // Estimates retain the theoretical ceiling. UI must not present these as valid bids.
});

