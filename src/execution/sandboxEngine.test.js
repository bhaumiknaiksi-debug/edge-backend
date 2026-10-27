'use strict';
const assert=require('node:assert/strict');
const E=require('./sandboxEngine');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
function fixture(){
  const state=E.initialState();E.recover(state,'boot');E.reconcile(state,[],[],BASE);E.control(state,'ARM','arm-request-000001',BASE);
  const result={timestamp:new Date(BASE).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
    tradeLegs:{buyLeg:{instrumentKey:'NSE_FO|12345',contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
    orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
    position:{status:'READY'},risk:{status:'READY',stop:{value:99},target1:{value:104}}}};
  const quote={instrumentKey:'NSE_FO|12345',bid:99.95,ask:100,receivedAt:BASE};
  const meta={instrumentKey:quote.instrumentKey,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:result.expiry,session:'2026-10-28',lotSize:65,tickSizeRupees:0.05};
  return {state,result,quote,meta};
}
const orderRows=s=>Object.values(s.orders).filter(o=>o.orderId).map(o=>({order_id:o.orderId,tag:o.tag,instrument_token:o.instrumentKey,
  quantity:o.quantity,price:o.price,trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:o.orderType,status:o.state==='COMPLETE'?'complete':o.state==='CANCELLED'?'cancelled':o.orderType==='SL'?'trigger pending':'open',filled_quantity:o.filled,average_price:o.averagePrice}));
const positions=(instrument,quantity)=>quantity?[{instrument_token:instrument,quantity,product:'I'}]:[];
function open(f){assert.equal(E.planEntry(f.state,f.result,f.quote,f.meta,BASE),'QUEUED');const action=E.claim(f.state,BASE);E.finish(f.state,action,{state:'ACKNOWLEDGED',orderId:'entry-1'});return f.state.orders[action.order.id];}
{
 const f=fixture(),original=JSON.stringify(f.result),entry=open(f);assert.equal(JSON.stringify(f.result),original);
 let rows=orderRows(f.state);rows[0].filled_quantity=20;rows[0].average_price=100;
 E.reconcile(f.state,rows,positions(entry.instrumentKey,20),BASE+1000);E.manage(f.state,{[entry.instrumentKey]:{...f.quote,receivedAt:BASE+1000}},BASE+1000);
 let action=E.claim(f.state,BASE+1000);assert.equal(action.action,'CANCEL');E.finish(f.state,action,{state:'ACKNOWLEDGED'});
 assert.equal(Object.values(f.state.orders).length,1,'cancel ACK does not establish the final filled quantity');
 rows[0].status='cancelled';E.reconcile(f.state,rows,positions(entry.instrumentKey,20),BASE+2000);
 E.manage(f.state,{[entry.instrumentKey]:{...f.quote,receivedAt:BASE+2000}},BASE+2000);
 action=E.claim(f.state,BASE+2000);assert.equal(action.order.kind,'STOP');assert.equal(action.order.quantity,20);E.finish(f.state,action,{state:'ACKNOWLEDGED',orderId:'stop-1'});
 rows=orderRows(f.state);E.reconcile(f.state,rows,positions(entry.instrumentKey,20),BASE+3000);
 E.manage(f.state,{[entry.instrumentKey]:{...f.quote,bid:105,ask:105.05,receivedAt:BASE+3000}},BASE+3000);
 action=E.claim(f.state,BASE+3000);assert.equal(action.action,'CANCEL');E.finish(f.state,action,{state:'ACKNOWLEDGED'});
 E.reconcile(f.state,rows,positions(entry.instrumentKey,20),BASE+4000);
 E.manage(f.state,{[entry.instrumentKey]:{...f.quote,bid:105,ask:105.05,receivedAt:BASE+4000}},BASE+4000);
 assert.equal(Object.values(f.state.orders).filter(o=>o.kind==='EXIT').length,0,'protective stop must actually be cancelled before another SELL');
 rows.find(o=>o.order_id==='stop-1').status='cancelled';E.reconcile(f.state,rows,positions(entry.instrumentKey,20),BASE+5000);
 E.manage(f.state,{[entry.instrumentKey]:{...f.quote,bid:105,ask:105.05,receivedAt:BASE+5000}},BASE+5000);
 action=E.claim(f.state,BASE+5000);assert.equal(action.order.kind,'EXIT');assert.equal(action.order.quantity,20);E.finish(f.state,action,{state:'ACKNOWLEDGED',orderId:'exit-1'});
 rows=orderRows(f.state);const exit=rows.find(o=>o.order_id==='exit-1');Object.assign(exit,{status:'complete',filled_quantity:20,average_price:105});
 E.reconcile(f.state,rows,[],BASE+6000);assert.equal(Object.values(f.state.trades)[0].netPnl,0);assert.ok(Object.values(f.state.trades)[0].closedAt);
 assert.equal(E.planEntry(f.state,{...f.result,timestamp:new Date(BASE+6000).toISOString()},{...f.quote,receivedAt:BASE+6000},f.meta,BASE+6000),'SIGNAL_ALREADY_CONSUMED');
}
{
 const f=fixture(),entry=open(f);let rows=orderRows(f.state);Object.assign(rows[0],{status:'complete',filled_quantity:65,average_price:100});
 E.reconcile(f.state,rows,positions(entry.instrumentKey,65),BASE+1000);E.manage(f.state,{[entry.instrumentKey]:{...f.quote,receivedAt:BASE+1000}},BASE+1000);
 let action=E.claim(f.state,BASE+1000);E.finish(f.state,action,{state:'ACKNOWLEDGED',orderId:'stop-1'});
 E.control(f.state,'STOP','stop-request-00001',BASE+2000);rows=orderRows(f.state);
 E.reconcile(f.state,rows,positions(entry.instrumentKey,65),BASE+2000);E.manage(f.state,{[entry.instrumentKey]:{...f.quote,receivedAt:BASE+2000}},BASE+2000);
 action=E.claim(f.state,BASE+2000);E.finish(f.state,action,{state:'ACKNOWLEDGED'});
 // Stop fills while cancellation is in flight. No second SELL may be sent.
 Object.assign(rows.find(o=>o.order_id==='stop-1'),{status:'complete',filled_quantity:65,average_price:90});
 E.reconcile(f.state,rows,[],BASE+3000);E.manage(f.state,{[entry.instrumentKey]:f.quote},BASE+3000);
 assert.equal(E.claim(f.state,BASE+3000),null);assert.equal(Object.values(f.state.trades)[0].netPnl,-750);assert.ok(f.state.lockedDays.includes('2026-10-28'));
}
{
 const f=fixture();assert.equal(E.planEntry(f.state,f.result,f.quote,f.meta,BASE),'QUEUED');let action=E.claim(f.state,BASE);
 E.finish(f.state,action,{state:'UNCERTAIN'});E.recover(f.state,'restart');assert.equal(E.claim(f.state,BASE),null);
 const o=f.state.orders[action.order.id];const row={order_id:'recovered',tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:'LIMIT',status:'open',filled_quantity:0,average_price:0};
 E.reconcile(f.state,[row],[],BASE+2000);assert.equal(o.orderId,'recovered');assert.equal(o.state,'OPEN');assert.equal(Object.values(f.state.orders).length,1);
 E.manage(f.state,{[o.instrumentKey]:{...f.quote,receivedAt:BASE+2000}},BASE+2000);action=E.claim(f.state,BASE+2000);assert.equal(action.action,'CANCEL');
}
{
 const f=fixture();assert.equal(E.planEntry(f.state,{...f.result,decision:{...f.result.decision,signalTier:{tier:'C'}}},f.quote,f.meta,BASE),'BACKEND_NOT_READY');
 assert.equal(E.planEntry(f.state,f.result,f.quote,{...f.meta,session:'2026-10-27'},BASE),'INSTRUMENT_METADATA_REQUIRED');
 assert.equal(E.planEntry(f.state,f.result,{...f.quote,receivedAt:BASE-11000},f.meta,BASE),'FRESH_QUOTE_REQUIRED');
 assert.equal(E.planEntry(f.state,f.result,f.quote,{...f.meta,lotSize:1000},BASE),'RISK_LIMIT');
 assert.throws(()=>E.reconcile(f.state,[],positions('foreign',1),BASE),/BROKER_POSITION_MISMATCH/);
 E.control(f.state,'STOP','stop-request-00002',BASE);E.control(f.state,'ARM','arm-request-000001',BASE);assert.equal(f.state.armed,false,'replayed ARM command cannot undo a later STOP');
}
{
 const f=fixture(),entry=open(f),rows=orderRows(f.state);Object.assign(rows[0],{status:'complete',filled_quantity:65,average_price:100});
 E.reconcile(f.state,rows,null,BASE+1000,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'});
 assert.equal(f.state.positionBasis,'SANDBOX_ORDER_BOOK_DERIVED');assert.equal(entry.filled,65);
 E.manage(f.state,{[entry.instrumentKey]:{...f.quote,receivedAt:BASE+1000}},BASE+1000);
 const stop=E.claim(f.state,BASE+1000);assert.equal(stop.order.quantity,65,'stop uses broker-reported fills');
 E.finish(f.state,stop,{state:'ACKNOWLEDGED',orderId:'stop-derived'});rows.push(orderRows(f.state).find(o=>o.order_id==='stop-derived'));
 assert.throws(()=>E.reconcile(f.state,[...rows,{order_id:'foreign',status:'complete'}],null,BASE+2000,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'}),/UNMANAGED_SANDBOX_ORDER/);
 assert.throws(()=>E.reconcile(f.state,rows,null,BASE+86400000,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'}),/PRIOR_DAY_EXPOSURE_UNVERIFIED/);
}
console.log('Sandbox engine PASS: partial fills, derived-position safety, cancel/stop-fill race, net exits, restart ambiguity and daily loss latch');
module.exports={fixture,orderRows,positions};
