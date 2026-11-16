'use strict';
const assert=require('node:assert/strict');
const {selectAutopilot,MODE}=require('./autopilot');
const {VERSION,FAMILIES}=require('../research/impulseReaper');
const {createSandboxService}=require('./sandboxService');
const {createPaperBroker,memoryBook}=require('./paperBroker');
const {initialState,control}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-11-17T10:00:00+05:30'),DAY='2026-11-17',iso=t=>new Date(t).toISOString(),KEY='NSE_FO|12345';
const event=(direction='UP',id='a'.repeat(64),family=FAMILIES[0])=>{
 const type=direction==='UP'?'CE':'PE',strategy=type==='CE'?'LONG_CALL':'LONG_PUT';
 return {eventId:id,session:DAY,family,direction,confirmedAt:iso(BASE),timestamp:iso(BASE),
  candleClosedAt:iso(BASE-100000),firstSeenAt:iso(BASE-60000),level:25000,
  strategyVersion:VERSION,sourceRuleVersion:'rule|'+VERSION,confirmation:'TWO_MATCHING_CAUSAL_WINDOWS_60S_APART',evidence:{medianRange:4},
  candidateQuotes:[{tier:'C',strategy,expiry:DAY,contractId:'NIFTY TEST '+type,instrumentKey:KEY,type,strike:25000,lotSize:65,
   ask:100,bid:99.5,analysisAt:iso(BASE),observedAt:iso(BASE)}]};
};
const e=event(),q=e.candidateQuotes[0];
const batch={configured:true,publishedAt:iso(BASE),events:[e]};
const analysis=(t=BASE)=>({timestamp:iso(t),spot:25004,expiry:DAY,market:{phase:'OPEN'},decision:{ruleSpec:{implementationHash:'rule'},
 researchCandidatePlans:{plans:{C:{available:true,strategy:q.strategy,legs:{lotSize:65,buyLeg:{...q}}}}}}});
const pick=(a=analysis(),b=batch,t=BASE)=>selectAutopilot({...a,autopilotBatch:b},t);
assert.equal(pick().source,'AUTOPILOT_PAPER');
assert.equal(pick().tier,'C');
assert.equal(pick().identity,e.eventId);
assert.deepEqual(pick().exitPlan({price:100,down:x=>x}),{stop:92,target:108});
assert.equal(pick(analysis(BASE+16000),batch,BASE+16000).reason,'AUTOPILOT_STALE');
assert.equal(pick({...analysis(),spot:24999}).reason,'AUTOPILOT_NO_MATCHING_FRESH_CARD');
assert.equal(pick({...analysis(),spot:25010}).reason,'AUTOPILOT_NO_MATCHING_FRESH_CARD');
assert.equal(pick(analysis(),{...batch,events:[e,event('DOWN','b'.repeat(64),FAMILIES[1])]}).reason,'AUTOPILOT_DIRECTION_CONFLICT');
assert.equal(pick(analysis(),{...batch,events:[e,e]}).reason,'AUTOPILOT_DUPLICATE_EVENT');
assert.equal(pick(analysis(),{...batch,events:[{...e,family:'FUTURES_VWAP_PULLBACK'}]}).reason,'AUTOPILOT_NO_CONFIRMED_EVENT');
const changed=analysis();changed.decision.researchCandidatePlans.plans.C.legs.buyLeg.contractId='ROTATED';
assert.equal(pick(changed).reason,'AUTOPILOT_NO_MATCHING_FRESH_CARD');
(async()=>{
 let now=BASE,price=100;
 const quotes={get:async keys=>keys.includes(KEY)?{[KEY]:{instrumentKey:KEY,bid:price-.05,ask:price,receivedAt:now,exchangeAt:now}}:{}};
 const book=memoryBook(),broker=createPaperBroker({quotes,book,now:()=>now});
 const s=initialState();Object.assign(s.policy,{entryMode:MODE,perTradeRisk:1000,dailyLoss:1000,limitMode:'RECORD_ONLY'});
 const store=memoryStore(s),mutate=store.mutate.bind(store);
 store.mutate=(f,opts={})=>mutate(state=>f(state,opts.guardianSnapshot?[]:undefined));
 const catalog={get:async key=>key===KEY?{instrumentKey:KEY,underlying:'NIFTY',optionType:'CE',strike:25000,expiry:DAY,session:DAY,lotSize:65,tickSizeRupees:.05}:null,status:()=>({ready:true})};
 const env={EDGE_SANDBOX_EXECUTION_ENABLED:'true',EDGE_MONTHLY_GUARDIAN_ENABLED:'true',EDGE_AUTOPILOT_PAPER_ENABLED:'true',EDGE_TIMING_LAB_ENABLED:'true',EDGE_IMPULSE_REAPER_ENABLED:'true'};
 const service=createSandboxService({ownerToken:'owner-test',env,getContext:()=>({analysis:analysis(now),autopilotBatch:batch}),dependencies:{store,broker,quotes,catalog,now:()=>now,bootId:'auto-test',idleTickMs:0}});
 await service.tick();assert.equal(service.status().autopilotConfigured,true);
 assert.equal(book.peek().orders.length,0,'no auto-arm');
 await store.mutate(state=>control(state,'ARM','autopilot-test-arm-1',now));
 await service.tick();assert.equal(book.peek().orders.length,1);
 now+=1000;await service.tick();assert.equal(book.peek().orders[0].status,'complete');
 now+=1000;await service.tick();assert.equal(book.peek().orders[1].order_type,'SL');
 price=108.25;
 for(let i=0;i<5;i++){now+=1000;await service.tick();}
 const state=await store.read(),trade=Object.values(state.trades)[0];
 assert.ok(trade.closedAt);assert.equal(trade.exitReason,'TARGET');assert.equal(trade.entrySource,'AUTOPILOT_PAPER');
 assert.equal(trade.anchor.eventId,e.eventId);assert.equal(trade.anchor.family,FAMILIES[0]);assert.equal(trade.netPnl,433);
 assert.equal(state.monthlyGuardian.realizedPaise,43300);
 assert.equal(book.peek().orders.filter(o=>o.transaction_type==='BUY').length,1,'event cannot be consumed twice');
 // Broker expiry remains effective even when quote acquisition/write finishes late.
 const expiredBook=memoryBook(),expiredBroker=createPaperBroker({quotes,book:expiredBook,now:()=>now});
 const deadline=now+1000;
 const ack=await expiredBroker.placeOrder({instrumentKey:KEY,quantity:65,price:120,side:'BUY',tag:'expiry-test',entryDeadline:deadline});
 assert.equal(ack.state,'ACKNOWLEDGED');now=deadline;
 const [row]=await expiredBroker.getOrders();
 assert.equal(row.status,'cancelled');assert.equal(row.filled_quantity,0);
 const disabled=createSandboxService({ownerToken:'owner-test',env:{...env,EDGE_MONTHLY_GUARDIAN_ENABLED:'false'},dependencies:{store,broker,quotes,catalog,now:()=>now}});
 assert.equal(disabled.status().autopilotConfigured,false);
 console.log('AUTOPILOT PASS: paper-only strategy selection, unchanged strikes, evidence conflict and freshness, guardian, simulated lifecycle and expiry');
})().catch(e=>{console.error(e);process.exitCode=1;});
