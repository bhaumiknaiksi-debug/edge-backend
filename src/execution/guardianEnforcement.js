'use strict';
// Paper-only monthly risk enforcement. Called inside the executor's locked transaction.
// Existing order lifecycle, per-position stops, daily trade cap and reconciliation remain authoritative.
const core=require('./monthlyRiskCore');
const {paperProvenance}=require('./guardianObservation');
const money=x=>Math.round(x*100)/100;
const unavailable=reason=>({ok:false,reason});
function evaluateGuardian({state:s,archived,quotes={},now,readLimit=20000,quantities}={}){
 if(s?.mode!=='SANDBOX'||s.broker!=='PAPER')return unavailable('MONTHLY_PAPER_ONLY');
 if(!Array.isArray(archived)||typeof quantities!=='function')return unavailable('MONTHLY_EVIDENCE_UNAVAILABLE');
 const trades=Object.values(s.trades||{}),orders=Object.values(s.orders||{}),closed=trades.filter(t=>t.closedAt);
 try{
  if(!archived.every(r=>r?.trade&&paperProvenance(r.trade,r.orders))||
     !closed.every(t=>paperProvenance(t,orders.filter(o=>o.tradeId===t.id))))return unavailable('MONTHLY_PAPER_PROVENANCE_INVALID');
  let current=core.reconstruct({now,archived,hot:closed,archivedTrades:s.archivedTrades??0,archivedPnl:s.archivedPnl??0,
   readLimit,previous:s.monthlyGuardian??null});
  const cumulative=money((s.archivedPnl??0)+closed.reduce((a,t)=>a+t.netPnl,0));
  const open=trades.filter(t=>!t.closedAt);
  let marked=0,markAvailable=true;
  for(const t of open){
   const q=quantities(s,t);
   if(!Number.isSafeInteger(q.buys)||!Number.isSafeInteger(q.sells)||!Number.isSafeInteger(q.net)||q.net<0||
      q.buys-q.sells!==q.net||![q.cost,q.proceeds,t.costReserve].every(x=>Number.isFinite(x)&&x>=0)){markAvailable=false;break;}
   if(!q.buys)continue;
   const filled=orders.filter(o=>o.tradeId===t.id&&o.filled>0);
   if(!filled.every(o=>o.broker==='PAPER'&&typeof o.orderId==='string'&&o.orderId.startsWith('paper-'))){markAvailable=false;break;}
   const quote=quotes[t.instrumentKey];
   if(q.net>0&&(!quote||quote.instrumentKey!==t.instrumentKey||!Number.isFinite(quote.receivedAt)||
    quote.receivedAt>now||now-quote.receivedAt>10000||!Number.isFinite(quote.exchangeAt)||quote.exchangeAt>now+1000||now-quote.exchangeAt>10000||!Number.isFinite(quote.bid)||quote.bid<=0||
    !Number.isFinite(quote.ask)||quote.ask<quote.bid)){markAvailable=false;break;}
   marked+=q.proceeds-q.cost-t.costReserve+(q.net>0?q.net*quote.bid:0);
  }
  // Preserve realized breaches even if the market mark is unavailable. Mark timestamp is
  // valuation time, after checking every constituent observed quote timestamp for freshness.
  if(markAvailable)current=core.observeOpenMark(current,{now,markAt:now,netOpenPnl:money(marked)});
  const v=core.summary(current);
  return {ok:markAvailable&&!v.locked,reason:v.locked?'MONTHLY_LOSS_LOCK':markAvailable?null:'MONTHLY_MARK_UNAVAILABLE',
   current,monthlyRealizedNetRupees:v.realizedPaise/100,estimatedOpenNetRupees:markAvailable?money(marked):null,
   cumulativeClosedNetRupees:cumulative,remainingRealizedBudgetRupees:v.remainingPaise/100,
   actualCapitalCeilingRupees:Math.max(0,Math.min(s.policy.capital,money(s.policy.capital+cumulative)))};
 }catch(_){return unavailable('MONTHLY_RISK_EVIDENCE_INVALID');}
}
// The previous durable lock is never deleted by a failed valuation or price recovery.
function applyGuardian(s,result){
 if(result.current)s.monthlyGuardian=result.current;
 if(!result.ok){
  s.armed=false;
  s.haltReason=s.haltReason||result.reason;
  // Withdraw unfilled risk; never cancel a protective stop only because risk evidence is absent.
  for(const o of Object.values(s.orders||{}))if(o.kind==='ENTRY'&&!['COMPLETE','CANCELLED','REJECTED','EXPIRED'].includes(o.state)){
   if(o.state==='QUEUED')o.state='EXPIRED';else o.wantCancel=true;
  }
  if(result.reason==='MONTHLY_LOSS_LOCK'){
   s.killed=true;
   for(const t of Object.values(s.trades))if(!t.closedAt)t.exitReason ||= 'MONTHLY_LOSS_LOCK';
  }
 }
 return result;
}
function checkGuardianEntry(s,g,{now,plannedLoss,entryOutlay}){
 if(!g?.ok||!g.current||s.broker!=='PAPER')return g?.reason||'MONTHLY_EVIDENCE_UNAVAILABLE';
 try{
  const reason=core.assessFlatEntry(g.current,{now,flat:true,plannedLoss,entryOutlay:money(entryOutlay)});
  if(reason!=='MONTHLY_BUDGET_ELIGIBLE')return reason;
  if(entryOutlay>g.actualCapitalCeilingRupees)return 'CAPITAL_AFTER_ACTUAL_LOSSES';
  return null;
 }catch(_){return 'MONTHLY_RISK_EVIDENCE_INVALID';}
}
function freshGuardian(s,now){
 try{return s.broker==='PAPER'&&s.monthlyGuardian?.locked===false&&
   core.monthOf(now)===s.monthlyGuardian.month&&now>=s.monthlyGuardian.asOf&&now-s.monthlyGuardian.asOf<=10000;}
 catch(_){return false;}
}
module.exports={evaluateGuardian,applyGuardian,checkGuardianEntry,freshGuardian};
