'use strict';
const assert=require('assert');
const {setupFeatureTags,setupEvidenceKey,summarizeSetupEvidence}=require('./setupEvidence');

const snapshot={
 timestamp:'2026-09-28T13:15:00+05:30',spot:22820,strategy:'BEAR_CALL_SPREAD',dte:1,
 regime:{direction:'BEARISH'},volatility:{richness:'RICH'},
 setupFeatures:{
  atr:{value:28},openingRange:{position:'BELOW'},
  vwap:{distancePct:-0.42,slope:-0.018,relativeVolume:1.45},
  volume:{relativeVolume:1.45}
 }
};
const tags=setupFeatureTags(snapshot);
assert.strictEqual(tags.openingRangePosition,'BELOW');
assert.strictEqual(tags.vwapSide,'BELOW');
assert.strictEqual(tags.vwapSlopeDirection,'FALLING');
assert.strictEqual(tags.relativeVolumeBucket,'HIGH');
assert.strictEqual(tags.atrBucket,'NORMAL');
const key=setupEvidenceKey(snapshot);
assert(key.includes('OR:BELOW'));
assert(key.includes('VWAP:BELOW_FALLING'));
assert(key.includes('RVOL:HIGH'));
const outcome={status:'MEASURED',mfePct:12,maePct:-5,horizonsPct:{60:4}};
const rows=Array.from({length:20},()=>({snapshot,outcome}));
const summary=summarizeSetupEvidence(rows);
assert.strictEqual(summary[key].qualified,true);
assert.strictEqual(summary[key].descriptiveOnly,true);
assert.strictEqual(summary[key].winRate60m,100);
console.log('EDGE setup evidence tests passed');
