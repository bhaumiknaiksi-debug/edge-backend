'use strict';
const assert = require('assert');
const { buildChartIntelligence, regressionChannel, gapStructure, levelEvents } = require('./chartIntelligence');

function candle(ts,o,h,l,c,v=100){ return [ts,o,h,l,c,v,0]; }
const base = Date.parse('2026-10-07T03:45:00.000Z');
const iso = (i,mins=5) => new Date(base + i*mins*60000).toISOString();

const index5m=[];
for(let i=0;i<24;i++){ const p=22500+i*5; index5m.push(candle(iso(i),p,p+9,p-3,p+6,100+i*5)); }
const index15m=[];
for(let i=0;i<10;i++){ const p=22500+i*14; index15m.push(candle(iso(i,15),p,p+18,p-5,p+12,200+i*10)); }
const index30m=[];
for(let i=0;i<8;i++){ const p=22500+i*25; index30m.push(candle(iso(i,30),p,p+28,p-8,p+20,300+i*20)); }
const daily=[
 candle('2026-10-05T00:00:00+05:30',22400,22600,22350,22550,0),
 candle('2026-10-06T00:00:00+05:30',22560,22700,22480,22620,0)
];

const out=buildChartIntelligence({
 index5m,index15m,index30m,historicalDaily:daily,
 setupFeatures:{
   openingRange:{high:22540,low:22495},
   vwap:{available:true,distancePct:0.4,slope:0.1,value:22540},
   volume:{relativeVolume:1.3}
 },
 sessionHigh:22680,sessionLow:22495
});
assert.equal(out.version,'CHART_INTELLIGENCE_V2');
assert.equal(out.researchOnly,true);
assert.equal(out.liveDecisionImpact,false);
assert.ok(out.structure.thirtyMinute);
assert.ok(out.previousDay);
assert.equal(out.previousDay.close,22620);
assert.ok(out.channel.fiveMinute.state);
assert.ok(Array.isArray(out.supplyDemandZones));
assert.ok(Array.isArray(out.levelEvents));
assert.equal(out.vwap.side,'ABOVE');
assert.equal(out.participation.state,'ABOVE_RECENT_AVERAGE');

const ch=regressionChannel(require('./setupObservability').normalizeCandles(index5m),20);
assert.equal(ch.state,'RISING_CHANNEL');

const gap=gapStructure(require('./setupObservability').normalizeCandles(index5m),{close:22400});
assert.equal(gap.state,'GAP_UP');

const sweepCandles=require('./setupObservability').normalizeCandles([
 candle(iso(0),100,101,99,100),
 candle(iso(1),100,105,99.5,100.5)
]);
const ev=levelEvents(sweepCandles,[{name:'TEST_HIGH',value:102}],1);
assert.ok(ev.some(x=>x.type==='LIQUIDITY_SWEEP_HIGH'));

console.log('chartIntelligence V2 tests passed');
