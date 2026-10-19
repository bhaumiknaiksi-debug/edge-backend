'use strict';
const assert=require('node:assert/strict');
const {buildSnapshot,contractFromKite,matchSnapshots}=require('./tradeSnapshots');
const analysisAt='2026-10-19T04:30:00.000Z';
const analysis={
 timestamp:analysisAt,spot:23700,expiry:'2026-10-20',pcr:1.1,bias:'BULLISH',
 decision:{signalTier:{tier:'C',failedGates:['TRIGGER']},orchestration:{status:'WAIT_FOR_TRIGGER',blockers:['TRIGGER']},
  researchCandidatePlans:{plans:{
   A:{tier:'A',available:true,executionAllowed:false,strategy:'LONG_CALL',legs:{buyLeg:{strike:23600,type:'CE',instrumentKey:'x'}}},
   B:{tier:'B',available:true,executionAllowed:false,strategy:'LONG_CALL',legs:{buyLeg:{strike:23600,type:'CE',instrumentKey:'x'}}},
   C:{tier:'C',available:true,executionAllowed:false,strategy:'LONG_CALL',legs:{buyLeg:{strike:23600,type:'CE',instrumentKey:'x'}}}
  }}
 },market:{phase:'OPEN'}
};
const now=new Date('2026-10-19T04:30:25.000Z');
const snap=buildSnapshot(analysis,'C',analysisAt,now);
assert.equal(snap.tier,'C');
assert.equal(snap.actualSignalTier,'C');
assert.equal(snap.authorization.executionAllowed,false);
assert.equal(snap.authorization.researchOnly,true);
assert.equal(snap.selectedLegs[0].strike,23600);
assert.equal(snap.prices.spot,23700);
assert.equal(analysis.decision.researchCandidatePlans.plans.C.strategy,'LONG_CALL');
assert.throws(()=>buildSnapshot(analysis,'C',analysisAt,new Date('2026-10-19T04:33:00Z')),/SNAPSHOT_ANALYSIS_STALE/);
assert.throws(()=>buildSnapshot(analysis,'C','2026-10-19T04:29:59.000Z',now),/SNAPSHOT_ANALYSIS_CHANGED/);
assert.throws(()=>buildSnapshot(analysis,'D',analysisAt,now),/INVALID_SNAPSHOT_TIER/);
assert.deepEqual(contractFromKite('NIFTY26O2023600CE'),{expiry:'2026-10-20',strike:23600,type:'CE',exact:true});
assert.deepEqual(contractFromKite('NIFTY26OCT23600CE'),{expiry:'2026-10',strike:23600,type:'CE',exact:false});
assert.equal(contractFromKite('BANKNIFTY26O2023600CE'),null);
const saved={id:'s1',payload:snap};
const fill={key:'fill-1',symbol:'NIFTY26O2023600CE',side:'BUY',time:'2026-10-19T10:00:20',
 orderId:'order-1',tradeId:'trade-1',quantity:65,price:100};
const ep={symbol:fill.symbol,openedAt:fill.time,grossPnl:525};
const a=matchSnapshots([saved],[fill],[ep])[0];
assert.equal(a.status,'MATCHED');
assert.equal(a.details.grossPnl,525);
assert.equal(a.details.netPnl,null);
assert.equal(a.details.matchedQuantity,65);
assert.equal(matchSnapshots([saved],[],[])[0].status,'PENDING_TRADEBOOK');
assert.equal(matchSnapshots([saved],[{...fill,symbol:'NIFTY26O2123600CE'}],[])[0].status,'UNMATCHED');
assert.equal(matchSnapshots([saved],[{...fill,symbol:'NIFTY26OCT23600CE'}],[])[0].status,'AMBIGUOUS');
assert.equal(matchSnapshots([saved,saved],[fill],[ep]).every(r=>r.status==='AMBIGUOUS'),true);
const spread=JSON.parse(JSON.stringify(snap));
spread.selectedLegs.push({name:'sellLeg',side:'SELL',strike:23700,type:'CE'});
assert.equal(matchSnapshots([{id:'s2',payload:spread}],[fill],[])[0].status,'PARTIAL');
const fill2={...fill,key:'fill-2',side:'SELL',symbol:'NIFTY26O2023700CE',orderId:'order-2'};
assert.equal(matchSnapshots([{id:'s2',payload:spread}],[fill,fill2],[])[0].status,'MATCHED');
assert.equal(matchSnapshots([{id:'s2',payload:spread}],[fill,fill2],[])[0].details.grossPnl,null);
console.log('Trade snapshot: immutable capture, stale guard, exact expiry, conservative matching, partial legs, dedup and net-P&L guard PASS');
