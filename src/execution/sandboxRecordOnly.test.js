'use strict';
// RECORD_ONLY loss limits (paper only): the daily loss lock, losing-streak pause, remaining daily budget and the
// capital ceiling lowered by losses keep evaluating but only record what they would have done. Trade size,
// affordability, one position at a time and entries per day stay enforced. ENFORCE (the default) is unchanged.
const assert=require('node:assert/strict');
const E=require('./sandboxEngine');
const BASE=Date.parse('2026-11-09T10:00:00+05:30');
const KEY='NSE_FO|12345';
const readyResult=(at=BASE)=>({timestamp:new Date(at).toISOString(),expiry:'2026-11-10',market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
  tradeLegs:{buyLeg:{instrumentKey:KEY,contractId:'NIFTY 10 NOV 23000 CE',strike:23000,type:'CE'}},
  orchestration:{status:'READY_TO_EXECUTE',executionAllowed:true},signalTier:{tier:'A',researchOnly:false,executionAllowed:true},
  position:{status:'READY'},risk:{status:'READY',stop:{value:99},target1:{value:104}}}});
const meta={instrumentKey:KEY,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-11-10',session:'2026-11-09',lotSize:65,tickSizeRupees:0.05};
const quote=(at=BASE,bid=99.95,ask=100)=>({instrumentKey:KEY,bid,ask,receivedAt:at});
const closed=(id,netPnl,closedAt,extra={})=>({id,day:E.day(closedAt),instrumentKey:'NSE_FO|'+id,contractId:id,strategy:'LONG_CALL',closedAt,buys:65,netPnl,costReserve:100,tier:'A',...extra});
let n=0;const rid=()=>'record-only-req-'+String(++n).padStart(4,'0');
function account(mode,broker='PAPER'){
  const s=E.initialState();s.broker=broker;
  if(mode)E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,perTradeRisk:250,limitMode:mode},BASE);
  E.recover(s,'boot');E.reconcile(s,[],[],BASE);E.control(s,'ARM',rid(),BASE);return s;
}
const plan=(s,at=BASE)=>E.planEntry(s,readyResult(at),quote(at),meta,at);
const lastTrade=s=>Object.values(s.trades).sort((a,b)=>a.createdAt-b.createdAt).at(-1);

// --- settings ---
{
  const s=E.initialState();
  assert.equal(s.policy.limitMode,undefined,'old states have no mode and enforce');
  assert.throws(()=>E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,limitMode:'RECORD_ONLY'},BASE),/RECORD_ONLY_REQUIRES_PAPER_BROKER/,'never before the paper broker is in use');
  s.broker='UPSTOX_SANDBOX';
  assert.throws(()=>E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,limitMode:'RECORD_ONLY'},BASE),/RECORD_ONLY_REQUIRES_PAPER_BROKER/);
  s.broker='PAPER';
  assert.throws(()=>E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,limitMode:'OFF'},BASE),/INVALID_SANDBOX_POLICY/);
  for(const bad of [0,11,2.5,'5'])assert.throws(()=>E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,maxTradesPerDay:bad},BASE),/INVALID_SANDBOX_POLICY/);
  const id=rid();
  E.configurePolicy(s,{requestId:id,dailyGoal:1000,dailyLoss:500,limitMode:'RECORD_ONLY',maxTradesPerDay:6},BASE);
  assert.equal(s.policy.limitMode,'RECORD_ONLY');assert.equal(s.policy.maxTradesPerDay,6);
  E.configurePolicy(s,{requestId:id,dailyGoal:1000,dailyLoss:500,limitMode:'RECORD_ONLY',maxTradesPerDay:6},BASE);
  assert.throws(()=>E.configurePolicy(s,{requestId:id,dailyGoal:1000,dailyLoss:500,limitMode:'ENFORCE',maxTradesPerDay:6},BASE),/REQUEST_ID_REUSED/);
  E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500},BASE);
  assert.equal(s.policy.limitMode,'RECORD_ONLY','a save without the field keeps the mode');assert.equal(s.policy.maxTradesPerDay,6);
  s.armed=true;s.killed=false;
  assert.throws(()=>E.configurePolicy(s,{requestId:rid(),dailyGoal:1000,dailyLoss:500,limitMode:'ENFORCE'},BASE),/STOP_AND_FLATTEN/,'stop and flatten first, as for every setting');
}

// --- ENFORCE: the same checks still refuse ---
{
  const s=account('ENFORCE');s.trades.a=closed('a',-600,BASE-60000);
  assert.equal(plan(s),'DAILY_LOSS_LOCK');
  const t=account(null);t.trades.a=closed('a',-10,BASE-120000);t.trades.b=closed('b',-10,BASE-60000);
  assert.equal(plan(t),'LOSING_STREAK_LOCK');
  const u=account(null);u.archivedPnl=-3600;assert.equal(plan(u),'CAPITAL_LIMIT');
  const v=account(null);v.trades.a=closed('a',-400,BASE-60000);assert.equal(plan(v),'RISK_LIMIT','risk above the remaining daily budget');
}

