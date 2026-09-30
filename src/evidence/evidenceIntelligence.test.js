'use strict';
const assert=require('assert');
const {measuredEpisodes,metrics,frictionCostPct,chronologicalSplit,walkForwardFolds,buildEvidenceIntelligence}=require('./evidenceIntelligence');

function row(id,ret,overrides={}){
  const snapshot={id,timestamp:'2026-09-28T10:15:00+05:30',spot:23000,strategy:'LONG_CALL',dte:2,
    regime:{direction:'BULLISH'},volatility:{richness:'CHEAP'},
    setupFeatures:{atr:{value:25},openingRange:{position:'ABOVE'},vwap:{distancePct:0.2,slope:0.01},volume:{relativeVolume:1.4}},
    tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE',ask:100,bid:99,premium:99.5}},
    setupScanner:{version:'SETUP_SCANNER_V1',researchOnly:true,liveDecisionImpact:false,candidates:[
      {type:'OPENING_RANGE_BREAK',direction:'BULLISH',state:'OUTSIDE_RANGE',observed:true},
      {type:'VWAP_CONTINUATION',direction:'BULLISH',state:'ALIGNED',observed:true},
      {type:'VWAP_PULLBACK',direction:'BULLISH',state:'MODERATE',observed:true},
      {type:'MULTI_TIMEFRAME_MOMENTUM',direction:'BULLISH',state:'ALIGNED',observed:true}
    ]},...overrides};
  const h={15:ret/2,30:ret*0.75,60:ret,120:ret*0.8};
  return {id:id+'|OUTCOME|1',recordType:'OUTCOME',snapshotId:id,attempt:1,snapshot,
    outcome:{
      status:'MEASURED',entryValue:100,mfePct:ret+5,maePct:-3,bestMinute:60,
      entryLegMarks:{buyLeg:{contractId:'NIFTY TEST CE',side:'BUY',price:100}},
      horizonLegMarks:{
        15:{marks:{buyLeg:100+h[15]}},
        30:{marks:{buyLeg:100+h[30]}},
        60:{marks:{buyLeg:100+h[60]}},
        120:{marks:{buyLeg:100+h[120]}}
      },
      horizonsPct:h
    }};
}

const rows=[
  row('a',10,{timestamp:'2026-09-28T10:15:00+05:30'}),
  row('b',-5,{timestamp:'2026-09-28T10:45:00+05:30'}),
  row('c',15,{timestamp:'2026-09-28T11:15:00+05:30'})
];
const intel=buildEvidenceIntelligence(rows,{
  minSamples:3,minTrainSamples:2,minTestSamples:1,testFraction:0.34,
  friction:{roundTripBpsOnGrossPremium:100,flatRupeesPerLegRoundTrip:65,lotSize:65}
});
assert.strictEqual(intel.researchOnly,true);
assert.strictEqual(intel.liveDecisionImpact,false);
assert.strictEqual(intel.measuredEpisodes,3);
assert.strictEqual(intel.overall.qualified,true);
assert.strictEqual(intel.overall.horizons[60].winRatePct,66.67);
assert.strictEqual(intel.dimensions.strategy.LONG_CALL.samples,3);
assert.strictEqual(intel.dimensions.regime.BULLISH.samples,3);
assert.strictEqual(intel.dimensions.openingRange.ABOVE.samples,3);
assert.strictEqual(intel.dimensions.vwapSide.ABOVE.samples,3);
assert.strictEqual(intel.dimensions.vwapSlope.RISING.samples,3);
assert.strictEqual(intel.dimensions.relativeVolume.HIGH.samples,3);
assert.strictEqual(intel.version,'EVIDENCE_INTELLIGENCE_V5');
assert.strictEqual(intel.dimensions.scannerOpeningRange['BULLISH|OUTSIDE_RANGE'].samples,3);
assert.strictEqual(intel.dimensions.scannerVwapContinuation['BULLISH|ALIGNED'].samples,3);
assert.strictEqual(intel.dimensions.scannerVwapPullback['BULLISH|MODERATE'].samples,3);
assert.strictEqual(intel.dimensions.scannerMomentum['BULLISH|ALIGNED'].samples,3);
assert.strictEqual(Object.values(intel.scannerGroups)[0].samples,3);
assert.ok(intel.methodology.scanner.includes('observational research labels'));
assert.strictEqual(intel.validation.version,'CHRONOLOGICAL_HOLDOUT_V1');
assert.strictEqual(intel.validation.trainEpisodes,2);
assert.strictEqual(intel.validation.testEpisodes,1);
assert.strictEqual(intel.validation.cutoffTimestamp,'2026-09-28T11:15:00+05:30');
assert.strictEqual(intel.validation.overall.validationReady,true);
assert.strictEqual(intel.validation.overall.test.gross.horizons[60].avgReturnPct,15);
assert.strictEqual(intel.validation.overall.test.frictionAdjusted.horizons[60].avgReturnPct,13);
assert.strictEqual(intel.validation.frictionModel.configured,true);
assert.strictEqual(frictionCostPct(rows[0],{roundTripBpsOnGrossPremium:100,flatRupeesPerLegRoundTrip:65,lotSize:65}),2);
const split=chronologicalSplit([rows[2],rows[0],rows[1]],0.34);
assert.deepStrictEqual(split.train.map(r=>r.snapshotId),['a','b']);
assert.deepStrictEqual(split.test.map(r=>r.snapshotId),['c']);

