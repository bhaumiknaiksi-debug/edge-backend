'use strict';
const assert=require('node:assert/strict');
const {createPaperBroker,memoryBook}=require('./paperBroker');
const {createSandboxService}=require('./sandboxService');
const {control,initialState}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const KEY='NSE_FO|12345';
const BASE=Date.parse('2026-10-30T10:00:00+05:30');

function rig(start=BASE){
  let now=start,quote={bid:99.95,ask:100},quoteUp=true;
  const quotes={async get(keys){if(!quoteUp)throw Error('down');return keys.includes(KEY)?{[KEY]:{instrumentKey:KEY,...quote,receivedAt:now}}:{};}};
  const book=memoryBook();
  const broker=createPaperBroker({quotes,book,now:()=>now});
  return {broker,book,quotes,advance(n=2000){now+=n;},set(q){quote={...quote,...q};},down(){quoteUp=false;},up(){quoteUp=true;},time:()=>now,setTime(t){now=t;}};
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
    const stale={async get(){return {[KEY]:{instrumentKey:KEY,bid:99,ask:99.5,receivedAt:r.time()-11000}};}};
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
  console.log('Paper broker fill rules PASS');

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
    // The switch runs once: a later unfilled paper order is never retired by it.
    st.orders.o2={...st.orders.o1,id:'o2',state:'ACKNOWLEDGED',orderId:'paper-x'};delete st.orders.o2.retired;
    const engine=require('./sandboxEngine');assert.equal(engine.adoptPaperBroker(st,r2.time()),0);
  }
  console.log('Paper broker switch PASS: stuck Upstox-sandbox order retired once, account re-arms');
})().catch(e=>{console.error(e);process.exit(1);});