// --- RECORD_ONLY: each loss limit is recorded on the trade instead of refusing it ---
{
  const s=account('RECORD_ONLY');s.trades.a=closed('a',-600,BASE-60000);s.lockedDays.push('2026-11-09');s.wouldLockDays=['2026-11-09'];
  assert.equal(plan(s),'QUEUED');
  assert.deepEqual(lastTrade(s).limitsWouldBlock,['DAILY_LOSS_LOCK','DAILY_LOSS_BUDGET']);assert.equal(lastTrade(s).limitMode,'RECORD_ONLY');
}
{
  const s=account('RECORD_ONLY');s.trades.a=closed('a',-10,BASE-120000);s.trades.b=closed('b',-10,BASE-60000);
  assert.equal(plan(s),'QUEUED');assert.deepEqual(lastTrade(s).limitsWouldBlock,['LOSING_STREAK_LOCK']);
}
{
  const s=account('RECORD_ONLY');s.archivedPnl=-3600;
  assert.equal(plan(s),'QUEUED');assert.deepEqual(lastTrade(s).limitsWouldBlock,['CAPITAL_AFTER_LOSSES']);
}
{
  const s=account('RECORD_ONLY');
  assert.equal(plan(s),'QUEUED');assert.deepEqual(lastTrade(s).limitsWouldBlock,[],'nothing would have blocked a clean entry');
}

// --- RECORD_ONLY: the hard limits still refuse ---
{
  const s=account('RECORD_ONLY');
  assert.equal(E.planEntry(s,readyResult(),quote(BASE,99.95,100),{...meta,lotSize:200},BASE),'RISK_LIMIT','trade size above planned risk per trade');
  const big=account('RECORD_ONLY');big.policy.perTradeRisk=500;big.policy.dailyLoss=1000;
  const bigQuote={instrumentKey:KEY,bid:159.95,ask:160,receivedAt:BASE};
  const r=readyResult();r.decision.risk.stop.value=159;r.decision.risk.target1.value=166;
  assert.equal(E.planEntry(big,r,bigQuote,meta,BASE),'CAPITAL_LIMIT','one lot costing more than the whole account');
  const one=account('RECORD_ONLY');
  assert.equal(plan(one),'QUEUED');assert.equal(plan(one),'EXPOSURE_ALREADY_EXISTS','one position at a time');
  const cap=account('RECORD_ONLY');
  for(let i=0;i<3;i++)cap.trades['t'+i]=closed('t'+i,-300,BASE-60000*(i+1));
  assert.equal(plan(cap),'DAILY_TRADE_LIMIT','entries per day is the runaway guard');
  E.control(cap,'STOP',rid(),BASE);E.configurePolicy(cap,{requestId:rid(),dailyGoal:1000,dailyLoss:500,maxTradesPerDay:4},BASE);
  E.reconcile(cap,[],[],BASE);E.control(cap,'ARM',rid(),BASE);
  assert.equal(plan(cap),'QUEUED','raising the cap lets the fourth entry through');
  assert.deepEqual(lastTrade(cap).limitsWouldBlock,['DAILY_LOSS_LOCK','LOSING_STREAK_LOCK','DAILY_LOSS_BUDGET']);
}

// --- RECORD_ONLY is paper only: under any other broker the limits enforce ---
{
  const s=account('RECORD_ONLY');s.broker='UPSTOX_SANDBOX';s.trades.a=closed('a',-600,BASE-60000);
  assert.equal(E.recordOnly(s),false);assert.equal(plan(s),'DAILY_LOSS_LOCK');
}

// --- the counterfactual: refused trades never happened, so they do not move the limits ---
{
  const s=account('RECORD_ONLY');
  s.trades.a=closed('a',-600,BASE-120000);                                     // would have locked the day
  s.trades.b=closed('b',900,BASE-60000,{limitsWouldBlock:['DAILY_LOSS_LOCK']}); // taken only because of record-only
  assert.equal(plan(s),'QUEUED');
  assert.ok(lastTrade(s).limitsWouldBlock.includes('DAILY_LOSS_LOCK'),'the blocked winner does not unlock the day');
  const t=account('RECORD_ONLY');
  t.trades.a=closed('a',-10,BASE-180000);t.trades.b=closed('b',-10,BASE-120000);
  t.trades.c=closed('c',50,BASE-60000,{limitsWouldBlock:['LOSING_STREAK_LOCK']});
  assert.equal(E.losingStreak(t,BASE),2,'a blocked win does not break the streak');
  t.policy.limitMode='ENFORCE';assert.equal(E.losingStreak(t,BASE),0,'enforce mode counts what actually happened');
}

