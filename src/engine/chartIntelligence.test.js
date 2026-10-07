'use strict';
const assert = require('assert');
const { buildChartIntelligence } = require('./chartIntelligence');

function candle(ts,o,h,l,c,v=100){ return [ts,o,h,l,c,v]; }
const base = Date.parse('2026-10-07T03:45:00.000Z');
const iso = i => new Date(base + i*5*60000).toISOString();

const index5m = [];
for (let i=0;i<20;i++) {
  const p=22500+i*5;
  index5m.push(candle(iso(i),p,p+8,p-3,p+5,100+i*5));
}
const index15m = [];
for (let i=0;i<8;i++) {
  const p=22500+i*12;
  index15m.push(candle(new Date(base+i*15*60000).toISOString(),p,p+15,p-5,p+10,200+i*10));
}
const out=buildChartIntelligence({
  index5m,index15m,
  setupFeatures:{vwap:{available:true,distancePct:0.4,slope:0.1,value:22540},volume:{relativeVolume:1.3}}
});
assert.equal(out.version,'CHART_INTELLIGENCE_V1');
assert.equal(out.researchOnly,true);
assert.equal(out.liveDecisionImpact,false);
assert.ok(['BULLISH','CONFLICTED','NEUTRAL'].includes(out.verdict));
assert.equal(out.vwap.side,'ABOVE');
assert.equal(out.participation.state,'ABOVE_RECENT_AVERAGE');
console.log('chartIntelligence tests passed');
