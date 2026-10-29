'use strict';
// Broker read failures: brief outages while flat are retried, not halted; auth failures and any failure while
// exposed still halt at once; wasted broker calls (404 positions, disarmed polling) are reduced.
const assert=require('node:assert/strict');
const {createSandboxService}=require('./sandboxService');
const {control}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-10-29T12:00:00+05:30');
function setup(extra={}){
 let now=BASE;const store=memoryStore(),rows=[],calls={book:0,positions:0,place:0,cancel:0};
 const result=()=>({timestamp:new Date(now).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
  tradeLegs:{buyLeg:{instrumentKey:'NSE_FO|12345',contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
  orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
  position:{status:'READY'},risk:{status:'READY',stop:{value:99},target1:{value:104}}}});
 let failOrders=null,failPositions=404;
 const fail=code=>{const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=code;throw e;};
 const broker={
  async getOrders(){calls.book++;if(failOrders!==null)fail(failOrders);return structuredClone(rows);},
  async getPositions(){calls.positions++;if(failPositions!==null)fail(failPositions);return [];},
  async placeOrder(o){calls.place++;const id='b'+(rows.length+1);rows.push({order_id:id,tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,
   trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:o.orderType,status:'open',filled_quantity:0,average_price:0});return {state:'ACKNOWLEDGED',orderId:id};},
  async cancel(id){calls.cancel++;rows.find(o=>o.order_id===id).status='cancelled';return {state:'ACKNOWLEDGED',orderId:id};}};
 const service=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({analysis:result()}),
  dependencies:{store,broker,now:()=>now,bootId:'one',
   catalog:{async get(){return {instrumentKey:'NSE_FO|12345',underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-29',lotSize:65,tickSizeRupees:0.05};},status:()=>({ready:true})},
   quotes:{async get(keys){return Object.fromEntries(keys.map(k=>[k,{instrumentKey:k,bid:99.95,ask:100,receivedAt:now}]));}},...extra}});
 return {service,store,rows,calls,advance(ms=2000){now+=ms;},time:()=>now,failOrders(c){failOrders=c;},failPositions(c){failPositions=c;}};
}
const arm=async(f,id)=>f.store.mutate(s=>control(s,'ARM',id,f.time()));
(async()=>{
 // 1. Armed and flat: a brief order-book outage pauses entries without halting, and trading resumes after it.
 {
  const f=setup({idleTickMs:0});await f.service.tick();await arm(f,'flat-blip-arm-00001');
  f.failOrders(500);f.advance();await f.service.tick();
  let s=await f.store.read();
  assert.equal(s.armed,true,'flat account stays armed through a brief read outage');
  assert.equal(s.haltReason,null);
  assert.equal(f.calls.place,0,'no entry is sent while the broker cannot be read');
  const st=f.service.status();
  assert.equal(st.reason,'SANDBOX_READ_UNAVAILABLE');assert.ok(st.readFailingSince);
  assert.deepEqual(st.lastReadFailure.orders,{ok:false,httpStatus:500},'the failing HTTP code is kept for diagnosis');
  f.advance(30000);await f.service.tick();assert.equal((await f.store.read()).armed,true,'still inside the 60s grace');
  f.failOrders(null);f.advance();await f.service.tick();
  s=await f.store.read();
  assert.equal(f.service.status().reason,null);assert.equal(f.service.status().readFailingSince,null);
  assert.equal(f.service.status().lastReadFailure.orders.httpStatus,500,'last failure stays visible after recovery');
  assert.equal(f.calls.place,1,'entries resume once reads recover');
 }
 // 2. Flat but the outage outlasts the grace window: halt and disarm.
 {
  const f=setup({idleTickMs:0});await f.service.tick();
  f.failOrders(503);f.advance();await f.service.tick();
  f.advance(59000);await f.service.tick();assert.equal((await f.store.read()).haltReason,null);
  f.advance(2000);await f.service.tick();
  const s=await f.store.read();assert.equal(s.haltReason,'SANDBOX_READ_UNAVAILABLE');assert.equal(s.armed,false);
 }
 // 3. Expired or rejected credentials halt at once, flat or not.
 for(const code of [401,403]){
  const f=setup({idleTickMs:0});await f.service.tick();await arm(f,'auth-fail-arm-0000'+code);
  f.failOrders(code);f.advance();await f.service.tick();
  const s=await f.store.read();assert.equal(s.haltReason,'SANDBOX_READ_UNAVAILABLE',code+' halts immediately');assert.equal(s.armed,false);
 }
 // 4. Exposed (a working entry order): any read failure still halts at once and cancels the known entry.
 {
  const f=setup({idleTickMs:0});await f.service.tick();await arm(f,'exposed-fail-arm-001');
  f.advance();await f.service.tick();assert.equal(f.rows.length,1,'entry placed');
  f.failOrders(500);f.advance();await f.service.tick();
  const s=await f.store.read();assert.equal(s.haltReason,'SANDBOX_READ_UNAVAILABLE');assert.equal(s.armed,false);
  assert.equal(f.rows[0].status,'cancelled','emergency cancel still runs');
 }
 // 5. Positions endpoint answering 404 is probed once, then skipped until the retry window passes.
 {
  const f=setup({idleTickMs:0,positionsRetryMs:300000});
  await f.service.tick();f.advance();await f.service.tick();f.advance();await f.service.tick();
  assert.equal(f.calls.positions,1,'404 positions endpoint is not re-requested every tick');
  assert.equal(f.service.status().positionBasis,'SANDBOX_ORDER_BOOK_DERIVED');assert.equal(f.service.status().reason,null);
  f.advance(300000);await f.service.tick();assert.equal(f.calls.positions,2,'re-probed after the retry window');
  f.failPositions(null);f.advance(300000);await f.service.tick();f.advance();await f.service.tick();
  assert.equal(f.calls.positions,4,'once positions answer, they are read every tick again');
  assert.equal(f.service.status().positionBasis,'BROKER_POSITIONS');
 }
 // 6. Disarmed and flat: broker reads slow to once per idle interval; arming is picked up on the next tick.
 {
  const f=setup({idleTickMs:5000});
  await f.service.tick();const first=f.calls.book;
  f.advance(2000);await f.service.tick();f.advance(2000);await f.service.tick();
  assert.equal(f.calls.book,first,'no broker reads within the idle interval');
  f.advance(2000);await f.service.tick();assert.equal(f.calls.book,first+1,'read again once the interval passes');
  await arm(f,'idle-then-arm-000001');
  f.advance(1000);await f.service.tick();assert.equal(f.calls.book,first+2,'armed: reads every tick');
  assert.equal(f.calls.place,1,'entry placed right after arming');
 }
 console.log('sandboxReadTolerance PASS: flat blips retried, entries paused, grace expiry halts, auth and exposed failures halt at once, 404 positions skipped, idle polling slowed');
})().catch(e=>{console.error(e);process.exit(1);});
