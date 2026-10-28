'use strict';
// Frozen-level (opening-range shadow) entry path, per-trade risk setting, stuck-trade resolution and
// emergency cancel after an error halt. All sandbox-only; no broker or network is contacted.
const assert=require('node:assert/strict');
const express=require('express');
const E=require('./sandboxEngine');
const {selectCandidate}=require('./candidateSelection');
const {createSandboxService}=require('./sandboxService');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
const KEY='NSE_FO|777',OTHER='NSE_FO|888';

// A decision where the authoritative Tier A plan is NOT ready, but a Tier C card has crossed its frozen level.
function analysis({tier='C',strategy='LONG_CALL',spot=23010,high=23000,low=22900,status='CONFIRMED',ready=true,direction='BULLISH',delta=0.5,at=BASE}={}){
  const type=strategy==='LONG_CALL'?'CE':'PE',leg={instrumentKey:KEY,contractId:'NIFTY 03 NOV 23000 '+type,strike:23000,type,delta};
  return {timestamp:new Date(at).toISOString(),expiry:'2026-11-03',spot,market:{phase:'OPEN'},decision:{strategy:'WAIT',regime:{direction},
    orchestration:{status:'WAIT',executionAllowed:false},signalTier:{tier:'C',researchOnly:true,executionAllowed:false},
    risk:{status:'UNAVAILABLE'},position:{status:'UNAVAILABLE'},
    researchCandidatePlans:{plans:{[tier]:{available:true,strategy,legs:{buyLeg:leg,legDelta:delta}}}},
    shadowTiming:{version:'OPENING_RANGE_SHADOW_V1',researchOnly:true,executionAllowed:false,plans:{[tier]:{status,shadowEntryReady:ready,strategy,
      contracts:[KEY],episodeId:'episode-1',anchor:{source:'NIFTY_INDEX_5M_OPENING_RANGE',high,low}}}}}};
}
const meta=(key=KEY)=>({instrumentKey:key,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-03',session:'2026-10-28',lotSize:65,tickSizeRupees:0.05});
const quote=(key=KEY,at=BASE)=>({instrumentKey:key,bid:99.95,ask:100,receivedAt:at});
function armed(policy={}){
  const s=E.initialState();
  E.configurePolicy(s,{requestId:'policy-setup-000001',dailyGoal:1000,dailyLoss:500,entryMode:'OPENING_RANGE_SHADOW_V1',perTradeRisk:500,...policy},BASE);
  E.recover(s,'boot');E.reconcile(s,[],[],BASE);E.control(s,'ARM','arm-request-000001',BASE);return s;
}

// --- default mode is unchanged: a confirmed shadow card alone never authorizes anything ---
{
  const s=E.initialState();assert.equal(s.policy.entryMode,'AUTHORITATIVE_A_ONLY');
  E.recover(s,'boot');E.reconcile(s,[],[],BASE);E.control(s,'ARM','arm-request-000001',BASE);
  assert.equal(E.planEntry(s,analysis(),quote(),meta(),BASE),'BACKEND_NOT_READY');
}
// --- a confirmed Tier C card is admitted in shadow mode, with its tier and frozen level recorded ---
{
  const s=armed(),before=JSON.stringify(analysis());
  assert.equal(E.planEntry(s,analysis(),quote(),meta(),BASE),'QUEUED');
  const t=Object.values(s.trades)[0];
  assert.equal(t.tier,'C');assert.equal(t.entrySource,'SHADOW_OPENING_RANGE');assert.equal(t.ruleVersion,'OPENING_RANGE_SHADOW_V1');
  assert.equal(t.riskModel,'ANCHOR_INVALIDATION_V1');assert.equal(t.anchor.level,23000);assert.equal(t.anchor.distance,10);
  assert.equal(t.stop,95,'stop = entry minus delta x distance back to the frozen level (0.5 x 10)');
  assert.equal(t.target,107.5,'target = entry plus 1.5 x the planned premium risk');
  assert.ok(t.plannedRisk<=500,'planned risk including friction fits the owner-set per-trade budget');
  assert.equal(JSON.stringify(analysis()),before,'selection never mutates the backend decision');
}
// --- the same trade is refused when the owner-set per-trade budget is too small (risk is a real gate) ---
{
  const s=armed({requestId:'policy-setup-000002',perTradeRisk:300});
  assert.equal(E.planEntry(s,analysis(),quote(),meta(),BASE),'RISK_LIMIT');
}
// --- candidates that have NOT crossed their frozen level, or lost it, are never admitted ---
for(const [label,args,expected] of [
  ['waiting',{status:'WAITING',ready:false},'NO_CONFIRMED_SHADOW_CANDIDATE'],
  ['confirmed but entry not ready',{ready:false},'NO_CONFIRMED_SHADOW_CANDIDATE'],
  ['invalidated',{status:'INVALIDATED'},'NO_CONFIRMED_SHADOW_CANDIDATE'],
  ['spot fell back below the level',{spot:22995},'ANCHOR_LOST'],
  ['regime opposes a long call',{direction:'BEARISH'},'REGIME_OPPOSES_CANDIDATE'],
  ['delta unavailable',{delta:null},'ANCHOR_OR_DELTA_UNAVAILABLE'],
]){
  const s=armed();assert.equal(E.planEntry(s,analysis(args),quote(),meta(),BASE),expected,label);
}
// A late chase far beyond the level is rejected by the risk budget, not silently accepted.
assert.equal(E.planEntry(armed(),analysis({spot:23040}),quote(),meta(),BASE),'RISK_LIMIT');
// Puts mirror calls around the low of the range.
{
  const s=armed(),r=analysis({strategy:'LONG_PUT',spot:22890,direction:'BEARISH'});
  assert.equal(E.planEntry(s,r,quote(),{...meta(),optionType:'PE'},BASE),'QUEUED');assert.equal(Object.values(s.trades)[0].anchor.level,22900);
}
// An authoritative Tier A card is preferred over B/C when both are confirmed.
{
  const r=analysis({tier:'C'});r.decision.researchCandidatePlans.plans.A={...r.decision.researchCandidatePlans.plans.C,legs:{...r.decision.researchCandidatePlans.plans.C.legs,buyLeg:{...r.decision.researchCandidatePlans.plans.C.legs.buyLeg}}};
  r.decision.shadowTiming.plans.A={...r.decision.shadowTiming.plans.C};
  assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},r).tier,'A');
}
// Spreads and multi-leg structures are never admitted.
{
  const r=analysis();r.decision.researchCandidatePlans.plans.C.legs.sellLeg={instrumentKey:OTHER};
  assert.equal(selectCandidate({entryMode:'OPENING_RANGE_SHADOW_V1'},r).reason,'NO_CONFIRMED_SHADOW_CANDIDATE');
}

