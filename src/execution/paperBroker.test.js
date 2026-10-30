'use strict';
const assert=require('node:assert/strict');
const {createPaperBroker,memoryBook}=require('./paperBroker');
const {createSandboxService}=require('./sandboxService');
const {control,initialState}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const KEY='NSE_FO|12345';
const BASE=Date.parse('2026-10-30T10:00:00+05:30');

function rig(start=BASE){
  let now=start,quote={bid:99.95,ask:100},quoteUp=true,age=0,beforeWrite=null;
  const quotes={async get(keys){if(!quoteUp)throw Error('down');return keys.includes(KEY)?{[KEY]:{instrumentKey:KEY,...quote,receivedAt:now,exchangeAt:now-age}}:{};}};
  // Storage that can be slowed down: beforeWrite runs (and may move the clock) before each write is applied.
  const inner=memoryBook();
  const book={read:()=>inner.read(),peek:()=>inner.peek(),async mutate(fn){if(beforeWrite){const f=beforeWrite;beforeWrite=null;await f();}return inner.mutate(fn);}};
  const broker=createPaperBroker({quotes,book,now:()=>now});
  return {broker,book,quotes,advance(n=2000){now+=n;},set(q){quote={...quote,...q};},down(){quoteUp=false;},up(){quoteUp=true;},time:()=>now,setTime(t){now=t;},
    quoteAge(ms){age=ms;},delayNextWrite(ms){beforeWrite=async()=>{now+=ms;};}};
}
const order=(o={})=>({instrumentKey:KEY,quantity:65,price:100,side:'BUY',tag:'edgesb_t1',orderType:'LIMIT',trigger:0,...o});

