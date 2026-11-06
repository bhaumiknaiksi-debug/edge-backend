'use strict';
// PAPER-only calendar-month net loss limit: activation from the durable archive (fail closed), replacement of the daily
// and per-trade ceilings, open-loss exits, persistent month locks, archive/restart survival and IST month boundaries.
const assert=require('node:assert/strict');
const express=require('express');
const E=require('./sandboxEngine');
const {createSandboxService}=require('./sandboxService');
const {memoryStore}=require('./sandboxTestHelpers');
const T=s=>Date.parse(s+'+05:30');
const NOW=T('2026-11-20T10:00:00');
const K='NSE_FO|777';
const closed=(id,closedAt,netPnl,extra={})=>({id,day:new Date(closedAt+19800000).toISOString().slice(0,10),instrumentKey:K,contractId:'x',strategy:'LONG_CALL',
  closedAt,buys:65,netPnl,costReserve:100,tier:'A',...extra});
const row=t=>({trade:t,orders:[]});
// V3 opening-range candidate: entry 100, stop 95, stop-limit 94.5 -> planned risk 5.5*65+100 = 457.5; capital use 6,600.
function analysis(at,breakoutId='2026-11-20:UP:A'){
  const leg={instrumentKey:K,contractId:'NIFTY 29 DEC 23000 CE',strike:23000,type:'CE',delta:0.5};
  return {timestamp:new Date(at).toISOString(),expiry:'2026-12-29',spot:23010,market:{phase:'OPEN'},decision:{strategy:'WAIT',regime:{direction:'BULLISH'},
    researchCandidatePlans:{plans:{C:{available:true,strategy:'LONG_CALL',legs:{buyLeg:leg,legDelta:0.5}}}},
    shadowTiming:{version:'OPENING_RANGE_SHADOW_V3',plans:{C:{status:'CONFIRMED',shadowEntryReady:true,strategy:'LONG_CALL',contracts:[K],
      episodeId:breakoutId,breakoutId,regimeAligned:true,entryFresh:true,chaseLimitPoints:50,crossedAt:new Date(at-60000).toISOString(),
      entryWindowEndsAt:new Date(at+300000).toISOString(),anchor:{source:'NIFTY_INDEX_5M_OPENING_RANGE',high:23000,low:22900}}}}}};
}
const meta=at=>({instrumentKey:K,underlying:'NIFTY',optionType:'CE',strike:23000,expiry:'2026-12-29',session:new Date(at+19800000).toISOString().slice(0,10),lotSize:65,tickSizeRupees:0.05});
const quote=(at,bid=99.95,ask=100)=>({instrumentKey:K,bid,ask,receivedAt:at});
const RID=n=>'request-'+String(n).padStart(12,'0');
// A stopped, flat state with an archive (counters kept in step, as archiveClosed does) and optional hot trades.
function stateWith(archived=[],hot=[]){
  const s=E.initialState();s.policy.entryMode='OPENING_RANGE_SHADOW_V1';
  s.archivedTrades=archived.length;s.archivedPnl=Math.round(archived.reduce((a,t)=>a+(t.buys>0?t.netPnl:0),0)*100)/100;
  for(const t of hot)s.trades[t.id]=t;
  return {s,rows:archived.map(row)};
}
function activate(s,rows,now=NOW,monthlyLoss=7000,id=1){
  E.configureMonthlyPolicy(s,{requestId:RID(id),monthlyLoss,reconstruction:E.reconstructMonth(rows,now,20000)},now);
}
function arm(s,now){E.recover(s,'boot');E.reconcile(s,[],[],now);E.control(s,'ARM',RID(900+Math.floor(Math.random()*90)),now);}
const plan=(s,now,id,ask=100)=>E.planEntry(s,analysis(now,id),quote(now,Math.round((ask-0.05)*100)/100,ask),meta(now),now);
// A ₹30 option (entry 30.05, stop 25.05, stop-limit 24.9 -> planned risk 434.75; capital use 2,053.25) keeps the
// unchanged capital ceiling (10,000 minus all losses) out of the way where a test needs a month close to its limit.
const CHEAP=30.05;

