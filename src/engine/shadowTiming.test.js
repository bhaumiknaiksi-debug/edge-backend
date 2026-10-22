'use strict';
const assert = require('node:assert/strict');
const { buildTimingSource, createShadowTiming, buildReadinessView } = require('./shadowTiming');
const t = s => Date.parse('2026-10-22T' + s + '+05:30');
const row = (time, close=100, high=110, low=90) => ['2026-10-22T'+time+'+05:30',100,high,low,close,1000];
const opening = [row('09:15:00'),row('09:20:00'),row('09:25:00')];
assert.equal(buildTimingSource(opening,t('09:29:59')).available,false);
assert.equal(buildTimingSource(opening.slice(1),t('09:30:00')).available,false);
assert.equal(buildTimingSource([...opening,opening[0]],t('09:30:00')).available,false);
assert.equal(buildTimingSource(opening,t('09:30:00')).high,110);
assert.equal(buildTimingSource(opening,t('09:30:00')+86400000).available,false);
assert.equal(buildTimingSource([...opening,row('09:30:00',120,125)],t('09:32:00')).latest.close,100);
assert.equal(buildTimingSource([row('09:15:00',null),...opening.slice(1)],t('09:30:00')).available,false);
const source = (rows, time) => buildTimingSource(rows,t(time));
const candidate = strategy => ({ available:true, strategy, legs:{
  buyLeg:{ instrumentKey:'buy', bid:100, ask:101, premium:100 },
  ...(strategy.endsWith('SPREAD') ? {sellLeg:{ instrumentKey:'sell', bid:50, ask:51, premium:50 },netDebit:50} : {}) } });
const input = {spot:100,support:50,resistance:150,marketPhase:'OPEN',dte:5,
  features:{trend30mPct:1,sessionChangePct:1},regime:{direction:'BULLISH'}};
for (const strategy of ['LONG_CALL','BULL_CALL_SPREAD','LONG_PUT','BEAR_PUT_SPREAD']) {
  const bullish = strategy.includes('CALL');
  const evaluate = createShadowTiming();
  const candidates = {plans:{A:candidate(strategy),B:candidate(strategy),C:candidate(strategy)}};
  const snapshot=JSON.stringify(candidates);
  const args = {enabled:true,candidates,input:{...input,features:{trend30mPct:bullish?1:-1,sessionChangePct:bullish?1:-1}}};
  let x=evaluate({...args,now:t('09:30:00'),source:source(opening,'09:30:00')});
  assert.equal(x.plans.C.status,'UNKNOWN');
  const id=x.plans.C.episodeId;
  const crossed=[...opening,row('09:30:00',bullish?115:85,120,80)];
  x=evaluate({...args,now:t('09:35:00'),source:source(crossed,'09:35:00')});
  assert.equal(x.plans.C.shadowEntryReady,true);
  assert.equal(x.plans.C.baselineTriggerReady,false);
  assert.equal(x.plans.C.executionAllowed,false);
  assert.equal(x.plans.C.episodeId,id);
  assert.equal(x.plans.C.anchor.high,110);
  assert.equal(JSON.stringify(candidates),snapshot);
  const repeat=evaluate({...args,now:t('09:35:01'),source:source(crossed,'09:35:01')});
  assert.equal(repeat.plans.C.episodeId,id);
  x=evaluate({...args,now:t('09:40:00'),source:source([...crossed,row('09:35:00')],'09:40:00')});
  assert.equal(x.plans.C.status,'INVALIDATED');
  x=evaluate({...args,now:t('09:45:00'),source:source([...crossed,row('09:35:00'),row('09:40:00',bullish?115:85,120,80)],'09:45:00')});
  assert.equal(x.plans.C.shadowEntryReady,false);
  const restarted=createShadowTiming()({...args,now:t('09:35:00'),source:source(crossed,'09:35:00')});
  assert.equal(restarted.plans.C.status,'UNKNOWN');
  assert.notEqual(restarted.plans.C.episodeId,id);
  assert.equal(evaluate({...args,enabled:false}),null);
}
const candidates={plans:{C:candidate('LONG_CALL')}};
const args={enabled:true,candidates,input};
const evaluate=createShadowTiming();
evaluate({...args,now:t('09:30:00'),source:source(opening,'09:30:00')});
const gap=[...opening,row('09:35:00',115,120)];
let x=evaluate({...args,now:t('09:40:00'),source:source(gap,'09:40:00')});
assert.equal(x.plans.C.reason,'OBSERVATION_GAP');
assert.equal(x.plans.C.shadowEntryReady,false);
x=evaluate({...args,now:t('10:00:00'),source:source([...gap,row('09:55:00')],'10:00:00')});
assert.equal(x.plans.C.status,'EXPIRED');
x=evaluate({...args,now:t('10:20:00'),source:source(opening,'09:30:00')});
assert.equal(x.plans.C.reason,'MISSING_OR_STALE_CANDLES');
assert.equal(evaluate({...args,now:t('09:30:00'),source:source(opening,'09:30:00'),input:{...input,marketPhase:'CLOSED'}}).plans.C.reason,'MARKET_CLOSED');
const r=buildReadinessView({setup:{qualified:true},entry:{triggerReady:true,priceReady:true,liquidityReady:true},
  regime:{direction:'STRONG_BULLISH'},strategy:'LONG_CALL',marketPhase:'OPEN',chartAgreement:'AGREES',risk:{status:'BLOCKED'},position:{status:'BLOCKED',reason:'Reconcile journal'}});
assert.equal(r.market.status,'CONFIRMED');assert.equal(r.eligibility.eligible,false);assert.equal(r.executionAllowed,false);
console.log('shadowTiming: completed anchors, four strategies, crossing, invalidation, expiry, gaps, restart, identity, immutability and eligibility PASS');
function fresh() {
  const ev=createShadowTiming();
  ev({...args,now:t('09:30:00'),source:source(opening,'09:30:00')});
  return ev;
}
const crossing=[...opening,row('09:30:00',115,120)];
const crossingArgs={...args,now:t('09:35:00'),source:source(crossing,'09:35:00')};
assert.equal(fresh()({...crossingArgs,input:{...input,features:{trend30mPct:0,sessionChangePct:0}}}).plans.C.shadowEntryReady,false);
const illiquid=structuredClone(candidates);illiquid.plans.C.legs.buyLeg.ask=150;
assert.equal(fresh()({...crossingArgs,candidates:illiquid}).plans.C.shadowEntryReady,false);
const changed=structuredClone(candidates);changed.plans.C.legs.buyLeg.instrumentKey='new';
assert.equal(fresh()({...crossingArgs,candidates:changed}).plans.C.status,'UNKNOWN');
const revised=structuredClone(crossingArgs.source);revised.high=111;
assert.equal(fresh()({...crossingArgs,source:revised}).plans.C.reason,'ANCHOR_SOURCE_REVISED');
assert.equal(fresh()({...crossingArgs,source:source([...opening,row('09:30:00',110)],'09:35:00')}).plans.C.shadowTriggerReady,false);
const ordered=fresh();ordered(crossingArgs);
assert.equal(ordered({...args,now:t('09:36:00'),source:source(opening,'09:30:00')}).plans.C.reason,'OUT_OF_ORDER_CANDLES');
assert.equal(ordered({...crossingArgs,now:t('09:36:00')}).plans.C.shadowEntryReady,true);
console.log('Additional guards: momentum, liquidity, contract changes, revised anchors, equality and ordering PASS');
