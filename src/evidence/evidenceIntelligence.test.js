'use strict';
const assert=require('assert');
const {measuredEpisodes,metrics,buildEvidenceIntelligence}=require('./evidenceIntelligence');

function row(id,ret,overrides={}){
  const snapshot={id,timestamp:'2026-09-28T10:15:00+05:30',spot:23000,strategy:'LONG_CALL',dte:2,
    regime:{direction:'BULLISH'},volatility:{richness:'CHEAP'},
    setupFeatures:{atr:{value:25},openingRange:{position:'ABOVE'},vwap:{distancePct:0.2,slope:0.01},volume:{relativeVolume:1.4}},...overrides};
  return {id:id+'|OUTCOME|1',recordType:'OUTCOME',snapshotId:id,attempt:1,snapshot,
    outcome:{status:'MEASURED',mfePct:ret+5,maePct:-3,bestMinute:60,horizonsPct:{15:ret/2,30:ret*0.75,60:ret,120:ret*0.8}}};
}

const rows=[row('a',10),row('b',-5),row('c',15)];
const intel=buildEvidenceIntelligence(rows,{minSamples:3});
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

// Duplicate measured records for the same execution episode must not inflate samples.
const duplicate={...rows[0],id:'a|OUTCOME|2',attempt:2};
assert.strictEqual(measuredEpisodes([...rows,duplicate]).length,3);

// Non-measured outcomes never enter intelligence.
assert.strictEqual(measuredEpisodes([...rows,{recordType:'OUTCOME',snapshotId:'x',outcome:{status:'UNAVAILABLE'}}]).length,3);

// Qualification is descriptive sample gating only.
assert.strictEqual(metrics(rows,4).qualified,false);
assert.strictEqual(intel.methodology.qualification.includes('not proof of edge'),true);
console.log('EDGE evidence intelligence tests passed');
