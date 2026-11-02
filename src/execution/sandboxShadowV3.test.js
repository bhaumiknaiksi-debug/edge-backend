'use strict';
// V3 opening-range path in the paper executor: one entry per market breakout (across strike rolls and tiers),
// regime alignment / freshness / chase re-checked at selection, and the V2 path left unchanged.
const assert=require('node:assert/strict');
const E=require('./sandboxEngine');
const {selectCandidate}=require('./candidateSelection');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
const K1='NSE_FO|777',K2='NSE_FO|888';
function analysis({key=K1,strike=23000,tier='C',spot=23010,breakoutId='2026-10-28:UP:2026-10-28T04:25:00.000Z',version='OPENING_RANGE_SHADOW_V3',
  aligned=true,fresh=true,ready=true,chase=50,direction='BULLISH',at=BASE}={}){
  const leg={instrumentKey:key,contractId:'NIFTY 03 NOV '+strike+' CE',strike,type:'CE',delta:0.5};
  return {timestamp:new Date(at).toISOString(),expiry:'2026-11-03',spot,market:{phase:'OPEN'},decision:{strategy:'WAIT',regime:{direction},
    researchCandidatePlans:{plans:{[tier]:{available:true,strategy:'LONG_CALL',legs:{buyLeg:leg,legDelta:0.5}}}},
    shadowTiming:{version,plans:{[tier]:{status:'CONFIRMED',shadowEntryReady:ready,strategy:'LONG_CALL',contracts:[key],
      episodeId:breakoutId,breakoutId,regimeAligned:aligned,entryFresh:fresh,chaseLimitPoints:chase,crossedAt:'2026-10-28T04:30:00.000Z',
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
]) assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},analysis(args)).reason,expected,label);
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
// --- authoritative mode never reads V3 timing ---
assert.equal(selectCandidate({entryMode:'AUTHORITATIVE_A_ONLY'},analysis()).reason,'BACKEND_NOT_READY');
console.log('Sandbox shadow V3 PASS: breakout id recorded, one entry per breakout across strike rolls and tiers, V3 gates re-checked, V2 path unchanged');
