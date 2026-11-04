'use strict';
// V3 opening-range path in the paper executor: one entry per market breakout (across strike rolls and tiers),
// regime alignment / freshness / chase re-checked at selection, and the V2 path left unchanged.
const assert=require('node:assert/strict');
const E=require('./sandboxEngine');
const {selectCandidate}=require('./candidateSelection');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
const K1='NSE_FO|777',K2='NSE_FO|888';
function analysis({key=K1,strike=23000,tier='C',spot=23010,breakoutId='2026-10-28:UP:2026-10-28T04:25:00.000Z',version='OPENING_RANGE_SHADOW_V3',
  aligned=true,fresh=true,ready=true,chase=50,direction='BULLISH',at=BASE,windowEnds='2026-10-28T04:40:00.000Z'}={}){
  const leg={instrumentKey:key,contractId:'NIFTY 03 NOV '+strike+' CE',strike,type:'CE',delta:0.5};
  return {timestamp:new Date(at).toISOString(),expiry:'2026-11-03',spot,market:{phase:'OPEN'},decision:{strategy:'WAIT',regime:{direction},
    researchCandidatePlans:{plans:{[tier]:{available:true,strategy:'LONG_CALL',legs:{buyLeg:leg,legDelta:0.5}}}},
    shadowTiming:{version,plans:{[tier]:{status:'CONFIRMED',shadowEntryReady:ready,strategy:'LONG_CALL',contracts:[key],
      episodeId:breakoutId,breakoutId,regimeAligned:aligned,entryFresh:fresh,chaseLimitPoints:chase,crossedAt:'2026-10-28T04:30:00.000Z',
      entryWindowEndsAt:windowEnds,
      anchor:{source:'NIFTY_INDEX_5M_OPENING_RANGE',high:23000,low:22900}}}}}};
}
const meta=(key=K1,strike=23000)=>({instrumentKey:key,underlying:'NIFTY',optionType:'CE',strike,expiry:'2026-11-03',session:'2026-10-28',lotSize:65,tickSizeRupees:0.05});
const quote=(key=K1,at=BASE)=>({instrumentKey:key,bid:99.95,ask:100,receivedAt:at});
function armed(){
  const s=E.initialState();
  E.configurePolicy(s,{requestId:'policy-setup-000001',dailyGoal:1000,dailyLoss:500,entryMode:'OPENING_RANGE_SHADOW_V1',perTradeRisk:500},BASE);
  E.recover(s,'boot');E.reconcile(s,[],[],BASE);E.control(s,'ARM','arm-request-000001',BASE);return s;
}
function closeAll(s,at){for(const t of Object.values(s.trades))if(!t.closedAt){t.closedAt=at;t.buys=65;t.netPnl=50;}for(const o of Object.values(s.orders))o.state='COMPLETE';s.reconciledAt=at;}

// --- a V3 entry records its breakout id and rule version; exits are the unchanged anchor model ---
{
  const s=armed();
  assert.equal(E.planEntry(s,analysis(),quote(),meta(),BASE),'QUEUED');
  const t=Object.values(s.trades)[0];
  assert.equal(t.ruleVersion,'OPENING_RANGE_SHADOW_V3');assert.equal(t.breakoutId,'2026-10-28:UP:2026-10-28T04:25:00.000Z');
  assert.equal(t.stop,95);assert.equal(t.target,107.5,'stop/target identical to V2 for the same inputs');
  // --- after that trade closes, the ATM roll to a new strike must NOT re-enter the same breakout ---
  closeAll(s,BASE+60000);
  const later=BASE+65000;
  assert.equal(E.planEntry(s,analysis({key:K2,strike:23050,at:later}),quote(K2,later),meta(K2,23050),later),'BREAKOUT_ALREADY_CONSUMED');
  // --- nor through another tier ---
  const K3='NSE_FO|999';
  assert.equal(E.planEntry(s,analysis({tier:'A',key:K3,strike:22950,at:later}),quote(K3,later),meta(K3,22950),later),'BREAKOUT_ALREADY_CONSUMED');
  // --- a different (later) breakout is a new opportunity ---
  assert.equal(E.planEntry(s,analysis({key:K2,strike:23050,at:later,breakoutId:'2026-10-28:UP:2026-10-28T05:25:00.000Z'}),quote(K2,later),meta(K2,23050),later),'QUEUED');
}
// --- selection re-checks the V3 conditions instead of trusting a single flag ---
for(const [label,args,expected] of [
  ['not aligned',{aligned:false},'BREAKOUT_NOT_ENTRY_READY'],
  ['stale breakout',{fresh:false},'BREAKOUT_NOT_ENTRY_READY'],
  ['no breakout id',{breakoutId:''},'BREAKOUT_NOT_ENTRY_READY'],
  ['chased',{spot:23060,chase:50},'CHASE_LIMIT'],
  ['not ready',{ready:false},'NO_CONFIRMED_SHADOW_CANDIDATE'],
  ['opposing regime',{direction:'BEARISH'},'REGIME_OPPOSES_CANDIDATE'],
  ['no entry deadline',{windowEnds:null},'ENTRY_DEADLINE_UNVERIFIED'],
]) assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},analysis(args),BASE).reason,expected,label);
assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},analysis()).reason,'ENTRY_DEADLINE_UNVERIFIED','V3 needs the caller clock');

