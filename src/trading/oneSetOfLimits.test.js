'use strict';
// One set of limits, fail closed. The signal engine's position check uses the owner's saved sandbox limits, read
// straight from the store; anything missing, malformed or stale approves nothing; a saved change takes effect at once;
// and a single option is sized with the same stop-limit fill the sandbox executor uses.
const assert=require('node:assert/strict');
const express=require('express');
const {budget,apply,createLedger,resolveLimits,DEFAULT_LIMITS}=require('./ledger');
const {buildPositionPlan}=require('../engine/positionSizingEngine');
const {createOwnerLimits,limitsFromPolicy}=require('../execution/ownerLimits');
const {plannedLongRisk}=require('../execution/riskMath');
const {createSandboxService}=require('../execution/sandboxService');
const {memoryStore}=require('../execution/sandboxTestHelpers');
const NOW=new Date('2026-10-30T10:00:00+05:30'),today='2026-10-30';
const base={trades:[],lockedDays:[],operations:[],confirmedDay:today,brokerFills:[]};
const owner=(perTrade,daily=Math.max(perTrade,700),capital=10000)=>({capital,daily,perTrade,costReserve:100,source:'SANDBOX_POLICY',version:'v'+perTrade+'-'+daily+'-'+capital});
// The owner's -8 point exit on one lot: entry 100, stop 92. The executor's stop-limit is 91.50, so the planned loss
// is (100 - 91.50) x 65 + 100 = Rs 652.50, not the naive Rs 620.
const legs={lotSize:65,buyLeg:{ask:100,bid:99.9,strike:23000,type:'CE'}};
const risk={status:'READY',entryPremium:100,stop:{value:92},maxLossPoints:8};
const size=(b,extra={})=>buildPositionPlan({strategy:'LONG_CALL',tradeLegs:{...legs,...extra},risk,marketPhase:'OPEN',budget:{...b,checkedAt:new Date().toISOString()}});

