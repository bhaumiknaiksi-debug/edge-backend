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
  assert.equal(x.plans.C.shadowEntryReady,true,'V2: a fresh re-break after a failed breakout confirms again');
  assert.notEqual(x.plans.C.episodeId,id,'as a new episode');
  assert.equal(x.plans.C.reason,'COMPLETED_CANDLE_CROSSING');
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
const rolled=fresh()({...crossingArgs,candidates:changed}).plans.C;
assert.equal(rolled.status,'CONFIRMED','V2: a strike roll on the crossing candle keeps the crossing');assert.deepEqual(rolled.contracts,['new'],'and reports the current contract');
const revised=structuredClone(crossingArgs.source);revised.high=111;
assert.equal(fresh()({...crossingArgs,source:revised}).plans.C.reason,'ANCHOR_SOURCE_REVISED');
assert.equal(fresh()({...crossingArgs,source:source([...opening,row('09:30:00',110)],'09:35:00')}).plans.C.shadowTriggerReady,false);
const ordered=fresh();ordered(crossingArgs);
assert.equal(ordered({...args,now:t('09:36:00'),source:source(opening,'09:30:00')}).plans.C.reason,'OUT_OF_ORDER_CANDLES');
assert.equal(ordered({...crossingArgs,now:t('09:36:00')}).plans.C.shadowEntryReady,true);
console.log('Additional guards: momentum, liquidity, contract changes, revised anchors, equality and ordering PASS');
// --- V2: the breakout survives strike rolls and restarts cleanly ---
{
  const plan = key => ({plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{instrumentKey:key,bid:100,ask:101,premium:100}}}}});
  const go = (ev, time, rows, key) => ev({enabled:true,candidates:plan(key),input,now:t(time),source:source(rows,time)}).plans.C;
  // Trend day: crossing at the 09:30 candle, then the ATM strike rolls on every candle while price keeps climbing.
  const ev = createShadowTiming();
  go(ev,'09:30:00',opening,'k1');
  let rows=[...opening,row('09:30:00',115,120)];
  const first=go(ev,'09:35:00',rows,'k1');
  assert.equal(first.status,'CONFIRMED');
  for (const [i,time] of ['09:35:00','09:40:00','09:45:00'].entries()) {
    rows=[...rows,row(time,120+i*5,130+i*5)];
    const next=go(ev,new Date(t(time)+FIVE_MS()+19800000).toISOString().slice(11,19),rows,'k'+(i+2));
    assert.equal(next.status,'CONFIRMED','strike roll '+(i+1)+' keeps the confirmed breakout');
    assert.equal(next.episodeId,first.episodeId);assert.deepEqual(next.contracts,['k'+(i+2)]);
  }
  // Thirty minutes after the episode began it expires; price is still beyond, so the restart waits for a new crossing.
  rows=[...rows,row('09:50:00',140,145)];assert.equal(go(ev,'09:55:00',rows,'k9').status,'CONFIRMED');
  rows=[...rows,row('09:55:00',141,146)];
  let late=go(ev,'10:00:00',rows,'k9');assert.equal(late.status,'EXPIRED');
  rows=[...rows,row('10:00:00',142,147)];
  late=go(ev,'10:05:00',rows,'k9');
  assert.equal(late.status,'WAITING');assert.equal(late.reason,'ALREADY_BEYOND_ANCHOR_NO_NEW_CROSSING','no repeat signal without a fresh crossing');
  assert.notEqual(late.episodeId,first.episodeId);
  // Pull back inside the range, then break out again: a new confirmed episode.
  rows=[...rows,row('10:05:00',105,108)];assert.equal(go(ev,'10:10:00',rows,'k9').status,'WAITING');
  rows=[...rows,row('10:10:00',112,114)];
  const rebreak=go(ev,'10:15:00',rows,'k9');assert.equal(rebreak.status,'CONFIRMED');assert.equal(rebreak.shadowEntryReady,true);
}
{
  // Expired while inside the range: the very next candle that crosses still confirms (the last close carries over).
  const plan={plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{instrumentKey:'k',bid:100,ask:101,premium:100}}}}};
  const ev=createShadowTiming(),go=(time,rows)=>ev({enabled:true,candidates:plan,input,now:t(time),source:source(rows,time)}).plans.C;
  let rows=[...opening];go('09:30:00',rows);
  for (const time of ['09:30:00','09:35:00','09:40:00','09:45:00','09:50:00']){rows=[...rows,row(time,100)];go(new Date(t(time)+FIVE_MS()+19800000).toISOString().slice(11,19),rows);}
  rows=[...rows,row('09:55:00',100)];assert.equal(go('10:00:00',rows).status,'EXPIRED');
  rows=[...rows,row('10:00:00',115,120)];
  const crossed=go('10:05:00',rows);assert.equal(crossed.status,'CONFIRMED','crossing on the first candle after expiry counts');
  assert.ok(crossed.reason==='COMPLETED_CANDLE_CROSSING');
}
{
  // A revised opening range restarts on the next candle without carrying the old close, and is not invalidated again.
  const plan={plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{instrumentKey:'k',bid:100,ask:101,premium:100}}}}};
  const ev=createShadowTiming(),go=(time,src)=>ev({enabled:true,candidates:plan,input,now:t(time),source:src}).plans.C;
  go('09:30:00',source(opening,'09:30:00'));
  const crossing=source([...opening,row('09:30:00',115,120)],'09:35:00');go('09:35:00',crossing);
  const revised={...source([...opening,row('09:30:00',115,120),row('09:35:00',116,121)],'09:40:00'),high:118};
  assert.equal(go('09:40:00',revised).reason,'ANCHOR_SOURCE_REVISED');
  const after={...source([...opening,row('09:30:00',115,120),row('09:35:00',116,121),row('09:40:00',117,121)],'09:45:00'),high:118};
  const restarted=go('09:45:00',after);
  assert.equal(restarted.status,'UNKNOWN');assert.equal(restarted.reason,'NEW_EPISODE_WAIT_FOR_NEXT_CANDLE');assert.equal(restarted.anchor.high,118);
}
{
  // A direction flip starts a separate episode.
  const ev=createShadowTiming();
  const call={plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{instrumentKey:'c',bid:100,ask:101,premium:100}}}}};
  const put={plans:{C:{available:true,strategy:'LONG_PUT',legs:{buyLeg:{instrumentKey:'p',bid:100,ask:101,premium:100}}}}};
  const a=ev({enabled:true,candidates:call,input,now:t('09:30:00'),source:source(opening,'09:30:00')}).plans.C;
  const b=ev({enabled:true,candidates:put,input,now:t('09:30:01'),source:source(opening,'09:30:01')}).plans.C;
  assert.notEqual(a.episodeId,b.episodeId);
}
function FIVE_MS(){return 300000;}
console.log('shadowTiming V2: breakout survives strike rolls, expiry restart needs a fresh crossing, carry-over after expiry, revised anchors restart cleanly, direction flips PASS');
