'use strict';
const assert=require('node:assert/strict');
const {makePlan,buildTradePlans}=require('./readOnlyTradePlanner');
const {buildSnapshot}=require('./tradeSnapshots');
const analysisAt='2026-10-19T05:00:00.000Z';
const src={
 timestamp:analysisAt,spot:24000,expiry:'2026-10-20',
 support:{strike:23960},resistance:{strike:24040},
 market:{phase:'OPEN'},
 decision:{orchestration:{status:'WAIT_FOR_TRIGGER'},signalTier:{tier:'C'},
 researchCandidatePlans:{plans:{
 A:{available:true,executionAllowed:false,strategy:'LONG_CALL',legs:{buyLeg:{contractId:'test-ce',type:'CE',strike:24000,ask:112,bid:110,premium:111,delta:.5}}},
 B:{available:true,executionAllowed:false,strategy:'BULL_CALL_SPREAD',legs:{buyLeg:{type:'CE',strike:24000,ask:112,bid:110,delta:.5},sellLeg:{type:'CE',strike:24100,bid:75,ask:78,delta:.25}}},
 C:{available:true,executionAllowed:false,strategy:'LONG_PUT',legs:{buyLeg:{type:'PE',strike:24000,ask:105,bid:103,delta:.45}}}
 }}}};
const initial=JSON.stringify(src),plans=buildTradePlans(src);
assert.equal(plans.mode,'SHADOW');
assert.equal(plans.liveDecisionImpact,false);
assert.equal(JSON.stringify(src),initial,'Must never mutate source candidate or decision');
const a=plans.tiers.A;
assert.equal(a.status,'MODEL_READY_SHADOW');
const authoritative=structuredClone(src);
delete authoritative.decision.researchCandidatePlans.plans.A.legs.buyLeg.delta;
authoritative.decision.researchCandidatePlans.plans.A.legs.legDelta=.5;
assert.equal(makePlan(authoritative,'A').targets[0].premium,132,'A uses legacy root-level legDelta without changing selection');
assert.equal(a.entry.ask,112);
assert.equal(a.targets[0].premium,132);
assert.equal(a.stop.premium,90);
assert.equal(a.riskReward,.91);
assert.equal(a.executable,false);
assert.equal(a.reasons.includes('ENTRY_TRIGGER_NOT_VERIFIED'),true);
assert.equal(plans.tiers.C.targets[0].premium,123);
assert.equal(plans.tiers.C.stop.premium,85);
assert.equal(plans.tiers.B.status,'INSUFFICIENT_DATA','Do not invent a spread premium model');
assert.deepEqual(plans.tiers.B.targets,[]);
const bad=structuredClone(src);
bad.decision.researchCandidatePlans.plans.A.legs.buyLeg.ask=null;
assert.equal(makePlan(bad,'A').status,'INSUFFICIENT_DATA');
const wide=structuredClone(src);
wide.decision.researchCandidatePlans.plans.A.legs.buyLeg.ask=120;
assert(makePlan(wide,'A').reasons.includes('SPREAD_TOO_WIDE_FOR_MODEL'));
const noSupport=structuredClone(src);
noSupport.support={strike:24050};
assert.equal(makePlan(noSupport,'C').status,'INSUFFICIENT_DATA');
const snapshot=buildSnapshot(src,'C',analysisAt,new Date('2026-10-19T05:00:20.000Z'));
assert.equal(snapshot.tradePlan.version,'TRADE_PLANNER_SHADOW_V1');
assert.equal(snapshot.tradePlan.targets[0].premium,123);
assert.equal(snapshot.tradePlan.authorizationChanged,false);
assert.equal(snapshot.authorization.executionAllowed,false);
assert.equal(JSON.stringify(src),initial,'Snapshot capture must not affect candidate selection');
console.log('Read-only trade planner tests PASS: structure/quote guards, no invented spreads, shadow-only, immutability and snapshot plan freeze');
