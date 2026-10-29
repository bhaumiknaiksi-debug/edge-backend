'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {createSandboxService}=require('./sandboxService');
const {control}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
const OWNER='sandbox-owner-test-token';
function setup(shared){
 let now=BASE,quote={instrumentKey:'NSE_FO|12345',bid:99.95,ask:100};
 const store=shared||memoryStore(),rows=[],calls=[];
 let loseAck=false;
 const result={timestamp:new Date(BASE).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
  tradeLegs:{buyLeg:{instrumentKey:'NSE_FO|12345',contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
  orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
  position:{status:'READY'},risk:{status:'READY',stop:{value:99},target1:{value:104}}}};
 const broker={
  async getOrders(){calls.push('book');return structuredClone(rows);},
  async getPositions(){calls.push('positions');const net=rows.reduce((a,o)=>a+(o.transaction_type==='BUY'?o.filled_quantity:-o.filled_quantity),0);return net?[{instrument_token:'NSE_FO|12345',quantity:net,product:'I'}]:[];},
  async placeOrder(o){calls.push('place:'+o.kind);const id='broker-'+(rows.length+1);rows.push({order_id:id,tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:o.orderType,status:'open',filled_quantity:0,average_price:0});if(loseAck){loseAck=false;store.failNext();}return {state:'ACKNOWLEDGED',orderId:id};},
  async cancel(id){calls.push('cancel');rows.find(o=>o.order_id===id).status='cancelled';return {state:'ACKNOWLEDGED',orderId:id};}
 };
 const dependencies={store,broker,now:()=>now,bootId:'one',idleTickMs:0,catalog:{async get(){return {instrumentKey:'NSE_FO|12345',underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-28',lotSize:65,tickSizeRupees:0.05};},status:()=>({ready:true})},quotes:{async get(keys){calls.push('quotes:'+keys.join(','));return keys.includes(quote.instrumentKey)?{[quote.instrumentKey]:{...quote,receivedAt:now}}:{};}}};
 const service=createSandboxService({ownerToken:OWNER,getContext:()=>({analysis:result}),env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies});
 return {service,store,rows,calls,result,dependencies,advance(n=1000){now+=n;},setQuote(q){quote={...quote,...q};},loseNextAck(){loseAck=true;},time:()=>now};
}
(async()=>{
 const disabled=createSandboxService({env:{UPSTOX_ACCESS_TOKEN:'not-a-sandbox-token'},getContext:()=>{throw Error('must not run');}});
 await disabled.tick();assert.equal(disabled.status().reason,'DISABLED');
 const missing=createSandboxService({pool:{},ownerToken:OWNER,env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'data-token'}});
 assert.equal(missing.status().reason,'SANDBOX_TOKEN_REQUIRED','market data credentials never authorize sandbox orders');
 const malformed=createSandboxService({pool:{},ownerToken:OWNER,env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',EDGE_UPSTOX_SANDBOX_TOKEN:'bad\ntoken',UPSTOX_ACCESS_TOKEN:'data-token'}});
 assert.equal(malformed.status().reason,'SANDBOX_TOKEN_REQUIRED','bad optional config must not crash the main backend');
 const f=setup(),app=express();app.use(express.json());f.service.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+server.address().port+'/api/v1/execution/sandbox';
 const post=(name,requestId,headers={Authorization:'Bearer '+OWNER})=>fetch(url+'/'+name,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({requestId,confirmSandbox:true})});
 try{
  assert.equal((await post('arm','arm-request-00001',{})).status,401);
  const panel=await fetch(url+'/control');assert.equal(panel.status,200);assert.ok(panel.headers.get('content-security-policy').includes("script-src 'self'"));assert.ok((await panel.text()).includes('Real-money trading is disabled'));
  const publicBody=await (await fetch(url+'/status')).text();assert.ok(!publicBody.includes(OWNER));assert.ok(publicBody.includes('SANDBOX'));
  const policy=await fetch(url+'/policy',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+OWNER},body:JSON.stringify({requestId:'policy-http-request-1',confirmSandbox:true,dailyGoal:2000,dailyLoss:500})});
  assert.equal(policy.status,200);assert.equal((await policy.json()).dailyLossGoalRatio,0.25);
  assert.equal((await post('arm','arm-request-00001')).status,409,'fresh broker reconciliation precedes arming');
  await f.service.tick();assert.equal((await post('arm','arm-request-00001')).status,200);
  const whileArmed=await fetch(url+'/policy',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+OWNER},body:JSON.stringify({requestId:'policy-http-request-2',confirmSandbox:true,dailyGoal:1000,dailyLoss:500})});assert.equal(whileArmed.status,409);
  await f.service.tick();assert.equal(f.rows.length,1);assert.equal(f.calls.filter(x=>x.startsWith('place')).length,1);
  const peer=createSandboxService({ownerToken:OWNER,env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies:{...f.dependencies,bootId:'peer'},getContext:()=>({analysis:f.result})});
  await peer.tick();assert.equal(peer.status().reason,'ANOTHER_WORKER_ACTIVE');assert.equal(f.rows.length,1);
  Object.assign(f.rows[0],{filled_quantity:20,average_price:100});f.advance();await f.service.tick();assert.equal(f.rows[0].status,'cancelled');
  f.advance();await f.service.tick();assert.equal(f.rows.length,2);assert.equal(f.rows[1].order_type,'SL');assert.equal(f.rows[1].quantity,20);
  f.setQuote({bid:105,ask:105.05});f.advance();await f.service.tick();assert.equal(f.rows[1].status,'cancelled');assert.equal(f.rows.length,2);
  f.advance();await f.service.tick();assert.equal(f.rows.length,3);assert.equal(f.rows[2].transaction_type,'SELL');assert.equal(f.rows[2].quantity,20);
  Object.assign(f.rows[2],{status:'complete',filled_quantity:20,average_price:105});f.advance();await f.service.tick();assert.ok(Object.values((await f.store.read()).trades)[0].closedAt);
  assert.equal(f.rows.length,3);assert.equal((await post('stop','stop-request-00001')).status,200);
  assert.equal((await (await post('arm','arm-request-00001')).json()).armed,false,'a retried earlier ARM cannot undo STOP');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 const quoteFailure=setup();await quoteFailure.service.tick();await quoteFailure.store.mutate(s=>control(s,'ARM','quote-failure-arm-01',quoteFailure.time()));await quoteFailure.service.tick();
 quoteFailure.dependencies.quotes.get=async()=>{throw Error('quote error');};await quoteFailure.store.mutate(s=>control(s,'STOP','quote-failure-stop-1',quoteFailure.time()));quoteFailure.advance();await quoteFailure.service.tick();assert.equal(quoteFailure.rows[0].status,'cancelled','quote outage cannot prevent cancelling an unfilled entry');
 const bookFailure=setup();await bookFailure.service.tick();await bookFailure.store.mutate(s=>control(s,'ARM','book-failure-arm-01',bookFailure.time()));await bookFailure.service.tick();
 bookFailure.dependencies.broker.getOrders=async()=>{const e=Error('private details');e.httpStatus=404;throw e;};await bookFailure.store.mutate(s=>control(s,'STOP','book-failure-stop-1',bookFailure.time()));bookFailure.advance();await bookFailure.service.tick();assert.equal(bookFailure.rows[0].status,'cancelled','kill still cancels a known entry during a broker read outage');
 assert.deepEqual(bookFailure.service.status().brokerReads,{orders:{ok:false,httpStatus:404},positions:{ok:true}});
 assert.ok(!JSON.stringify(bookFailure.service.status()).includes('private details'));
 const missingPositions=setup();missingPositions.dependencies.broker.getPositions=async()=>{const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=404;throw e;};
 await missingPositions.service.tick();assert.equal(missingPositions.service.status().positionBasis,'SANDBOX_ORDER_BOOK_DERIVED');
 assert.equal(missingPositions.service.status().reason,null);assert.equal((await missingPositions.store.read()).armed,false);
 await missingPositions.store.mutate(s=>control(s,'ARM','derived-arm-request-1',missingPositions.time()));await missingPositions.service.tick();
 assert.equal(missingPositions.rows.length,1);Object.assign(missingPositions.rows[0],{status:'complete',filled_quantity:65,average_price:100});
 missingPositions.advance();await missingPositions.service.tick();assert.equal(missingPositions.rows[1].order_type,'SL');assert.equal(missingPositions.rows[1].quantity,65);
 const badPositions=setup();badPositions.dependencies.broker.getPositions=async()=>{const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=401;throw e;};
 await badPositions.service.tick();assert.equal(badPositions.service.status().reason,'SANDBOX_READ_UNAVAILABLE');assert.equal(badPositions.service.status().positionBasis,null);
 const foreign=setup();await foreign.service.tick();foreign.rows.push({order_id:'foreign',status:'complete'});foreign.dependencies.broker.getPositions=missingPositions.dependencies.broker.getPositions;
 await foreign.service.tick();assert.equal(foreign.service.status().reason,'UNMANAGED_SANDBOX_ORDER');
 await assert.rejects(()=>foreign.store.mutate(s=>control(s,'ARM','foreign-arm-request-1',foreign.time())),/FRESH_RECONCILIATION_REQUIRED/);
 const lost=setup();await lost.service.tick();await lost.store.mutate(s=>control(s,'ARM','lost-ack-arm-00001',lost.time()));lost.loseNextAck();await lost.service.tick();
 assert.equal(lost.rows.length,1);assert.equal(lost.service.status().reason,'STORE_WRITE_FAILED');
 lost.advance();await lost.service.tick();assert.equal(lost.rows.length,1,'lost persistence ACK must not place a duplicate');
 lost.advance(31000);
 const restarted=createSandboxService({ownerToken:OWNER,env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies:{...lost.dependencies,bootId:'restarted'},getContext:()=>({analysis:lost.result})});
 await restarted.tick();assert.equal(lost.rows.length,1);assert.equal(lost.rows[0].status,'cancelled');
 const state=await lost.store.read();assert.equal(state.armed,false);assert.equal(state.killed,true);
 console.log('Sandbox service/HTTP PASS: auth, startup disarm, partial-fill-to-stop-to-exit, worker lease, kill command replay, failed ACK persistence and restart without duplicate orders');
})().catch(e=>{console.error(e);process.exitCode=1;});
