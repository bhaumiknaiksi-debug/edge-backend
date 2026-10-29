'use strict';
// One set of limits: the signal engine's position check uses the owner's sandbox control-page limits.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {budget,apply,resolveLimits,DEFAULT_LIMITS}=require('./ledger');
const {buildPositionPlan}=require('../engine/positionSizingEngine');
const {createSandboxService}=require('../execution/sandboxService');
const {memoryStore}=require('../execution/sandboxTestHelpers');
const NOW=new Date('2026-10-30T10:00:00+05:30');
const today=(()=>{const d=new Date(NOW.getTime()+19800000);return d.toISOString().slice(0,10);})();
const state={trades:[],lockedDays:[],operations:[],confirmedDay:today};

// Limits resolve from the owner's policy; anything malformed falls back to the old fixed numbers.
assert.deepEqual(resolveLimits(null),DEFAULT_LIMITS);
assert.deepEqual(resolveLimits({capital:10000,daily:'600',perTrade:450}),DEFAULT_LIMITS,'non-numbers never widen risk');
assert.deepEqual(resolveLimits({capital:10000,daily:-1,perTrade:450}),DEFAULT_LIMITS);
assert.equal(resolveLimits({capital:10000,daily:600,perTrade:900}).perTrade,600,'per-trade can never exceed the daily loss');
const owner={capital:10000,daily:700,perTrade:650,source:'SANDBOX_POLICY'};
const b=budget(state,NOW,owner);
assert.equal(b.perTradeLimit,650);assert.equal(b.dailyLossLimit,700);assert.equal(b.capitalLimit,10000);assert.equal(b.limitsSource,'SANDBOX_POLICY');
assert.equal(b.availableRisk,650);
const legacy=budget(state,NOW);assert.equal(legacy.perTradeLimit,1000);assert.equal(legacy.limitsSource,'DEFAULT','without owner limits the old numbers apply');

// The daily lock follows the owner's daily loss, not the old Rs 1,000.
const loss={...state,trades:[{id:'t',closedAt:NOW.toISOString(),netPnl:-650}]};
assert.equal(budget(loss,NOW,owner).locked,false);
assert.equal(budget(loss,NOW,{...owner,daily:600,perTrade:600}).locked,true,'Rs 650 lost trips a Rs 600 daily limit');
assert.equal(budget(loss,NOW).locked,false,'it would not have tripped the old Rs 1,000');
const locked=apply({...loss,operations:[]},'confirm',{requestId:'confirm-request-0001',reconciled:true},NOW,{...owner,daily:600,perTrade:600});
assert.ok(locked.lockedDays.includes(today),'applying a ledger change locks the day with the owner limits');

// The owner's -8 point exit on one lot risks about Rs 620 (8 x 65 + Rs 100 reserve).
const tradeLegs={lotSize:65,buyLeg:{ask:100,bid:99.9,strike:23000,type:'CE'}};
const risk={status:'READY',entryPremium:100,stop:{value:92},maxLossPoints:8};
const size=perTrade=>buildPositionPlan({strategy:'LONG_CALL',tradeLegs,risk,marketPhase:'OPEN',
 budget:{...budget(state,NOW,{capital:10000,daily:Math.max(perTrade,600),perTrade}),checkedAt:new Date().toISOString()}});
assert.equal(size(650).status,'READY','Rs 650 per trade admits the -8 point exit');assert.equal(size(650).recommendedLots,1);
assert.equal(size(450).status,'BLOCKED','Rs 450 per trade does not: the limit really comes from the control page');

// The sandbox exposes its policy as limits once it has read its state.
(async()=>{
 const store=memoryStore();
 await store.mutate(s=>{s.policy={...s.policy,dailyLoss:700,perTradeRisk:650};});
 const svc=createSandboxService({ownerToken:'owner-token-test',env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},getContext:()=>({}),
  dependencies:{store,now:()=>NOW.getTime(),bootId:'one',idleTickMs:0,broker:{async getOrders(){return [];},async getPositions(){return [];}},
   catalog:{async get(){return null;},status:()=>({})},quotes:{async get(){return {};}}}});
 assert.equal(svc.limits(),null,'before the first read there are no owner limits (engine uses defaults)');
 await svc.tick();
 assert.deepEqual(svc.limits(),{capital:10000,daily:700,perTrade:650,source:'SANDBOX_POLICY'});
 // The server wires the ledger to the sandbox limits.
 const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
 assert.match(server,/createLedger\(\{getLimits:\(\)=>sandboxExecution\?\.limits\?\.\(\)\|\|null,/);
 assert.ok(server.indexOf('const sandboxExecution')<server.indexOf('const ledger = createLedger'),'sandbox exists before the ledger reads it');
 console.log('One set of limits PASS: owner limits drive per-trade, daily and capital checks, malformed values fall back, daily lock follows the owner, -8 point exit fits at Rs 650 and not at Rs 450');
})().catch(e=>{console.error(e);process.exit(1);});
