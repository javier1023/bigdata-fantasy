'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/calc');
const days = values => values.map((v, i) => ({ date: `2026-09-${String(20+i).padStart(2,'0')}`, marketValue:v }));
const up = days([10e6,10.1e6,10.3e6,10.6e6,11e6,12e6]);
const down = days([10e6,9.8e6,9.6e6,9.4e6,9.2e6,9e6]);
const a={id:'a',value:12e6,points:80}, b={id:'b',value:9e6,points:42};
test('independent purchases: stronger seller gets only the premium, never raw value difference',()=>{
  const x=C.exchangeEstimate(a,b,up,down,'2026-09-25T08:00:00Z');
  assert.equal(x.stronger,'a'); assert.ok(x.premium>0 && x.premium<=1.2e6);
  assert.equal(x.priceA,12e6+x.premium); assert.equal(x.priceB,9e6);
  const reverse=C.exchangeEstimate(b,a,down,up,'2026-09-25T08:00:00Z');
  assert.equal(reverse.stronger,'b'); assert.equal(reverse.premium,x.premium);
  assert.equal(reverse.priceA,9e6); assert.equal(reverse.priceB,12e6+x.premium);
});
test('equal signals mean both pay market value',()=>{
  const same={id:'c',value:12e6,points:80};
  const x=C.exchangeEstimate(a,same,up,up,'2026-09-25T08:00:00Z');
  assert.equal(x.premium,0); assert.equal(x.priceA,12e6); assert.equal(x.priceB,12e6);
});
test('missing or stale daily data cannot fabricate an exchange premium',()=>{
  assert.equal(C.exchangeEstimate(a,b,up,[], '2026-09-25T08:00:00Z'),null);
  assert.equal(C.exchangeEstimate(a,b,up,down, '2026-10-02T08:00:00Z'),null);
  assert.equal(C.exchangeEstimate(a,{...a},up,up,'2026-09-25T08:00:00Z'),null);
});

test('absolute level beats cheap-player efficiency in the reported Mbappé contrast',()=>{
  const star={id:'mbappe',value:155.4e6,points:40}, cheap={id:'angel',value:28.3e6,points:53};
  const hd=(v,delta)=>days(Array.from({length:6},(_,i)=>v-(5-i)*delta));
  const x=C.exchangeEstimate(star,cheap,hd(star.value,1.63e6),hd(cheap.value,.75e6),'2026-09-25T08:00:00Z');
  assert.equal(x.stronger,'a'); assert.ok(x.premium>0 && x.premium<=star.value*.10);
  assert.equal(x.priceA,star.value+x.premium); assert.equal(x.priceB,cheap.value);
  const rev=C.exchangeEstimate(cheap,star,hd(cheap.value,.75e6),hd(star.value,1.63e6),'2026-09-25T08:00:00Z');
  assert.equal(rev.stronger,'b'); assert.equal(rev.premium,x.premium);
});
test('equal players stay at their values and similar cheap players get no invented premium',()=>{
  const hd=(v,delta)=>days(Array.from({length:6},(_,i)=>v-(5-i)*delta));
  const equalA={id:'one',value:7e6,points:42}, equalB={id:'two',value:7e6,points:42};
  const same=C.exchangeEstimate(equalA,equalB,hd(7e6,.1e6),hd(7e6,.1e6),'2026-09-25T08:00:00Z');
  assert.equal(same.premium,0); assert.equal(same.priceA,7e6); assert.equal(same.priceB,7e6);
  const cheapA={id:'three',value:4e6,points:40},cheapB={id:'four',value:3.8e6,points:43};
  const close=C.exchangeEstimate(cheapA,cheapB,hd(4e6,.2e6),hd(3.8e6,.12e6),'2026-09-25T08:00:00Z');
  assert.equal(close.premium,0); assert.equal(close.priceA,4e6); assert.equal(close.priceB,3.8e6);
});
test('absolute strength still permits a small-player premium when the gap is large enough',()=>{
  const hd=(v,d)=>days(Array.from({length:6},(_,i)=>v-(5-i)*d));
  const a={id:'lowA',value:8e6,points:60},b={id:'lowB',value:2e6,points:20};
  const x=C.exchangeEstimate(a,b,hd(a.value,.2e6),hd(b.value,-.02e6),'2026-09-25T08:00:00Z');
  assert.equal(x.stronger,'a'); assert.ok(x.premium>=1e5); assert.equal(x.priceB,b.value);
});

test('forecast growth can beat historical points and an expensive flat player',()=>{
  const hd=(v,d)=>days(Array.from({length:6},(_,i)=>v-(5-i)*d));
  const star={id:'flat',value:155.4e6,points:150},riser={id:'rising',value:28.3e6,points:15};
  const x=C.exchangeEstimate(star,riser,hd(star.value,0),hd(riser.value,1.2e6),'2026-09-25T08:00:00Z');
  assert.equal(x.stronger,'b'); assert.ok(x.premium>0); assert.equal(x.priceA,star.value); assert.equal(x.priceB,riser.value+x.premium);
});