// --- per-trade risk is its own, bounded and idempotent setting ---
{
  const s=E.initialState();
  E.configurePolicy(s,{requestId:'policy-risk-0000001',dailyGoal:1000,dailyLoss:1000,perTradeRisk:900},BASE);assert.equal(s.policy.perTradeRisk,900);
  E.configurePolicy(s,{requestId:'policy-risk-0000001',dailyGoal:1000,dailyLoss:1000,perTradeRisk:900},BASE);
  assert.throws(()=>E.configurePolicy(s,{requestId:'policy-risk-0000001',dailyGoal:1000,dailyLoss:1000,perTradeRisk:800},BASE),/REQUEST_ID_REUSED/);
  assert.throws(()=>E.configurePolicy(s,{requestId:'policy-risk-0000002',dailyGoal:1000,dailyLoss:500,perTradeRisk:600},BASE),/INVALID_SANDBOX_POLICY/,'per-trade risk cannot exceed the daily loss threshold');
  assert.throws(()=>E.configurePolicy(s,{requestId:'policy-risk-0000003',dailyGoal:1000,dailyLoss:500,perTradeRisk:100},BASE),/INVALID_SANDBOX_POLICY/,'a budget that friction alone consumes admits nothing');
  assert.throws(()=>E.configurePolicy(s,{requestId:'policy-risk-0000004',dailyGoal:1000,dailyLoss:500,entryMode:'ANYTHING'},BASE),/INVALID_SANDBOX_POLICY/);
  E.configurePolicy(s,{requestId:'policy-risk-0000005',dailyGoal:1000,dailyLoss:400},BASE);assert.equal(s.policy.perTradeRisk,400,'tightening the loss limit can only lower the budget');
  assert.equal(s.policy.entryMode,'AUTHORITATIVE_A_ONLY','mode is not changed unless asked');
  assert.equal(s.policy.capital,10000,'capital ceiling is never configurable here');
}