// --- entry-window boundary: analysis computed at 9m59s says fresh; the entry attempt at 10m40s is refused ---
{
  const cross=BASE,at=cross+599000,attempt=cross+640000,ends=new Date(cross+600000).toISOString();
  const r=analysis({at,windowEnds:ends});
  assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},r,at).reason,undefined,'eligible when the analysis was made');
  const s=armed();s.reconciledAt=attempt;
  assert.equal(E.planEntry(s,r,quote(K1,attempt),meta(),attempt),'ENTRY_WINDOW_ELAPSED','41 s-old analysis cannot extend the window');
  assert.equal(Object.keys(s.orders).length,0);
  // queued just inside the window: the order expires at the deadline and is never submitted after it
  const q=armed();q.reconciledAt=at;
  assert.equal(E.planEntry(q,r,quote(K1,at),meta(),at),'QUEUED');
  const t=Object.values(q.trades)[0];assert.equal(t.entryExpiresAt,cross+600000,'entry order expiry capped at the breakout deadline');
  q.reconciledAt=attempt;
  assert.equal(E.claim(q,attempt),null,'nothing is submitted at 10m40s');
  assert.equal(Object.values(q.orders)[0].state,'EXPIRED');
  const ok=armed();ok.reconciledAt=at;E.planEntry(ok,r,quote(K1,at),meta(),at);
  assert.equal(E.claim(ok,at+500).action,'PLACE','inside the window the same order is submitted');
}

