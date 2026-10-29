'use strict';
// Second-review findings, each reproduced as a behaviour test (no source-text checks):
// 1. a database read that started before a save cannot reinstall the old limits;
// 2. a failed read after a good load stops approvals at once;
// 3. a READY sized under limits that changed, failed or expired is never published or served;
// 4. the signal and the executor round a stop the same way (the real executor decides here).
const assert=require('node:assert/strict');
const {createOwnerLimits}=require('../execution/ownerLimits');
const {plannedLongRisk,stopLimitPrice,down}=require('../execution/riskMath');
const {createSandboxService}=require('../execution/sandboxService');
const {control,configurePolicy}=require('../execution/sandboxEngine');
const {memoryStore}=require('../execution/sandboxTestHelpers');
const {buildPositionPlan}=require('../engine/positionSizingEngine');
const {budget}=require('./ledger');
const policy=(perTrade,daily=700)=>({capital:10000,dailyLoss:daily,perTradeRisk:perTrade,costReserve:100});
const READY=token=>({decision:{orchestration:{status:'READY_TO_EXECUTE'},limitsToken:token}});

(async()=>{
 let clock=Date.parse('2026-10-30T10:00:00+05:30');
 // --- 1. A slow read that began before a save never reinstalls the old limit. ---
 {
  let release,db=policy(660);const changes=[];
  const limits=createOwnerLimits({read:()=>new Promise(r=>{const snap=structuredClone(db);release=()=>r({policy:snap});}),now:()=>clock,onChange:l=>changes.push(l&&l.perTrade)});
  const first=limits.refresh();release();await first;assert.equal(limits.get().perTrade,660);
  const slow=limits.refresh();             // reads the Rs 660 policy...
  db=policy(450);limits.set(db);           // ...meanwhile the owner saves Rs 450
  assert.equal(limits.get().perTrade,450);assert.deepEqual(changes,[450]);
  release();await slow;                    // the old read finishes last
  assert.equal(limits.get().perTrade,450,'the superseded read is discarded');assert.deepEqual(changes,[450],'and announces nothing');
  const next=limits.refresh();release();await next;assert.equal(limits.get().perTrade,450,'later reads see the saved value');
 }
 // --- 2. A failed read after a good load stops approvals and announces the loss. ---
 {
  let fail=false;const changes=[];
  const limits=createOwnerLimits({read:async()=>{if(fail)throw Error('db');return {policy:policy(660)};},now:()=>clock,onChange:l=>changes.push(l)});
  await limits.refresh();const t=limits.token();assert.ok(limits.valid(t));
  fail=true;await limits.refresh();
  assert.equal(limits.get(),null,'no usable limits after a failed read');assert.equal(limits.status().error,'OWNER_LIMITS_UNAVAILABLE');
  assert.equal(limits.valid(t),false);assert.equal(limits.servable(READY(t)),false,'an earlier READY can no longer be served');
  assert.deepEqual(changes,[null],'approvals are invalidated');
  fail=false;await limits.refresh();assert.equal(limits.servable(READY(t)),false,'a READY from before the outage stays void after recovery');
  assert.equal(limits.servable(READY(limits.token())),true,'a fresh analysis can approve again');
 }
 // --- 3. Publish and serve only under the exact, current, fresh limits. ---
 {
  let db=policy(660);
  const limits=createOwnerLimits({read:async()=>({policy:structuredClone(db)}),now:()=>clock,maxAgeMs:60000});
  await limits.refresh();const t=limits.token();
  assert.equal(limits.servable(READY(t)),true);
  assert.equal(limits.servable({decision:{orchestration:{status:'NO_TRADE'}}}),true,'non-READY results need no limits');
  assert.equal(limits.servable(READY(null)),false,'a READY without a stamp is never served');
  assert.equal(limits.servable(READY({...t,version:'other'})),false);
  clock+=61000;assert.equal(limits.servable(READY(t)),false,'expired limits: the cached READY is refused (the reviewer case)');
  await limits.refresh();assert.equal(limits.servable(READY(t)),true,'same limits re-read: the same stamp is valid again');
  db=policy(450);await limits.refresh();assert.equal(limits.servable(READY(t)),false,'limits changed in the database: refused');
  limits.set(policy(450));assert.equal(limits.servable(READY(limits.token())),true);
 }
 // --- 4. Stop rounding: the signal and the real executor agree. ---
 {
  for(const raw of [92,92.04,91.99,92.01,87.33,120.47]){
   assert.equal(stopLimitPrice(raw),stopLimitPrice(down(raw,0.05)),'raw '+raw+' and its tick-normalized stop give one stop-limit');
  }
  const r=plannedLongRisk({ask:100,stop:92.04,lotSize:65,costReserve:100});
  assert.equal(r.stopLimit,91.5);assert.equal(r.risk,652.5,'the reviewer case now plans Rs 652.50, as the executor does');
  // The real executor, Tier A authoritative mode, stop 92.04, per-trade Rs 650 vs Rs 660.
  const verdict=async perTrade=>{
   let now=Date.parse('2026-10-30T10:00:00+05:30');const store=memoryStore(),rows=[];
   await store.mutate(s=>configurePolicy(s,{requestId:'policy-parity-'+perTrade+'-0001',dailyGoal:1000,dailyLoss:700,perTradeRisk:perTrade},now));
   const result={timestamp:new Date(now).toISOString(),expiry:'2026-11-03',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
    tradeLegs:{buyLeg:{instrumentKey:'NSE_FO|12345',contractId:'NIFTY 03 NOV 23000 CE',strike:23000,type:'CE'}},
    orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
    position:{status:'READY'},risk:{status:'READY',stop:{value:92.04},target1:{value:112}}}};
   const svc=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({analysis:result}),
    dependencies:{store,now:()=>now,bootId:'one',idleTickMs:0,
     broker:{async getOrders(){return structuredClone(rows);},async getPositions(){return [];},async placeOrder(o){rows.push({order_id:'b1',tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,transaction_type:o.side,product:'I',order_type:o.orderType,status:'open',filled_quantity:0,average_price:0});return {state:'ACKNOWLEDGED',orderId:'b1'};},async cancel(){return {state:'ACKNOWLEDGED'};}},
     catalog:{async get(){return {instrumentKey:'NSE_FO|12345',underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-30',lotSize:65,tickSizeRupees:0.05};},status:()=>({ready:true})},
     quotes:{async get(keys){return Object.fromEntries(keys.map(k=>[k,{instrumentKey:k,bid:99.95,ask:100,receivedAt:now}]));}}}});
   await svc.tick();await store.mutate(s=>control(s,'ARM','parity-arm-'+perTrade+'-00001',now));now+=1000;await svc.tick();
   return svc.status().lastEntryResult;
  };
  const signal=perTrade=>buildPositionPlan({strategy:'LONG_CALL',tradeLegs:{lotSize:65,buyLeg:{ask:100,bid:99.95}},risk:{status:'READY',entryPremium:100,stop:{value:92.04},maxLossPoints:7.96},marketPhase:'OPEN',
   budget:{...budget({trades:[],confirmedDay:budget({trades:[]},new Date()).day},new Date(),{capital:10000,daily:700,perTrade,costReserve:100,source:'SANDBOX_POLICY'}),checkedAt:new Date().toISOString()}}).status;
  assert.equal(await verdict(650),'RISK_LIMIT');assert.equal(signal(650),'BLOCKED','Rs 650: the executor refuses, and so does the signal');
  const at660=await verdict(660);assert.equal(at660,'QUEUED','Rs 660: the executor queues the entry');assert.equal(signal(660),'READY','and so does the signal');
 }
 console.log('Limits guards PASS: superseded reads discarded, failed reads stop approvals, READY served/published only under current fresh limits, signal and real executor agree on stop rounding');
})().catch(e=>{console.error(e);process.exit(1);});
