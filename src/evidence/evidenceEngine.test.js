'use strict';
const assert=require('assert');
const {evidenceKey,measureOutcome,summarizeEvidence}=require('./evidenceEngine');
const snapshot={timestamp:'2026-09-25T10:00:00+05:30',strategy:'LONG_CALL',dte:4,regime:{direction:'BULLISH'},volatility:{richness:'CHEAP'},tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE',premium:'100',bid:99,ask:101}}};
const candles={'NIFTY TEST CE':[
 {timestamp:'2026-09-25T10:15:00+05:30',close:110},{timestamp:'2026-09-25T10:30:00+05:30',close:95},{timestamp:'2026-09-25T11:00:00+05:30',close:130}
]};
const out=measureOutcome({snapshot,candlesByContract:candles});
assert.strictEqual(out.status,'MEASURED');
assert(out.mfePct>28&&out.mfePct<29);
assert(out.maePct<0);
assert.strictEqual(out.bestMinute,60);
const key=evidenceKey(snapshot); assert(key.includes('BULLISH|CHEAP|4_7DTE|MORNING|LONG_CALL'));
const rows=Array.from({length:20},()=>({snapshot,evidenceKey:key,outcome:out}));
const s=summarizeEvidence(rows);assert.strictEqual(s[key].qualified,true);assert.strictEqual(s[key].samples,20);
console.log('EDGE evidence tests passed');