// --- a trade left open on a prior day can be resolved by the owner, and only then ---
{
  const yesterday=Date.parse('2026-10-27T14:50:00+05:30');
  const s=E.initialState();
  s.trades.T={id:'T',day:'2026-10-27',instrumentKey:KEY,closedAt:null,buys:0,costReserve:100};
  s.orders.A={id:'A',tradeId:'T',kind:'ENTRY',side:'BUY',state:'COMPLETE',quantity:65,filled:65,averagePrice:100,orderId:'o1',tag:'x',instrumentKey:KEY,orderType:'LIMIT',price:100,trigger:0};
  s.orders.B={id:'B',tradeId:'T',kind:'STOP',side:'SELL',state:'OPEN',quantity:65,filled:0,averagePrice:0,orderId:'o2',tag:'y',instrumentKey:KEY,orderType:'SL',price:90,trigger:91};
  E.recover(s,'boot2');
  assert.throws(()=>E.reconcile(s,[],null,BASE,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'}),/PRIOR_DAY_EXPOSURE_UNVERIFIED/,'the stuck state is real before resolution');
  assert.throws(()=>E.resolveTrade(s,{requestId:'resolve-request-0001',tradeId:'T',reason:''},BASE),/INVALID_RESOLVE_REQUEST/);
  assert.throws(()=>E.resolveTrade(s,{requestId:'resolve-request-0001',tradeId:'missing',reason:'cleanup'},BASE),/INVALID_RESOLVE_REQUEST/);
  s.armed=true;assert.throws(()=>E.resolveTrade(s,{requestId:'resolve-request-0001',tradeId:'T',reason:'cleanup'},BASE),/STOP_BEFORE_RESOLVING_TRADE/);s.armed=false;
  E.resolveTrade(s,{requestId:'resolve-request-0001',tradeId:'T',reason:'Prior-day sandbox position squared off by broker'},BASE);
  E.resolveTrade(s,{requestId:'resolve-request-0001',tradeId:'T',reason:'Prior-day sandbox position squared off by broker'},BASE);
  const t=s.trades.T;assert.ok(t.closedAt);assert.equal(E.day(t.closedAt),'2026-10-27','booked on its own day');
  assert.equal(t.netPnl,-6600,'unsold quantity valued at zero: 65 x 100 bought, plus Rs 100 friction');assert.equal(t.pnlBasis,'OWNER_RESOLVED_UNSOLD_QUANTITY_AT_ZERO');
  assert.equal(s.orders.B.state,'EXPIRED');
  assert.deepEqual(s.lockedDays,[],'a prior-day loss does not lock today');
  E.reconcile(s,[],null,BASE,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'});assert.equal(s.reconciledAt,BASE,'reconciliation passes once resolved');
  E.reconcile(s,[],[],BASE+1000);assert.equal(s.reconciledAt,BASE+1000,'and with a positions API, the resolved trade is not expected at the broker');
  // same-day and already closed trades cannot be resolved this way
  s.trades.U={id:'U',day:'2026-10-28',instrumentKey:KEY,closedAt:null,buys:0,costReserve:100};
  assert.throws(()=>E.resolveTrade(s,{requestId:'resolve-request-0002',tradeId:'U',reason:'cleanup now'},BASE),/ONLY_PRIOR_DAY_TRADES_CAN_BE_RESOLVED/);
  assert.throws(()=>E.resolveTrade(s,{requestId:'resolve-request-0003',tradeId:'T',reason:'again please'},BASE),/TRADE_ALREADY_CLOSED/);
  void yesterday;
}

// --- after an error halt (not only STOP), an unfilled entry is cancelled ---
{
  const s=E.initialState();s.killed=false;s.armed=true;
  s.trades.T={id:'T',day:'2026-10-28',closedAt:null,buys:0};
  s.orders.E={id:'E',tradeId:'T',kind:'ENTRY',state:'OPEN',orderId:'o9',filled:0,quantity:65,side:'BUY'};
  assert.equal(E.claimEmergencyCancel(s,BASE),null,'a healthy armed worker does not emergency-cancel');
  E.halt(s,'SANDBOX_READ_UNAVAILABLE');
  const action=E.claimEmergencyCancel(s,BASE);assert.equal(action.action,'CANCEL');assert.equal(action.order.orderId,'o9');
}

(async()=>{
  // --- service end to end: quotes, instrument metadata and the final re-check all follow the selected candidate ---
  const store=memoryStore(),rows=[];let now=BASE,context=analysis();
  const broker={async getOrders(){return structuredClone(rows);},async getPositions(){const n=rows.reduce((a,o)=>a+(o.transaction_type==='BUY'?o.filled_quantity:-o.filled_quantity),0);return n?[{instrument_token:KEY,quantity:n,product:'I'}]:[];},
    async placeOrder(o){rows.push({order_id:'broker-'+(rows.length+1),tag:o.tag,instrument_token:o.instrumentKey,quantity:o.quantity,price:o.price,trigger_price:o.trigger,
      transaction_type:o.side,product:'I',order_type:o.orderType,status:'open',filled_quantity:0,average_price:0});return {state:'ACKNOWLEDGED',orderId:'broker-'+rows.length};},
    async cancel(id){rows.find(o=>o.order_id===id).status='cancelled';return {state:'ACKNOWLEDGED',orderId:id};}};
  const asked=[];
  const dependencies={store,broker,now:()=>now,bootId:'one',
    catalog:{async get(key){asked.push('meta:'+key);return key===KEY?meta():null;},status:()=>({ready:true,error:null})},
    quotes:{async get(keys){asked.push('quote:'+keys.join(','));return Object.fromEntries(keys.map(k=>[k,quote(k,now)]));}}};
  const service=createSandboxService({ownerToken:'owner-token-test',getContext:()=>({analysis:{...context,timestamp:new Date(now).toISOString()}}),env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true'},dependencies});
  await store.mutate(s=>E.configurePolicy(s,{requestId:'policy-service-00001',dailyGoal:1000,dailyLoss:500,perTradeRisk:500,entryMode:'OPENING_RANGE_SHADOW_V1'},now));
  await service.tick();await store.mutate(s=>E.control(s,'ARM','arm-service-0000001',now));
  now+=1000;await service.tick();
  assert.equal(rows.length,1,'the confirmed Tier C card reached the broker as one sandbox entry');assert.equal(rows[0].instrument_token,KEY);
  assert.ok(asked.includes('quote:'+KEY)&&asked.includes('meta:'+KEY),'quote and metadata were fetched for the selected candidate, not the (empty) Tier A leg');
  const state=await store.read(),trade=Object.values(state.trades)[0];assert.equal(trade.tier,'C');
  const st=service.status();assert.ok(st.tickCount>=2&&st.lastTickAt&&st.lastTickStartedAt,'status reports worker progress so a silent worker is distinguishable from a failing one');
  // the frozen level is lost before a second candidate could be sent: nothing new is placed
  context=analysis({spot:22995,tier:'C'});now+=1000;await service.tick();assert.equal(rows.length,1);

  // a broker read failure halts the worker AND cancels the unfilled entry that is still live at the broker
  assert.equal(rows[0].status,'open');
  broker.getOrders=async()=>{const e=Error('private details');e.httpStatus=500;throw e;};
  now+=1000;await service.tick();assert.equal(rows[0].status,'cancelled','error halt cancels the known unfilled entry');
  const halted=await store.read();assert.equal(halted.haltReason,'SANDBOX_READ_UNAVAILABLE');assert.equal(halted.armed,false);assert.equal(halted.reconciledAt,null,'arming needs a fresh reconciliation afterwards');

  // --- HTTP: owner-only resolve route and tier summary ---
  const app=express();app.use(express.json());service.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port+'/api/v1/execution/sandbox';
  try{
    const call=(path,body,auth=true)=>fetch(url+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer owner-token-test'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await call('/resolve',{requestId:'resolve-http-0000001',tradeId:'x',confirmSandbox:true,reason:'cleanup'},false)).status,401);
    assert.equal((await call('/resolve',{requestId:'resolve-http-0000001',tradeId:'x',reason:'cleanup'})).status,400,'explicit confirmation is required');
    assert.equal((await call('/resolve',{requestId:'resolve-http-0000001',tradeId:'x',confirmSandbox:true,reason:'cleanup'})).status,409,'unknown trades are refused');
    const body=await (await call('')).json();assert.deepEqual(body.tierSummary.byEntryTier,{},'no closed trades yet');assert.equal(body.state.policy.entryMode,'OPENING_RANGE_SHADOW_V1');
    const policy=await call('/policy',{requestId:'policy-http-0000001',confirmSandbox:true,dailyGoal:1000,dailyLoss:500,perTradeRisk:450,entryMode:'AUTHORITATIVE_A_ONLY'});
    assert.equal(policy.status,409,'settings cannot change while a trade is open');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
  console.log('Sandbox shadow entry PASS: frozen-level candidates of any tier, tier recorded, per-trade risk, loss/late-chase rejection, prior-day resolution and emergency cancel after halt');
})().catch(e=>{console.error(e);process.exitCode=1;});