(async()=>{
 // --- 1. Fail closed: missing or malformed limits approve nothing (no fallback to Rs 1,000). ---
 for(const bad of [null,undefined,{capital:10000,daily:'600',perTrade:450},{capital:10000,daily:600,perTrade:-1},{capital:10000,daily:600}]){
  assert.equal(resolveLimits(bad).source,'UNAVAILABLE',JSON.stringify(bad));
 }
 const blind=budget(base,NOW,null);
 assert.equal(blind.limitsSource,'UNAVAILABLE');assert.equal(blind.availableRisk,0);assert.equal(blind.locked,false,'a missing number never locks the day');
 const blocked=size(blind);assert.equal(blocked.status,'BLOCKED');assert.match(blocked.reason,/limits could not be read/);
 const reviewerCase=size(budget(base,NOW,{capital:10000,daily:'600',perTrade:450}));
 assert.equal(reviewerCase.status,'BLOCKED','the reviewer case (malformed daily + valid Rs 450) no longer becomes Rs 1,000');
 const lossy={...base,trades:[{id:'t',closedAt:NOW.toISOString(),netPnl:-700}],operations:[]};
 assert.equal(apply(lossy,'confirm',{requestId:'confirm-request-0001',reconciled:true},NOW,null).lockedDays.length,0,'apply never locks from missing limits');
 assert.equal(budget(base,NOW).limitsSource,'DEFAULT','legacy callers that pass no limits keep the old numbers');

 // --- 2. Every owner field is honoured (per-trade, daily and capital). ---
 const b=budget(base,NOW,owner(700));
 assert.equal(b.perTradeLimit,700);assert.equal(b.dailyLossLimit,700);assert.equal(b.capitalLimit,10000);assert.equal(b.limitsSource,'SANDBOX_POLICY');assert.equal(b.limitsVersion,'v700-700-10000');
 assert.equal(resolveLimits({...owner(900),daily:600}).perTrade,600,'per-trade never exceeds the daily loss');
 assert.equal(size(budget(base,NOW,owner(700,700,10000))).status,'READY');
 assert.equal(size(budget(base,NOW,owner(700,700,6000))).status,'BLOCKED','capital Rs 6,000 cannot hold a Rs 6,600 lot: capital is really used');
 assert.equal(budget(lossy,NOW,owner(600,600)).locked,true,'the daily lock follows the owner daily loss');
 assert.equal(budget(lossy,NOW,owner(700,800)).locked,false);

 // --- 3. Signal sizing matches the executor's stop-limit fill. ---
 assert.deepEqual(plannedLongRisk({ask:100,stop:92,lotSize:65,costReserve:100}),{price:100,stopLimit:91.5,risk:652.5,capital:6600});
 assert.equal(size(budget(base,NOW,owner(650))).status,'BLOCKED','Rs 650 is below the Rs 652.50 the executor would risk');
 assert.equal(size(budget(base,NOW,owner(660))).status,'READY');
 assert.equal(size(budget(base,NOW,owner(660))).riskPerLotRupees,652.5);
 const engineSrc=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','execution','sandboxEngine.js'),'utf8');
 assert.match(engineSrc,/require\('\.\/riskMath'\)/);assert.match(engineSrc,/orderRisk\(\{price,stopLimit,lotSize:meta\.lotSize,costReserve:policy\.costReserve\}\)/);

 // --- 4. createLedger really uses getLimits (the reviewer's first undetected mutation). ---
 // The live ledger checks the real clock, so the fixture confirms the real trading day.
 const realDay=budget({trades:[]},new Date()).day;
 const pool={async query(){return {rows:[{payload:{...structuredClone(base),confirmedDay:realDay}}]};}};
 let supplied=owner(700);
 const ledger=createLedger({pool,getLimits:()=>supplied});
 await ledger.refresh();
 assert.equal(ledger.snapshot().perTradeLimit,700);assert.equal(ledger.snapshot().limitsSource,'SANDBOX_POLICY');
 supplied=null;assert.equal(ledger.snapshot().limitsSource,'UNAVAILABLE','no owner limits: unavailable, not defaults');
 supplied=()=>{throw Error('x');};const throwing=createLedger({pool,getLimits:()=>{throw Error('boom');}});await throwing.refresh();
 assert.equal(throwing.snapshot().limitsSource,'UNAVAILABLE');
 const legacy=createLedger({pool});await legacy.refresh();assert.equal(legacy.snapshot().limitsSource,'DEFAULT');

 // --- 5. Owner limits load from the store without the sandbox worker, expire when stale, and announce changes. ---
 let clock=NOW.getTime(),changes=[];
 const store=memoryStore();
 await store.mutate(s=>{s.policy={...s.policy,dailyLoss:700,perTradeRisk:660};});
 const limits=createOwnerLimits({read:()=>store.read(),now:()=>clock,onChange:l=>changes.push(l)});
 assert.equal(limits.get(),null,'nothing approved before the first load');
 await limits.refresh();
 assert.equal(limits.get().perTrade,660);assert.equal(changes.length,0,'first load is not a change');
 clock+=61000;assert.equal(limits.get(),null,'a stale copy never approves');await limits.refresh();assert.equal(limits.get().perTrade,660);
 const failing=createOwnerLimits({read:async()=>{throw Error('db');},now:()=>clock});await failing.refresh();
 assert.equal(failing.get(),null);assert.equal(failing.status().error,'OWNER_LIMITS_UNAVAILABLE');
 assert.equal(limitsFromPolicy({capital:10000,dailyLoss:700,perTradeRisk:660}),null,'a policy without its cost reserve is not trusted');
 // Works even when sandbox execution is disabled: the service is not involved at all.
 const disabled=createSandboxService({env:{},ownerToken:'o'});assert.equal(disabled.status().reason,'DISABLED');assert.equal(limits.get().perTrade,660);

 // --- 6. Saving tighter limits takes effect before the response, and invalidates approvals at once. ---
 let epoch=0;
 const live=createOwnerLimits({read:()=>store.read(),now:()=>clock,onChange:()=>{epoch++;}});await live.refresh();
 const svc=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({}),onPolicyChange:p=>live.set(p),
  dependencies:{store,now:()=>clock,bootId:'one',broker:{async getOrders(){return [];},async getPositions(){return [];}},catalog:{async get(){return null;},status:()=>({})},quotes:{async get(){return {};}}}});
 const app=express();app.use(express.json());svc.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const signalLedger=createLedger({pool,getLimits:()=>live.get()});await signalLedger.refresh();
  assert.equal(size(signalLedger.snapshot()).status,'READY','READY at Rs 660 before the change');
  const before=epoch;
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/execution/sandbox/policy',{method:'POST',
   headers:{'Content-Type':'application/json',Authorization:'Bearer owner-token-test'},body:JSON.stringify({requestId:'policy-tighten-00001',dailyGoal:1000,dailyLoss:700,perTradeRisk:450,confirmSandbox:true})});
  assert.equal(res.status,200);
  assert.equal(live.get().perTrade,450,'the new limit is in force when the save returns, with no worker tick');
  assert.equal(epoch,before+1,'approvals are invalidated (cached and in-flight analyses use this epoch)');
  assert.equal(size(signalLedger.snapshot()).status,'BLOCKED','the same trade is blocked immediately after saving Rs 450');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}

 // --- 7. Server wiring: limits come from the store-backed source, refreshed before each analysis. ---
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','server.js'),'utf8');
 assert.match(src,/createLedger\(\{getLimits:\(\)=>ownerLimits\.get\(\),/);
 assert.match(src,/onPolicyChange:policy=>ownerLimits\.set\(policy\)/);
 assert.match(src,/await ownerLimits\.refresh\(\);\n\s*await ledger\.refresh\(\);\n\s*const analysedEpoch = ledgerEpoch;/);
 assert.match(src,/onChange:\(\)=>invalidateApprovals\(\)/);
 assert.ok(!/limits\?\.\(\)/.test(src),'the worker-cached limits path is gone');
 // Approvals are stamped with their limits and only published or served while those limits are current (behaviour of
 // servable() is tested in limitsGuards.test.js; these lines check it is applied at both exits).
 assert.match(src,/const limitsToken = ownerLimits\.token\(\);/);assert.match(src,/result\.decision\.limitsToken = limitsToken;/);
 assert.match(src,/if \(!ownerLimits\.servable\(result\)\) throw new Error\('OWNER_LIMITS_CHANGED_DURING_ANALYSIS'\);\n\s*lastResult = result;/);
 assert.match(src,/if \(!ownerLimits\.servable\(lastResult\)\) return res\.status\(503\)[^\n]*\n\s*res\.json\(lastResult\);/);
 console.log('One set of limits PASS: fail closed (no wider fallback), every owner field honoured, executor stop-limit parity, createLedger uses getLimits, store-backed and stale-safe, saved changes in force before the response with approvals invalidated');
})().catch(e=>{console.error(e);process.exit(1);});