// --- missing-candle freshness, end to end through the real V3 timing rule ---
{
  const {buildTimingSource}=require('../engine/shadowTiming');
  const {createShadowTimingV3}=require('../engine/shadowTimingV3');
  const DAY='2026-10-28',T=s=>Date.parse(DAY+'T'+s+'+05:30'),FIVE=300000;
  const bar=(time,close)=>[new Date(time).toISOString(),close,close+2,close-2,close,1000];
  const opening=[bar(T('09:15:00'),23000),[new Date(T('09:20:00')).toISOString(),22950,23000,22900,22950,1000],bar(T('09:25:00'),22950)];
  const closes=[22960,22980,23010,23012,23015,23014]; // crossing on the 09:40 bar (closes 09:45)
  const rows=n=>[...opening,...closes.slice(0,n).map((c,i)=>bar(T('09:30:00')+i*FIVE,c))];
  const evaluate=createShadowTimingV3();
  const leg={instrumentKey:K1,contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE',delta:0.5,bid:99.95,ask:100,premium:100};
  const plans={C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:leg,legDelta:0.5}}};
  const at=(now,raw,spot=23014)=>{
    const timing=evaluate({enabled:true,now,source:buildTimingSource(raw,now),candidates:{plans},
      input:{spot,support:22800,resistance:23200,marketPhase:'OPEN',dte:5,regime:{direction:'BULLISH'},
        features:{trend30mPct:0.3,sessionChangePct:0.5,optionFlow:{aggregate:{label:'MIXED_FLOW'}}}}});
    return {timing,result:{timestamp:new Date(now).toISOString(),expiry:'2026-11-03',spot,market:{phase:'OPEN'},
      decision:{strategy:'WAIT',regime:{direction:'BULLISH'},researchCandidatePlans:{plans},shadowTiming:timing}}};
  };
  const m={...meta(),session:DAY};
  // production polls every 30 s; a candle is judged only after two matching reads a minute apart
  const poll=(from,to,raw)=>{let r;for(let n=from;n<=to;n+=30000)r=at(n,raw);return r;};
  let now=T('09:47:05'),x=poll(T('09:30:05'),now,rows(3));
  assert.equal(x.timing.plans.C.status,'CONFIRMED');assert.equal(x.timing.plans.C.shadowEntryReady,true,'confirmed with full coverage');
  // 09:52:05: the 09:45 candle should have been confirmed but the (otherwise valid) response stops at 09:40
  now=T('09:52:05');x=poll(T('09:47:35'),now,rows(3));
  assert.equal(x.timing.plans.C.status,'CONFIRMED','the breakout itself is kept');
  assert.equal(x.timing.plans.C.dataStatus,'INCOMPLETE_CANDLES');assert.equal(x.timing.plans.C.shadowEntryReady,false);
  let s=armed();s.reconciledAt=now;
  assert.equal(E.planEntry(s,x.result,quote(K1,now),m,now),'NO_CONFIRMED_SHADOW_CANDIDATE','new entries fail closed');
  // a hole in the middle of the response also fails closed, even when the newest candle is present
  const holed=rows(4).filter((r,i)=>i!==4);
  now=T('09:52:20');x=at(now,holed);
  assert.equal(x.timing.plans.C.dataStatus,'INCOMPLETE_CANDLES');
  // coverage restored: the late candle still needs its own confirmation before entries resume
  now=T('09:52:40');x=at(now,rows(4),23008);
  assert.equal(x.timing.plans.C.dataStatus,'CANDLE_UNCONFIRMED');assert.equal(x.timing.plans.C.shadowEntryReady,false);
  now=T('09:53:40');x=at(now,rows(4),23008);
  assert.equal(x.timing.plans.C.dataStatus,'OK');assert.equal(x.timing.plans.C.shadowEntryReady,true);
  s=armed();s.reconciledAt=now;
  assert.equal(E.planEntry(s,x.result,quote(K1,now),m,now),'QUEUED','entry once continuous coverage is back');
}
// --- V2 output (flag off) is selected exactly as before: no breakout id, V2 rule version, contract identity dedupe ---
{
  const s=armed(),r=analysis({version:'OPENING_RANGE_SHADOW_V2'});
  assert.equal(E.planEntry(s,r,quote(),meta(),BASE),'QUEUED');
  const t=Object.values(s.trades)[0];
  assert.equal(t.ruleVersion,'OPENING_RANGE_SHADOW_V2');assert.equal(t.breakoutId,undefined);
  closeAll(s,BASE+60000);const later=BASE+65000;
  assert.equal(E.planEntry(s,analysis({version:'OPENING_RANGE_SHADOW_V2',key:K2,strike:23050,at:later}),quote(K2,later),meta(K2,23050),later),'QUEUED',
    'V2 behaviour unchanged (documented: a strike roll can re-enter the same V2 episode)');
}
// --- feature-off path: only both flags exactly 'true' select V3; V2 selection ignores the clock argument ---
{
  const {v3Enabled}=require('../engine/shadowTimingV3');
  for(const env of [{},{EDGE_SHADOW_TIMING_ENABLED:'true'},{EDGE_SHADOW_TIMING_ENABLED:'true',EDGE_SHADOW_TIMING_V3_ENABLED:'false'},
    {EDGE_SHADOW_TIMING_ENABLED:'true',EDGE_SHADOW_TIMING_V3_ENABLED:'TRUE'},{EDGE_SHADOW_TIMING_ENABLED:'true',EDGE_SHADOW_TIMING_V3_ENABLED:'1'},
    {EDGE_SHADOW_TIMING_V3_ENABLED:'true'}])assert.equal(v3Enabled(env),false,JSON.stringify(env));
  assert.equal(v3Enabled({EDGE_SHADOW_TIMING_ENABLED:'true',EDGE_SHADOW_TIMING_V3_ENABLED:'true'}),true);
  const r=analysis({version:'OPENING_RANGE_SHADOW_V2'}),policy={entryMode:'OPENING_RANGE_SHADOW_V1'};
  const a=selectCandidate(policy,r),b=selectCandidate(policy,r,BASE+86400000);
  assert.equal(a.ruleVersion,'OPENING_RANGE_SHADOW_V2');assert.equal(a.breakoutId,undefined);assert.equal(a.entryDeadline,undefined);
  assert.deepEqual({...a,exitPlan:null},{...b,exitPlan:null},'V2 pick is identical with or without a clock');
}
// --- authoritative mode never reads V3 timing ---
assert.equal(selectCandidate({entryMode:'AUTHORITATIVE_A_ONLY'},analysis()).reason,'BACKEND_NOT_READY');
console.log('Sandbox shadow V3 PASS: breakout id recorded, one entry per breakout across strike rolls and tiers, V3 gates re-checked, entry deadline enforced at planning and submission, missing candles fail closed, V2 path unchanged');