// --- activation rebuilds this month from the archive; the owner's example: -6,000 then +2,000 leaves 3,000 ---
{
  const {s,rows}=stateWith([closed('a1',T('2026-11-05T11:00:00'),-6000),closed('old',T('2026-10-30T11:00:00'),-5000),
    closed('nobuy',T('2026-11-06T11:00:00'),0,{buys:0,netPnl:0})],[closed('h1',T('2026-11-19T11:00:00'),2000)]);
  activate(s,rows);
  const m=E.monthlySummary(s,NOW);
  assert.deepEqual(m,{active:true,month:'2026-11',limit:7000,monthPnl:-4000,remaining:3000,locked:false,trackedFrom:'2026-11'},
    'October losses are not this month; unfilled trades are ignored');
  assert.equal(s.policy.monthlyLoss,7000);
}
// --- activation fails closed: never a silent zero start ---
{
  const base=()=>stateWith([closed('a1',T('2026-11-05T11:00:00'),-600)]);
  let {s,rows}=base();s.archivedTrades=2; // counter says two archived trades, archive returns one
  assert.throws(()=>activate(s,rows),/MONTHLY_RECONSTRUCTION_FAILED/,'archive count mismatch');
  ({s,rows}=base());s.archivedPnl=-500;
  assert.throws(()=>activate(s,rows),/MONTHLY_RECONSTRUCTION_FAILED/,'archive total mismatch');
  for(const bad of [null,undefined,[{}],[{trade:{id:'x',closedAt:NOW,buys:65,netPnl:NaN}}],[row(closed('d',NOW,-1)),row(closed('d',NOW,-1))]])
    assert.throws(()=>E.reconstructMonth(bad,NOW,20000),/MONTHLY_RECONSTRUCTION_FAILED/,JSON.stringify(bad));
  assert.throws(()=>E.reconstructMonth(new Array(3).fill(0).map((_,i)=>row(closed('t'+i,NOW,-1))),NOW,3),/MONTHLY_RECONSTRUCTION_FAILED/,'a full page may be truncated');
  ({s,rows}=base());
  const r={...E.reconstructMonth(rows,NOW,20000),month:'2026-10'};
  assert.throws(()=>E.configureMonthlyPolicy(s,{requestId:RID(2),monthlyLoss:7000,reconstruction:r},NOW),/MONTHLY_RECONSTRUCTION_FAILED/,'stale month');
  assert.throws(()=>E.configureMonthlyPolicy(s,{requestId:RID(3),monthlyLoss:7000},NOW),/MONTHLY_RECONSTRUCTION_FAILED/,'no reconstruction');
  assert.throws(()=>activate(s,rows,NOW,10001),/INVALID_SANDBOX_POLICY/,'limit above capital');
  ({s,rows}=base());s.killed=false;
  assert.throws(()=>activate(s,rows),/STOP_AND_FLATTEN_BEFORE_POLICY_CHANGE/);
  ({s,rows}=base());assert.equal(s.policy.monthlyLoss,undefined,'failed activation leaves the daily policy in force');
}
// --- the monthly allowance replaces the daily and per-trade ceilings at entry; capital and execution checks stay ---
{
  const {s,rows}=stateWith();
  activate(s,rows);
  assert.equal(s.policy.perTradeRisk,250,'old per-trade setting kept but inert');
  const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'QUEUED','457.5 planned risk passes: above the old 250 per-trade cap, within the 7,000 allowance');
  assert.equal(Object.values(s.trades)[0].plannedRisk,457.5);
}
{
  const {s,rows}=stateWith([],[closed('h1',T('2026-11-20T09:30:00'),-6700)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'RISK_LIMIT','300 left: a 457.5 planned risk is refused');
}
{
  const {s,rows}=stateWith([],[closed('h1',T('2026-11-20T09:30:00'),-800)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'QUEUED','an 800 loss today no longer trips the 500 daily threshold');
}
// --- capital resets each month: only this month's net loss lowers the ₹10,000 ceiling; gains never raise it ---
{
  const {s,rows}=stateWith([closed('oct',T('2026-10-20T11:00:00'),-5000)],[closed('h1',T('2026-11-19T11:00:00'),-3500)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'CAPITAL_LIMIT','November ceiling 10,000-3,500 = 6,500 < 6,600 needed');
}
{
  const {s,rows}=stateWith([closed('oct',T('2026-10-20T11:00:00'),-5000)],[closed('h1',T('2026-11-19T11:00:00'),-3000)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'QUEUED','October\'s 5,000 loss no longer counts: 10,000-3,000 = 7,000 >= 6,600');
}
{
  const {s,rows}=stateWith([],[closed('w1',T('2026-11-19T11:00:00'),4000)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(E.planEntry(s,analysis(at),quote(at,154.95,155),meta(at),at),'CAPITAL_LIMIT','a ₹4,000 gain does not lift the ceiling above 10,000 (155*65+100 = 10,175)');
}
{
  const {s}=stateWith([closed('oct',T('2026-10-20T11:00:00'),-3500)]); // daily mode: lifetime losses still count
  s.policy.dailyLoss=1000;s.policy.perTradeRisk=1000;
  const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'CAPITAL_LIMIT','daily mode capital rule unchanged');
}
// --- the two-losses-in-a-row pause still applies inside the monthly policy ---
{
  const {s,rows}=stateWith([],[closed('l1',T('2026-11-20T09:40:00'),-200),closed('l2',T('2026-11-20T09:50:00'),-200)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'LOSING_STREAK_LOCK');
}
// --- reaching the limit locks the month; a later gain or re-activation does not unlock it ---
{
  const {s,rows}=stateWith([],[closed('h1',T('2026-11-18T11:00:00'),-7000)]);
  activate(s,rows);
  assert.deepEqual(s.monthly.lockedMonths,['2026-11'],'activation on an exhausted month locks it at once');
  const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'MONTHLY_LOSS_LOCK');
  s.trades.h2=closed('h2',T('2026-11-19T11:00:00'),3000); // e.g. an owner-resolved prior-day trade booked as a gain
  assert.equal(E.monthlySummary(s,at).remaining,3000);
  assert.equal(plan(s,at),'MONTHLY_LOSS_LOCK','the lock is a latch');
  E.control(s,'STOP',RID(50),at);activate(s,rows,at,7000,51);
  assert.equal(E.monthlySummary(s,at).locked,true,'re-activation keeps the lock');
}
// --- an open loss that would take the month past the limit forces the exit and locks the month ---
{
  const {s,rows}=stateWith([],[closed('h1',T('2026-11-20T09:30:00'),-6600)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at,undefined,CHEAP),'RISK_LIMIT','400 left < 434.75');
  s.trades.h1.netPnl=-6000;assert.equal(plan(s,at,undefined,CHEAP),'QUEUED','1,000 left');
  const t=Object.values(s.trades).find(x=>!x.closedAt),entry=Object.values(s.orders).find(o=>o.tradeId===t.id);
  Object.assign(entry,{state:'COMPLETE',filled:65,averagePrice:CHEAP,orderId:'b1'});
  E.manage(s,{[K]:quote(at+1000,29,29.05)},at+1000);
  assert.equal(t.exitReason,null,'month -6,000 + open -168.25: within the limit');
  E.manage(s,{[K]:quote(at+2000,15,15.05)},at+2000); // open: 15*65 - 1,953.25 - 100 = -1,078.25 -> month -7,078.25
  assert.equal(t.exitReason,'MONTHLY_LOSS');assert.deepEqual(s.monthly.lockedMonths,['2026-11']);
  assert.equal(s.lockedDays.length,0,'no daily lock is written in monthly mode');
}
// --- a trade closing at a loss through reconciliation locks the month when it reaches the limit ---
{
  const {s,rows}=stateWith([],[closed('h1',T('2026-11-20T09:30:00'),-6600)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');
  s.trades.h1.netPnl=-6000;arm(s,at);assert.equal(plan(s,at,undefined,CHEAP),'QUEUED');
  const t=Object.values(s.trades).find(x=>!x.closedAt),entry=Object.values(s.orders).find(o=>o.tradeId===t.id);
  Object.assign(entry,{state:'COMPLETE',filled:65,averagePrice:CHEAP,orderId:'b1',submittedAt:at});
  const exit={id:'x1',tradeId:t.id,kind:'EXIT',tag:'edgesb_x1',instrumentKey:K,contractId:t.contractId,strategy:t.strategy,expiry:t.expiry,quantity:65,
    side:'SELL',orderType:'LIMIT',price:15,trigger:0,state:'OPEN',orderId:'b2',filled:0,averagePrice:0,cancelState:null,submittedAt:at};
  s.orders.x1=exit;
  const book=[{order_id:'b1',tag:entry.tag,instrument_token:K,quantity:65,transaction_type:'BUY',product:'I',order_type:'LIMIT',price:entry.price,trigger_price:0,filled_quantity:65,average_price:CHEAP,status:'complete'},
    {order_id:'b2',tag:'edgesb_x1',instrument_token:K,quantity:65,transaction_type:'SELL',product:'I',order_type:'LIMIT',price:15,trigger_price:0,filled_quantity:65,average_price:15,status:'complete'}];
  E.reconcile(s,book,[],at+5000);
  assert.equal(t.netPnl,-1078.25);assert.equal(E.monthlySummary(s,at+5000).monthPnl,-7078.25);
  assert.deepEqual(s.monthly.lockedMonths,['2026-11']);
}
// --- archiving and restarts keep the month total ---
{
  const {s,rows}=stateWith([],[closed('y1',T('2026-11-19T11:00:00'),-1500),closed('y2',T('2026-11-19T12:00:00'),500)]);
  activate(s,rows);const at=T('2026-11-20T10:00:00');
  const before=E.monthPnl(s,at);
  assert.equal(E.archiveClosed(s,at),2);
  assert.equal(Object.keys(s.trades).length,0);
  assert.equal(E.monthPnl(s,at),before,'moved from hot state to the month bucket, not lost');
  const restarted=JSON.parse(JSON.stringify(s));E.recover(restarted,'boot-2');E.assertState(restarted);
  assert.equal(E.monthPnl(restarted,at),-1000,'durable state carries the month across a restart');
  // the archive itself still reconstructs to the same figures
  const archived=s.archiveQueue.map(q=>q.payload);
  assert.equal(E.reconstructMonth(archived,at,20000).monthArchivedPnl,-1000);
}
// --- IST month boundary: closed on 30 Nov counts for November; December starts fresh and is not locked by November ---
{
  const {s,rows}=stateWith([],[closed('n1',T('2026-11-30T15:00:00'),-7000)]);
  activate(s,rows,T('2026-11-30T15:20:00'));
  assert.deepEqual(s.monthly.lockedMonths,['2026-11']);
  const dec=T('2026-12-01T09:31:00');
  assert.equal(E.monthPnl(s,dec),0);assert.equal(E.monthlySummary(s,dec).remaining,7000);
  E.archiveClosed(s,dec);
  assert.equal(s.monthly.archivedPnl['2026-11'],-7000,'archived on 1 Dec, booked to November');
  assert.equal(E.monthPnl(s,dec),0);
  arm(s,dec);assert.equal(plan(s,dec,undefined,CHEAP),'QUEUED','November\'s lock does not block December');
  assert.equal(E.monthlySummary(s,T('2026-11-30T23:59:00')).monthPnl,-7000,'23:59 IST is still November');
}
// --- daily mode is untouched when the monthly limit is not active ---
{
  const {s}=stateWith([],[closed('h1',T('2026-11-20T09:30:00'),-800)]);
  const at=T('2026-11-20T10:00:00');arm(s,at);
  assert.equal(plan(s,at),'DAILY_LOSS_LOCK');
  assert.deepEqual(E.monthlySummary(s,at),{active:false});
}

// --- HTTP: activation reads the archive; a failed read refuses activation and leaves the daily policy in force ---
(async()=>{
  const OWNER='sandbox-owner-test-token';
  for(const failing of [false,true]){
    let now=NOW;const store=memoryStore();
    await store.mutate(s=>{s.trades.a1=closed('a1',T('2026-11-05T11:00:00'),-6000);E.archiveClosed(s,now);});
    await store.mutate(s=>{s.trades.h1=closed('h1',T('2026-11-19T11:00:00'),2000);});
    if(failing)store.readArchive=async()=>{throw Error('db down');};
    const broker={async getOrders(){return [];},async getPositions(){return [];}};
    const service=createSandboxService({ownerToken:OWNER,getContext:()=>({analysis:null}),
      env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'data-token'},dependencies:{store,broker,now:()=>now,bootId:'one',idleTickMs:0}});
    const app=express();app.use(express.json());service.routes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const url='http://127.0.0.1:'+server.address().port+'/api/v1/execution/sandbox';
    const auth={Authorization:'Bearer '+OWNER,'Content-Type':'application/json'};
    try{
      const res=await fetch(url+'/policy/monthly',{method:'POST',headers:auth,body:JSON.stringify({requestId:RID(70),confirmSandbox:true,monthlyLoss:7000})});
      const body=await res.json();
      if(failing){
        assert.equal(res.status,409);assert.equal(body.error,'MONTHLY_RECONSTRUCTION_FAILED');
        assert.equal((await store.read()).policy.monthlyLoss,undefined,'nothing activated');
      }else{
        assert.equal(res.status,200,JSON.stringify(body));
        assert.equal(body.monthly.remaining,3000);assert.equal(body.reconstruction.archivedTrades,1);
        const state=await (await fetch(url,{headers:auth})).json();
        assert.equal(state.monthly.monthPnl,-4000);
      }
    }finally{server.close();}
  }
  console.log('Sandbox monthly limit PASS: archive reconstruction (fail closed), -6,000/+2,000 leaves 3,000, replaces daily and per-trade ceilings, monthly capital reset, streak kept, open-loss exit, latch, archive/restart, IST month boundary, daily mode unchanged, HTTP activation');
})().catch(e=>{console.error(e);process.exit(1);});