(async()=>{
  // --- Fill rules ---
  {
    const r=rig();
    const ack=await r.broker.placeOrder(order({price:99.5}));
    assert.equal(ack.state,'ACKNOWLEDGED');assert.match(ack.orderId,/^paper-[A-Za-z0-9-]+$/);
    assert.deepEqual(await r.broker.placeOrder(order({price:99.5})),ack,'a retried placement with the same tag returns the same order');
    let [row]=await r.broker.getOrders();
    assert.equal(row.status,'open','buy limit below the ask does not fill');assert.equal(row.filled_quantity,0);
    r.set({bid:99.4,ask:99.45});[row]=await r.broker.getOrders();
    assert.equal(row.status,'complete');assert.equal(row.filled_quantity,65);assert.equal(row.average_price,99.45,'buy fills at the real ask');
    assert.deepEqual(Object.keys(row).sort(),['average_price','filled_quantity','instrument_token','order_id','order_type','placed_at','price','product','quantity','status','tag','transaction_type','trigger_price'].sort());
    assert.deepEqual(await r.broker.getPositions(),[{instrument_token:KEY,quantity:65,product:'I'}]);
    assert.equal((await r.broker.cancel(ack.orderId)).state,'REJECTED','a filled order cannot be cancelled');
  }
  {
    const r=rig();
    await r.broker.placeOrder(order({side:'SELL',orderType:'SL',price:89.5,trigger:90,tag:'edgesb_sl'}));
    let [row]=await r.broker.getOrders();assert.equal(row.status,'trigger pending');
    r.set({bid:88,ask:88.1});[row]=await r.broker.getOrders();
    assert.equal(row.status,'open','a gap below the stop limit triggers but does not fill');assert.equal(row.filled_quantity,0);
    r.set({bid:89.6,ask:89.7});[row]=await r.broker.getOrders();
    assert.equal(row.status,'complete');assert.equal(row.average_price,89.6,'sell fills at the real bid');
  }
  {
    const r=rig();
    await r.broker.placeOrder(order({side:'SELL',price:105,tag:'edgesb_ex'}));
    r.set({bid:104.9,ask:105});let [row]=await r.broker.getOrders();assert.equal(row.status,'open','sell limit needs bid >= limit');
    r.set({bid:105.2,ask:105.3});[row]=await r.broker.getOrders();assert.equal(row.average_price,105.2);
  }
  {
    const r=rig();const ack=await r.broker.placeOrder(order({price:101}));
    r.down();let [row]=await r.broker.getOrders();assert.equal(row.status,'open','no quote, no fill; the read still succeeds');
    r.up();
    const stale={async get(){return {[KEY]:{instrumentKey:KEY,bid:99,ask:99.5,receivedAt:r.time(),exchangeAt:r.time()-11000}};}};
    const staleBroker=createPaperBroker({quotes:stale,book:r.book,now:r.time});
    [row]=await staleBroker.getOrders();assert.equal(row.status,'open','a stale quote never fills');
    assert.equal((await r.broker.cancel(ack.orderId)).state,'ACKNOWLEDGED');
    [row]=await r.broker.getOrders();assert.equal(row.status,'cancelled');
    r.set({bid:90,ask:90.05});[row]=await r.broker.getOrders();assert.equal(row.status,'cancelled','a cancelled order never fills later');
    assert.equal((await r.broker.cancel('paper-unknown')).state,'REJECTED');
  }
  {
    const r=rig(Date.parse('2026-10-30T09:10:00+05:30'));
    assert.equal((await r.broker.placeOrder(order())).state,'REJECTED','no paper orders before 09:15 IST');
    r.setTime(BASE);await r.broker.placeOrder(order({price:101}));
    r.setTime(Date.parse('2026-10-31T10:00:00+05:30'));
    assert.deepEqual(await r.broker.getOrders(),[],'the book rolls daily like a broker book');
    assert.deepEqual(await r.broker.getPositions(),[]);
    await assert.rejects(()=>r.broker.placeOrder(order({price:-1})),/INVALID_SANDBOX_ORDER/);
  }
  // Review regressions (PR #82): session and freshness are re-checked at the moment of the write.
  {
    const r=rig(Date.parse('2026-10-30T15:29:59+05:30'));
    await r.broker.placeOrder(order({price:101}));
    r.delayNextWrite(2000); // the quote read started 15:29:59; the fill write lands at 15:30:01
    let [row]=await r.broker.getOrders();
    assert.equal(row.status,'open','a read that started before the close must not fill after it');assert.equal(row.filled_quantity,0);
  }
  {
    const r=rig(Date.parse('2026-10-30T15:29:59+05:30'));
    r.delayNextWrite(2000);
    const ack=await r.broker.placeOrder(order());
    assert.equal(ack.state,'REJECTED','a placement delayed past the close is rejected, not acknowledged');assert.equal(r.book.peek().orders.length,0);
  }
  {
    const r=rig();await r.broker.placeOrder(order({price:101}));
    r.quoteAge(9000);r.delayNextWrite(2000); // 9s old when fetched, 11s old when the fill would be written
    let [row]=await r.broker.getOrders();
    assert.equal(row.status,'open','the exchange timestamp is re-checked at fill time');
    r.quoteAge(9000);[row]=await r.broker.getOrders();assert.equal(row.status,'complete','a 9s-old quote still fills');
  }
  console.log('Paper broker fill rules PASS (incl. close-time and freshness re-checks)');

  // --- End to end through the sandbox service: entry, protective stop, target exit, P&L ---
  const result=()=>({timestamp:new Date(r.time()).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
    tradeLegs:{buyLeg:{instrumentKey:KEY,contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
    orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
    position:{status:'READY'},risk:{status:'READY',stop:{value:99},target1:{value:104}}}});
  const catalog={async get(){return {instrumentKey:KEY,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-30',lotSize:65,tickSizeRupees:0.05};},status:()=>({ready:true})};
  const r=rig(),store=memoryStore(),alerts=[];
  const service=createSandboxService({ownerToken:'owner-token-for-paper-test',getContext:()=>({analysis:result()}),notify:(k,t)=>alerts.push(t),
    env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies:{store,broker:r.broker,quotes:r.quotes,catalog,now:r.time,bootId:'paper-boot',idleTickMs:0}});
  await service.tick();assert.equal(service.status().reason,null);
  await store.mutate(s=>control(s,'ARM','paper-arm-request-01',r.time()));
  await service.tick();
  let rows=r.book.peek().orders;assert.equal(rows.length,1);assert.equal(rows[0].transaction_type,'BUY');assert.equal(rows[0].price,100);
  r.advance();await service.tick();
  rows=r.book.peek().orders;assert.equal(rows[0].status,'complete','entry fills on the next read at the live ask');
  r.advance();await service.tick();
  rows=r.book.peek().orders;assert.equal(rows.length,2);assert.equal(rows[1].order_type,'SL','protective stop placed after the fill');
  r.set({bid:104.2,ask:104.3});r.advance();await service.tick(); // target reached: cancel the stop
  r.advance();await service.tick(); // then sell at the bid
  r.advance();await service.tick(); // exit fills
  r.advance();await service.tick();
  const state=await store.read(),trade=Object.values(state.trades)[0];
  rows=r.book.peek().orders;
  assert.equal(rows[1].status,'cancelled');assert.equal(rows[2].transaction_type,'SELL');assert.equal(rows[2].status,'complete');
  assert.ok(trade.closedAt,'trade closes from paper fills');assert.equal(trade.exitReason,'TARGET');
  assert.equal(trade.netPnl,Math.round(((104.2-100)*65-100)*100)/100,'P&L = real-quote fills minus friction reserve');
  assert.equal(state.haltReason,null);assert.equal(service.status().broker,'PAPER');
  assert.ok(alerts.some(t=>t.includes('entry filled'))&&alerts.some(t=>t.includes('trade closed')));
  console.log('Paper broker end-to-end PASS: entry fill, stop, target exit, P&L');

  // --- One-time switch: an unfilled Upstox-sandbox order is retired so the account can flatten and re-arm ---
  {
    const r2=rig(),seed=initialState();
    seed.trades.old={id:'old',day:'2026-10-30',createdAt:BASE-1800000,entryExpiresAt:BASE-1785000,instrumentKey:KEY,quantity:65,costReserve:100,exitReason:'KILL_SWITCH',closedAt:null,netPnl:null,buys:0};
    seed.orders.o1={id:'o1',tradeId:'old',kind:'ENTRY',tag:'edgesb_old',instrumentKey:KEY,quantity:65,side:'BUY',orderType:'LIMIT',price:100,trigger:0,
      state:'ACKNOWLEDGED',orderId:'250930000123456',filled:0,averagePrice:0,cancelState:'ACKNOWLEDGED',submittedAt:BASE-1800000};
    seed.haltReason='BROKER_ORDER_MISMATCH';
    const store2=memoryStore(seed);
    const s2=createSandboxService({ownerToken:'owner-token-for-paper-test',getContext:()=>({analysis:result()}),
      env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies:{store:store2,broker:r2.broker,quotes:r2.quotes,catalog,now:r2.time,bootId:'switch-boot',idleTickMs:0}});
    await s2.tick();
    let st=await store2.read();
    assert.equal(st.orders.o1.state,'CANCELLED');assert.equal(st.orders.o1.retired.reason,'UPSTOX_SANDBOX_NEVER_FILLS');
    assert.ok(st.trades.old.closedAt);assert.equal(st.trades.old.buys,0);assert.equal(st.broker,'PAPER');
    await store2.mutate(s=>control(s,'ARM','switch-arm-request-01',r2.time()));
    st=await store2.read();assert.equal(st.armed,true);assert.equal(st.haltReason,null,'re-arming clears the old halt');
    // Round trip PAPER -> UPSTOX_SANDBOX -> PAPER: the Upstox order is retired, the paper order is preserved.
    const engine=require('./sandboxEngine');
    const paperOrder={...st.orders.o1,id:'o2',state:'ACKNOWLEDGED',orderId:'paper-x',cancelState:null};delete paperOrder.retired;
    st.orders.o2=paperOrder;
    assert.equal(engine.adoptBroker(st,'PAPER',r2.time()),0,'staying on PAPER retires nothing');
    assert.equal(engine.adoptBroker(st,'UPSTOX_SANDBOX',r2.time()),0);assert.equal(st.broker,'UPSTOX_SANDBOX');
    st.orders.o3={...paperOrder,id:'o3',orderId:'250930000999'};
    st.orders.o4={...paperOrder,id:'o4',orderId:null,state:'UNCERTAIN'};
    assert.equal(engine.adoptBroker(st,'PAPER',r2.time()),2);
    assert.equal(st.orders.o2.state,'ACKNOWLEDGED','paper orders survive the round trip');
    assert.equal(st.orders.o3.state,'CANCELLED');assert.equal(st.orders.o4.state,'CANCELLED');assert.equal(st.broker,'PAPER');
  }
  // Same round trip through the service: Upstox-sandbox mode leaves a stuck order, PAPER clears it and re-arms.
  {
    const r3=rig(),store3=memoryStore(),mk=(kind,bootId,broker)=>createSandboxService({ownerToken:'owner-token-for-paper-test',getContext:()=>({analysis:result()}),
      env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',...(kind?{EDGE_SANDBOX_BROKER:kind}:{})},dependencies:{store:store3,broker,quotes:r3.quotes,catalog,now:r3.time,bootId,idleTickMs:0}});
    await mk(null,'b1',r3.broker).tick();assert.equal((await store3.read()).broker,'PAPER');
    const fake={async getOrders(){return [];},async getPositions(){return [];},async placeOrder(){return {state:'ACKNOWLEDGED',orderId:'250930000555'};},async cancel(id){return {state:'ACKNOWLEDGED',orderId:id};}};
    r3.advance(31000);const up=mk('UPSTOX_SANDBOX','b2',fake);await up.tick();assert.equal((await store3.read()).broker,'UPSTOX_SANDBOX');
    await store3.mutate(s=>control(s,'ARM','roundtrip-arm-req-01',r3.time()));await up.tick();
    assert.ok(Object.values((await store3.read()).orders).some(o=>o.orderId==='250930000555'),'an order went to the Upstox sandbox');
    r3.advance();await up.tick(); // the order is missing from its book: halt, as on 30 Oct
    r3.advance(31000);const back=mk(null,'b3',r3.broker);await back.tick();
    const st=await store3.read();assert.equal(st.broker,'PAPER');assert.ok(Object.values(st.trades).every(t=>t.closedAt));
    await store3.mutate(s=>control(s,'ARM','roundtrip-arm-req-02',r3.time()));assert.equal((await store3.read()).armed,true,'re-arms after PAPER -> UPSTOX_SANDBOX -> PAPER');
  }
  // Lost acknowledgement + broker round trip (review of 148dc1a): the paper book has the order but EDGE has no id.
  // The broker recorded at submission keeps it from being retired; it is then found by tag and its fill is booked.
  {
    const r4=rig(),store4=memoryStore();let loseAck=false;
    const lossy={...r4.broker,async placeOrder(o){const res=await r4.broker.placeOrder(o);if(loseAck){loseAck=false;store4.failNext();}return res;}};
    const mk=(kind,bootId,broker)=>createSandboxService({ownerToken:'owner-token-for-paper-test',getContext:()=>({analysis:{...result(),timestamp:new Date(r4.time()).toISOString()}}),
      env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',...(kind?{EDGE_SANDBOX_BROKER:kind}:{})},dependencies:{store:store4,broker,quotes:r4.quotes,catalog,now:r4.time,bootId,idleTickMs:0}});
    const first=mk(null,'l1',lossy);await first.tick();
    await store4.mutate(s=>control(s,'ARM','lost-ack-paper-arm-1',r4.time()));loseAck=true;await first.tick();
    assert.equal(r4.book.peek().orders.length,1,'the paper book committed the order');
    let entry=Object.values((await store4.read()).orders)[0];assert.equal(entry.orderId,null,'EDGE lost the acknowledgement');assert.equal(entry.broker,'PAPER');
    const fake={async getOrders(){return [];},async getPositions(){return [];},async placeOrder(){return {state:'ACKNOWLEDGED',orderId:'250930000777'};},async cancel(id){return {state:'ACKNOWLEDGED',orderId:id};}};
    r4.advance(31000);await mk('UPSTOX_SANDBOX','l2',fake).tick();
    r4.advance(31000);const back=mk(null,'l3',r4.broker);await back.tick();
    entry=Object.values((await store4.read()).orders)[0];
    assert.notEqual(entry.state,'CANCELLED','a paper order with a lost ACK is not retired by the switch');assert.equal(entry.retired,undefined);
    r4.set({bid:99.9,ask:99.95});r4.advance();await back.tick();
    const st=await store4.read();entry=Object.values(st.orders).find(o=>o.kind==='ENTRY');
    assert.equal(entry.filled,65,'the fill is found by tag and booked');assert.match(entry.orderId,/^paper-/);
    assert.notEqual(st.haltReason,'BROKER_STATUS_REGRESSION');
  }
  console.log('Paper broker switch PASS: stuck Upstox-sandbox order retired once, account re-arms');
})().catch(e=>{console.error(e);process.exit(1);});
