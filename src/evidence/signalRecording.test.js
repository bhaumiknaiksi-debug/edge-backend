'use strict';
const assert=require('node:assert/strict');
const {buildRuleSpec,signalFingerprint}=require('./signalRecording');
const {buildSignalTier}=require('../engine/signalTier');
const clone=x=>JSON.parse(JSON.stringify(x));
const args={setup:{qualified:true},risk:{status:'READY'},position:{status:'READY'},strategy:'LONG_CALL',
 regime:{direction:'BULLISH'},marketPhase:'OPEN',chartIntelligence:{verdict:'BULLISH'},
 orchestration:{status:'WAIT_FOR_TRIGGER'},entry:{triggerReady:false,priceReady:true,liquidityReady:true}};
const base={strategy:args.strategy,orchestrationStatus:'WAIT_FOR_TRIGGER',entryStatus:'WAIT_FOR_TRIGGER',entry:args.entry,
 signalTier:buildSignalTier(args),tradeLegs:{buyLeg:{instrumentKey:'same',contractId:'same',strike:100,type:'CE',ask:10}},
 readinessView:{version:'READINESS_VIEW_V1',market:{status:'INCOMPLETE',missing:['trigger','chart'],gates:{trigger:false,chart:false}},eligibility:{eligible:false,positionStatus:'BLOCKED'}},
 ruleSpec:buildRuleSpec()};
const c=clone(base);c.signalTier=buildSignalTier({...args,chartIntelligence:{verdict:'BEARISH'}});
assert.equal(base.signalTier.tier,'B');assert.equal(c.signalTier.tier,'C');
assert.notEqual(signalFingerprint(base),signalFingerprint(c));
// Shadow can be absent: genuine chart/readiness transitions still persist.
for(const mutate of [
 x=>{x.signalTier.chartAgreement='CONTRADICTS';},
 x=>{x.readinessView.market.gates.chart=true;},
 x=>{x.readinessView.eligibility.eligible=true;},
 x=>{x.ruleSpec.implementationHash='new-rules';},
 x=>{x.chartIntelligence={verdict:'BULLISH'};},
 x=>{x.entry.priceReady=false;},
 x=>{x.researchCandidatePlans={plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:{instrumentKey:'new'}}}}};}
]){const changed=clone(base);mutate(changed);assert.notEqual(signalFingerprint(changed),signalFingerprint(base));}
const noise=clone(base);noise.timestamp='later';noise.spot=110;noise.tradeLegs.buyLeg.ask=11;
noise.readinessView.market.missing.reverse();noise.signalTier.failedGates.reverse();
assert.equal(signalFingerprint(noise),signalFingerprint(base));
const reordered=Object.fromEntries(Object.entries(base).reverse());assert.equal(signalFingerprint(reordered),signalFingerprint(base));
const before=JSON.stringify(base);signalFingerprint(base);assert.equal(JSON.stringify(base),before);
const stamp=buildRuleSpec();assert.match(stamp.implementationHash,/^[a-f0-9]{64}$/);
stamp.components.entry.files={};assert.notDeepEqual(stamp,buildRuleSpec());
assert.equal(buildRuleSpec().paperExitSimulator,'NOT_IMPLEMENTED');
// A suppressed identical poll followed by B -> C -> B yields two distinct transitions.
let last=signalFingerprint(base);let saved=0;
for(const row of [clone(base),c,clone(c),base]){const next=signalFingerprint(row);if(next!==last){saved++;last=next;}}
assert.equal(saved,2);
console.log('signalRecording PASS: B/C, chart, readiness, eligibility, rule versions, candidate changes, stable noise and immutability');
