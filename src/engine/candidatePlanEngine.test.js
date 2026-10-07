'use strict';
const assert=require('assert');
const {buildResearchCandidatePlans}=require('./candidatePlanEngine');
const rows=[
 {strike:22600,ceDelta:.62,peDelta:-.38,ceLTP:180,peLTP:90,ceBid:179,ceAsk:181,peBid:89,peAsk:91,ceInstrumentKey:'ce22600',peInstrumentKey:'pe22600'},
 {strike:22650,ceDelta:.52,peDelta:-.48,ceLTP:150,peLTP:110,ceBid:149,ceAsk:151,peBid:109,peAsk:111,ceInstrumentKey:'ce22650',peInstrumentKey:'pe22650'},
 {strike:22700,ceDelta:.42,peDelta:-.58,ceLTP:120,peLTP:140,ceBid:119,ceAsk:121,peBid:139,peAsk:141,ceInstrumentKey:'ce22700',peInstrumentKey:'pe22700'},
 {strike:22750,ceDelta:.28,peDelta:-.72,ceLTP:80,peLTP:180,ceBid:79,ceAsk:81,peBid:179,peAsk:181,ceInstrumentKey:'ce22750',peInstrumentKey:'pe22750'},
 {strike:22800,ceDelta:.22,peDelta:-.78,ceLTP:60,peLTP:220,ceBid:59,ceAsk:61,peBid:219,peAsk:221,ceInstrumentKey:'ce22800',peInstrumentKey:'pe22800'}
];
const out=buildResearchCandidatePlans({
 strikes:rows,regime:{direction:'BULLISH'},strategy:'BULL_CALL_SPREAD',
 tradeLegs:{buyLeg:{strike:22650,type:'CE'},sellLeg:{strike:22750,type:'CE'}},
 orchestration:{status:'WAIT_FOR_TRIGGER'},expiryDate:'2026-10-13',lotSize:65,
 chartIntelligence:{verdict:'BULLISH'}
});
assert.equal(out.version,'RESEARCH_CANDIDATE_PLANS_V1');
assert.equal(out.plans.A.executionAllowed,false);
assert.equal(out.plans.B.strategy,'BULL_CALL_SPREAD');
assert.equal(out.plans.B.legs.buyLeg.strike,22650);
assert.ok(out.plans.B.legs.sellLeg.strike>out.plans.B.legs.buyLeg.strike);
assert.equal(out.plans.C.strategy,'LONG_CALL');
assert.equal(out.chartAgreement,'AGREES');
console.log('candidatePlanEngine tests passed');
