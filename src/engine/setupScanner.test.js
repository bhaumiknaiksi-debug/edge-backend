'use strict';
const assert = require('assert');
const { scanSetups } = require('./setupScanner');

function byType(r, type) { return r.candidates.find(x => x.type === type); }

const bull = scanSetups({
  setupFeatures: {
    openingRange:{available:true,position:'ABOVE',high:25000,low:24900,width:100},
    vwap:{distancePct:0.08,slope:0.02,relativeVolume:1.4},
    volume:{relativeVolume:1.4}
  },
  trend5mPct:0.12, trend15mPct:0.18, trend30mPct:0.2
});
assert.strictEqual(bull.researchOnly,true);
assert.strictEqual(bull.liveDecisionImpact,false);
assert.strictEqual(byType(bull,'OPENING_RANGE_BREAK').direction,'BULLISH');
assert.strictEqual(byType(bull,'VWAP_CONTINUATION').state,'ALIGNED');
assert.strictEqual(byType(bull,'VWAP_PULLBACK').state,'NEAR');
assert.strictEqual(byType(bull,'MULTI_TIMEFRAME_MOMENTUM').direction,'BULLISH');

const bear = scanSetups({
  setupFeatures:{
    openingRange:{available:true,position:'BELOW',high:25000,low:24900,width:100},
    vwap:{distancePct:-0.4,slope:-0.03},
    volume:{relativeVolume:0.7}
  },
  trend5mPct:-0.1,trend15mPct:-0.2,trend30mPct:-0.1
});
assert.strictEqual(byType(bear,'OPENING_RANGE_BREAK').direction,'BEARISH');
assert.strictEqual(byType(bear,'VWAP_CONTINUATION').direction,'BEARISH');
assert.strictEqual(byType(bear,'VWAP_PULLBACK').state,'FAR');
assert.strictEqual(byType(bear,'MULTI_TIMEFRAME_MOMENTUM').direction,'BEARISH');

const missing=scanSetups({});
assert.strictEqual(missing.summary.observed,0);
assert.ok(missing.candidates.every(x=>x.state==='UNAVAILABLE'));
assert.ok(missing.methodology.thresholds.includes('not validated'));

console.log('Setup Scanner V1 tests passed');
