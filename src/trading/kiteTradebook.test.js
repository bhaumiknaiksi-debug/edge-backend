'use strict';
const assert=require('node:assert/strict');
const {apply,budget}=require('./ledger');
const {normalizeFill,importBrokerFills,summarizeBroker}=require('./kiteTradebook');
const now=new Date('2026-10-17T08:00:00Z');
const base=()=>({trades:[],confirmedDay:null,lockedDays:[],operations:[]});
const fill=(id,side,time,price,quantity=65,symbol='NIFTY26O1322500CE')=>({
  symbol,exchange:'NSE',tradeDate:time.slice(0,10),time,side,tradeId:id,orderId:'ORDER'+id,quantity,price
});
const rows=[
 fill('101','buy','2026-10-09T12:10:56',124.90),
 fill('102','sell','2026-10-09T12:58:16',139.15),
 fill('103','buy','2026-10-13T11:22:15',48.25),
 fill('104','sell','2026-10-13T11:39:58',60.80)
];
const before=budget(base(),now);
let state=apply(base(),'import',{requestId:'kite_import_0000001',clientId:'TEST123',fills:rows},now);
const after=budget(state,now);
assert.deepEqual(after,before,'Historical Kite import must not touch capital, daily loss, confirmation or open risk');
assert.equal(state.brokerFills.length,4);
let summary=summarizeBroker(state);
assert.equal(summary.summary.completedTrades,2);
assert.equal(summary.summary.grossPnl,1742);
assert.equal(summary.summary.affectsRiskLedger,false);
assert.equal(summary.episodes[0].netPnl,null,'Never invent Kite brokerage or net P&L');
assert.equal(summary.episodes[0].openedAt,'2026-10-13T11:22:15');
assert.equal(summary.episodes[0].closedAt,'2026-10-13T11:39:58');
state=apply(state,'import',{requestId:'kite_import_0000002',clientId:'TEST123',fills:rows},now);
assert.equal(state.brokerFills.length,4,'Overlapping uploads must be deduped using Kite fill identity');
state=apply(state,'import',{requestId:'kite_import_0000002',clientId:'TEST123',fills:rows},now);
assert.equal(state.brokerFills.length,4,'Retrying same mutation must be idempotent');
assert.throws(()=>apply(state,'import',{requestId:'kite_import_0000003',clientId:'OTHER123',fills:rows},now),/CLIENT_ID_MISMATCH/);
assert.throws(()=>apply(state,'import',{requestId:'kite_import_0000004',clientId:'TEST123',fills:[{...rows[0],price:111}]},now),/DUPLICATE_CONFLICT/);
assert.throws(()=>normalizeFill({...rows[0],symbol:'BANKNIFTY26O1322500CE'}),/INVALID_SYMBOL/);
assert.throws(()=>normalizeFill({...rows[0],time:'2026-10-09T99:10:56'}),/INVALID_EXECUTION_TIME/);
assert.throws(()=>normalizeFill({...rows[0],tradeDate:'2026-10-08'}),/DATE_MISMATCH/);
const partial=base();
importBrokerFills(partial,{clientId:'TEST123',fills:[
  fill('201','buy','2026-10-14T10:00:00',100,65),
  fill('202','sell','2026-10-14T10:02:00',103,20),
  fill('203','sell','2026-10-14T10:05:00',110,45),
  fill('204','sell','2026-10-14T10:07:00',125,65)
]});
const p=summarizeBroker(partial);
assert.equal(p.summary.completedTrades,1,'Partial exits should aggregate into one completed long cycle');
assert.equal(p.summary.unmatchedSellQuantity,65,'Unmatched shorts must not be treated as profit');
assert.equal(p.summary.grossPnl,510);
assert.equal(p.summary.openBuyQuantity,0);
let b=base();
b=apply(b,'open',{requestId:'manual_open_000001',contract:'NIFTY 19 OCT 22500 CE',
 strategy:'LONG_CALL',quantity:65,entry:100,stop:90,estimatedCosts:100},now);
const manualBudget=budget(b,now);
b=apply(b,'import',{requestId:'kite_import_0000005',clientId:'TEST123',fills:rows},now);
assert.deepEqual(budget(b,now),manualBudget,'Historical import must not change active manual reservations');
console.log('Kite import: FIFO matching, history timestamps, account isolation, duplicate safety, zero live-risk impact PASS');