// --- open trade: record-only notes the daily-loss exit instead of taking it ---
{
  const run=mode=>{
    const s=account(mode);s.trades.a=closed('a',-300,BASE-60000);
    s.policy.perTradeRisk=200;
    const t={...closed('open',null,null),id:'open',day:'2026-11-09',closedAt:null,instrumentKey:KEY,entryExpiresAt:BASE,stop:90,target:120,tickSize:0.05,quantity:65,costReserve:100,exitReason:null,buys:0};
    s.trades.open=t;s.orders.e={id:'e',tradeId:'open',kind:'ENTRY',side:'BUY',state:'COMPLETE',quantity:65,filled:65,averagePrice:100};
    s.orders.st={id:'st',tradeId:'open',kind:'STOP',side:'SELL',state:'OPEN',orderId:'x',quantity:65,filled:0,averagePrice:0,price:89.5,trigger:90};
    E.manage(s,{[KEY]:{bid:96,ask:96.05,receivedAt:BASE}},BASE); // marked -360; day -660 < -500
    return s;
  };
  const enforced=run('ENFORCE');
  assert.equal(enforced.trades.open.exitReason,'DAILY_LOSS');assert.ok(enforced.lockedDays.includes('2026-11-09'));
  const recorded=run('RECORD_ONLY');
  assert.equal(recorded.trades.open.exitReason,null,'the trade keeps running to its own stop or target');
  assert.deepEqual(recorded.trades.open.wouldHaveExited,{reason:'DAILY_LOSS',at:BASE,netPnl:-360});
  assert.ok(recorded.wouldLockDays.includes('2026-11-09'));assert.ok(!recorded.lockedDays.includes('2026-11-09'),'nothing is actually locked');
  E.manage(recorded,{[KEY]:{bid:94,ask:94.05,receivedAt:BASE+2000}},BASE+2000);
  assert.equal(recorded.trades.open.wouldHaveExited.netPnl,-360,'recorded once, at the first crossing');
}

// --- a close that crosses the limit locks the day only in the record ---
{
  const s=account('RECORD_ONLY');s.trades.a=closed('a',-300,BASE-60000);
  s.trades.b={...closed('b',null,null),day:'2026-11-09',closedAt:null,instrumentKey:KEY,costReserve:100,buys:0};
  s.orders.e={id:'e',tradeId:'b',kind:'ENTRY',side:'BUY',state:'COMPLETE',orderId:'o1',tag:'t1',instrumentKey:KEY,quantity:65,filled:65,averagePrice:100,orderType:'LIMIT',price:100,trigger:0};
  s.orders.x={id:'x',tradeId:'b',kind:'EXIT',side:'SELL',state:'COMPLETE',orderId:'o2',tag:'t2',instrumentKey:KEY,quantity:65,filled:65,averagePrice:96,orderType:'LIMIT',price:96,trigger:0};
  const row=o=>({order_id:o.orderId,tag:o.tag,instrument_token:KEY,quantity:65,transaction_type:o.side,product:'I',order_type:'LIMIT',
    price:o.price,trigger_price:0,filled_quantity:65,average_price:o.averagePrice,status:'complete'});
  E.reconcile(s,[row(s.orders.e),row(s.orders.x)],null,BASE,{positionBasis:'SANDBOX_ORDER_BOOK_DERIVED'});
  assert.equal(s.trades.b.netPnl,-360);
  assert.ok(s.wouldLockDays.includes('2026-11-09'));assert.ok(!s.lockedDays.includes('2026-11-09'));
}

// --- archive keeps both totals; summary splits with and without limits ---
{
  const s=account('RECORD_ONLY');const prior=Date.parse('2026-11-06T11:00:00+05:30');
  s.archivedPnl=-200; // archived before this mode existed: counts in both views
  s.trades.p=closed('p',-500,prior);
  s.trades.q=closed('q',800,prior+60000,{limitsWouldBlock:['DAILY_LOSS_LOCK']});
  s.trades.r=closed('r',-700,prior+120000,{limitsWouldBlock:[],wouldHaveExited:{reason:'DAILY_LOSS',at:prior+100000,netPnl:-400}});
  const summary=E.limitSummary(Object.values(s.trades));
  assert.deepEqual(summary,{taken:{trades:3,netPnl:-400},withLimits:{trades:2,netPnl:-900},wouldHaveBlocked:{trades:1,netPnl:800},
    wouldHaveCutShort:{trades:1,actualNetPnl:-700,atLimitNetPnl:-400}});
  E.archiveClosed(s,BASE);
  assert.equal(s.archivedPnl,-600);assert.equal(s.archivedLimitPnl,-1100,'-200 carried over, -500, blocked +800 skipped, -400 at the limit');
  E.assertState(s);
  s.archivedPnl=-600;s.archivedLimitPnl=-3600;
  assert.equal(plan(s),'QUEUED');assert.deepEqual(lastTrade(s).limitsWouldBlock,['CAPITAL_AFTER_LOSSES'],'capital ceiling uses the limits-enforced total');
}

console.log('Sandbox record-only limits PASS: paper only, loss limits recorded not enforced, hard limits kept, counterfactual ledger, open-trade exit recorded, archive totals and with/without summary; enforce unchanged');