const calibrated=buildEvidenceIntelligence(rows,{
  minSamples:1,minTrainSamples:2,minTestSamples:1,testFraction:0.34,
  friction:{profileName:'UPSTOX_STANDARD_NSE_OPTIONS_2026'}
});
assert.strictEqual(calibrated.validation.frictionModel.mode,'CALIBRATED_PROFILE');
assert.strictEqual(calibrated.validation.frictionModel.calibratedProfile.brokeragePerExecutedOrderRupees,20);
assert(calibrated.validation.overall.test.frictionAdjusted.horizons[60].avgReturnPct <
  calibrated.validation.overall.test.gross.horizons[60].avgReturnPct);

const wfRows=Array.from({length:45},(_,i)=>row('wf'+i,(i%3)-1,{
  timestamp:new Date(Date.parse('2026-09-01T04:00:00Z')+i*30*60000).toISOString()
}));
const wf=walkForwardFolds(wfRows,{minTrainSamples:20,minTestSamples:5,testWindowSize:10,stepSize:10});
assert.strictEqual(wf.folds.length,3);
assert.strictEqual(wf.folds[0].train.length,20);
assert.strictEqual(wf.folds[0].test.length,10);
// A custom step smaller than the test window must not create overlapping folds.
const disjoint=walkForwardFolds(wfRows,{minTrainSamples:20,minTestSamples:5,testWindowSize:10,stepSize:5});
assert.strictEqual(disjoint.stepSize,10);
for(let i=1;i<disjoint.folds.length;i++){
  const prev=new Set(disjoint.folds[i-1].test.map(r=>r.snapshotId));
  assert.strictEqual(disjoint.folds[i].test.some(r=>prev.has(r.snapshotId)),false);
}
// Slippage-only legacy stress must be non-zero rather than silently ignored.
assert(frictionCostPct(rows[0],{profileName:'NONE',slippageBps:100,lotSize:65})>0);
const wfIntel=buildEvidenceIntelligence(wfRows,{
  minSamples:20,
  friction:{profileName:'UPSTOX_STANDARD_NSE_OPTIONS_2026'},
  walkForwardMinTrainSamples:20,
  walkForwardMinTestSamples:5,
  walkForwardTestWindowSize:10,
  walkForwardStepSize:10
});
assert.strictEqual(wfIntel.walkForward.version,'WALK_FORWARD_V1');
assert.strictEqual(wfIntel.walkForward.foldCount,3);
assert.strictEqual(wfIntel.walkForward.enoughForWalkForward,true);
assert.strictEqual(wfIntel.walkForward.aggregateTest.gross.samples,25);
assert.strictEqual(wfIntel.walkForward.aggregateTest.frictionAdjusted.horizons[60].measured,25);
assert.strictEqual(wfIntel.walkForward.stability.totalFolds,3);
assert.strictEqual(wfIntel.walkForward.stability.eligibleFolds,3);
assert.strictEqual(wfIntel.walkForward.stability.foldCoveragePct,100);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].validFolds,3);
assert.strictEqual(wfIntel.governance.version,'RESEARCH_GOVERNANCE_V1');
assert.strictEqual(wfIntel.governance.researchOnly,true);
assert.strictEqual(wfIntel.governance.liveDecisionImpact,false);
assert.strictEqual(wfIntel.governance.gates.sampleSufficient,true);
assert.strictEqual(wfIntel.governance.gates.holdoutReady,true);
assert.strictEqual(wfIntel.governance.gates.replicated,true);
assert.strictEqual(wfIntel.governance.gates.frictionConfigured,true);
assert.strictEqual(wfIntel.governance.status,'REPLICATED_RESEARCH');
assert.ok(wfIntel.governance.interpretation.includes('not proof of profitability'));
const insufficient=buildEvidenceIntelligence(rows,{minSamples:20,governanceMinMeasured:20});
assert.strictEqual(insufficient.governance.status,'INSUFFICIENT_DATA');
assert.strictEqual(wfIntel.walkForward.stability.gross[60].positiveFolds,2);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].eligibleMeasuredTestSamples,25);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].eligibleSampleCoveragePct,100);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].medianFoldReturnPct,0.1);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].worstFoldReturnPct,-0.1);
assert.strictEqual(wfIntel.walkForward.stability.gross[60].dispersionStdDevPct,0.12);
assert.strictEqual(wfIntel.walkForward.stability.frictionAdjusted[60].validFolds,3);
assert.ok(wfIntel.walkForward.stability.definition.includes('population standard deviation'));
const longCallWf=wfIntel.walkForward.strategyGroups.LONG_CALL;
assert.strictEqual(longCallWf.stability.totalFolds,3);
assert.strictEqual(longCallWf.stability.eligibleFolds,3);
assert.strictEqual(longCallWf.stability.gross[60].validFolds,3);

// Old evidence without scanner data must remain usable and be labelled unavailable, not invented.
const legacy=row('legacy',4,{setupScanner:null});
const legacyIntel=buildEvidenceIntelligence([legacy],{minSamples:1});
assert.strictEqual(legacyIntel.dimensions.scannerVwapContinuation.UNAVAILABLE.samples,1);

// Duplicate measured records for the same execution episode must not inflate samples.
const duplicate={...rows[0],id:'a|OUTCOME|2',attempt:2};
assert.strictEqual(measuredEpisodes([...rows,duplicate]).length,3);

// Non-measured outcomes never enter intelligence.
assert.strictEqual(measuredEpisodes([...rows,{recordType:'OUTCOME',snapshotId:'x',outcome:{status:'UNAVAILABLE'}}]).length,3);

// Qualification is descriptive sample gating only.
assert.strictEqual(metrics(rows,4).qualified,false);
const missingHorizon=row('missing',7);
missingHorizon.outcome.horizonsPct[60]=null;
assert.strictEqual(metrics([missingHorizon],1).horizons[60].measured,0);
assert.strictEqual(intel.methodology.qualification.includes('not proof of edge'),true);
console.log('EDGE evidence intelligence tests passed');
