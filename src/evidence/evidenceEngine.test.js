'use strict';
const assert=require('assert');
const {evidenceKey,measureOutcome,summarizeEvidence}=require('./evidenceEngine');
const snapshot={timestamp:'2026-09-25T10:00:00+05:30',strategy:'LONG_CALL',dte:4,regime:{direction:'BULLISH'},volatility:{richness:'CHEAP'},tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE',premium:'100',bid:99,ask:101}}};
const candles={'NIFTY TEST CE':[
 {timestamp:'2026-09-25T10:15:00+05:30',close:110},{timestamp:'2026-09-25T10:30:00+05:30',close:95},{timestamp:'2026-09-25T11:00:00+05:30',close:130},{timestamp:'2026-09-25T12:00:00+05:30',close:120},{timestamp:'2026-09-25T13:00:00+05:30',close:999}
]};
const out=measureOutcome({snapshot,candlesByContract:candles});
assert.strictEqual(out.status,'MEASURED');
assert(out.mfePct>28&&out.mfePct<29);
assert(out.maePct<0);
assert.strictEqual(out.bestMinute,60);
assert.strictEqual(out.entryLegMarks.buyLeg.side,'BUY');
assert.strictEqual(out.entryLegMarks.buyLeg.price,101);
assert.strictEqual(out.horizonLegMarks[60].marks.buyLeg,130);
assert.strictEqual(out.bestLegMarks.buyLeg,130);
const key=evidenceKey(snapshot); assert(key.includes('BULLISH|CHEAP|4_7DTE|MORNING|LONG_CALL'));
const rows=Array.from({length:20},()=>({snapshot,evidenceKey:key,outcome:out}));
const s=summarizeEvidence(rows);assert.strictEqual(s[key].qualified,true);assert.strictEqual(s[key].samples,20);
console.log('EDGE evidence tests passed');

// Multi-leg candles must align by timestamp rather than array position.
const spreadSnap={timestamp:'2026-09-25T10:00:00+05:30',strategy:'BEAR_CALL_SPREAD',tradeLegs:{sellLeg:{contractId:'S',bid:100,ask:101},buyLeg:{contractId:'B',bid:49,ask:50}}};
const spreadCandles={S:[{timestamp:'2026-09-25T10:15:00+05:30',close:90},{timestamp:'2026-09-25T10:30:00+05:30',close:80}],B:[{timestamp:'2026-09-25T10:30:00+05:30',close:40}]};
const spreadOut=measureOutcome({snapshot:spreadSnap,candlesByContract:spreadCandles,horizons:[30]});
assert.strictEqual(spreadOut.status,'MEASURED');
assert.strictEqual(spreadOut.bestMinute,30);

const incomplete=measureOutcome({snapshot,candlesByContract:{'NIFTY TEST CE':[{timestamp:'2026-09-25T10:15:00+05:30',close:110}]},horizons:[15,30]});
assert.strictEqual(incomplete.status,'UNAVAILABLE');
assert.strictEqual(incomplete.reason,'INCOMPLETE_HORIZON');

// Credit spread math: entry credit = short bid 100 - long ask 50 = 50.
// At +30m spread value = 80 - 40 = 40, so profit = (50-40)/50 = +20%.
assert(Math.abs(spreadOut.horizonsPct[30]-20)<0.001);

// Excursions after the requested 120-minute study window must not contaminate MFE.
assert(out.mfePct<100);

// Missing executable quote data must stay missing; null must never become numeric zero.
const missingEntry=measureOutcome({
  snapshot:{timestamp:'2026-09-25T10:00:00+05:30',strategy:'LONG_CALL',tradeLegs:{buyLeg:{contractId:'MISSING',ask:null,bid:null,premium:null}}},
  candlesByContract:{MISSING:[{timestamp:'2026-09-25T10:15:00+05:30',close:10}]},
  horizons:[15]
});
assert.strictEqual(missingEntry.status,'UNAVAILABLE');
assert.strictEqual(missingEntry.reason,'NO_EXECUTABLE_ENTRY_PRICE');
