'use strict';
// EDGE 2.0 monthly risk reference reducer. PAPER research only; no broker, policy,
// route, or execution integration. All calculations use integer paise.
const CAPITAL=1000000, LOSS_LIMIT=700000, IST_OFFSET=19800000;
const bad=()=>{throw Error('MONTHLY_RISK_EVIDENCE_INVALID');};
const validTime=t=>Number.isSafeInteger(t)&&t>0&&t<=8640000000000000-IST_OFFSET;
function monthOf(t){
  if(!validTime(t))bad();
  return new Date(t+IST_OFFSET).toISOString().slice(0,7);
}
function paise(v){
  if(typeof v!=='number'||!Number.isFinite(v))bad();
  const n=Math.round(v*100);
  if(!Number.isSafeInteger(n)||Math.abs(v-n/100)>1e-7)bad();
  return n;
}
function add(a,b){const n=a+b;if(!Number.isSafeInteger(n))bad();return n;}
function validState(s){
  if(!s||s.version!==1||!validTime(s.asOf)||s.month!==monthOf(s.asOf)||
    !Number.isSafeInteger(s.realizedPaise)||typeof s.locked!=='boolean'||
    (s.locked?(!validTime(s.lockedAt)||s.lockedAt>s.asOf||monthOf(s.lockedAt)!==s.month||
      !['REALIZED','MARKED'].includes(s.lockBasis)):(s.lockedAt!==null||s.lockBasis!==null))||
    (!s.locked&&s.realizedPaise<=-LOSS_LIMIT))bad();
}
function latch(s,at,basis){
  if(!s.locked||at<s.lockedAt)return {...s,locked:true,lockedAt:at,lockBasis:basis};
  return s;
}
// Complete archive (including unfilled attempts) plus CLOSED hot trades only.
// Caller must obtain consistent snapshots and prove archive totals, then persist any
// lock atomically with the executor state. An archive cannot reconstruct historical
// intratrade threshold touches; those require the prior durable marked lock.
function reconstruct({now,archived,hot,archivedTrades,archivedPnl,readLimit,previous=null}={}){
  const month=monthOf(now);
  if(!Array.isArray(archived)||!Array.isArray(hot)||!Number.isSafeInteger(readLimit)||readLimit<1||
    archived.length>=readLimit||!Number.isSafeInteger(archivedTrades)||archivedTrades!==archived.length)bad();
  if(previous){validState(previous);if(previous.asOf>now)bad();}
  const seen=new Set(),closed=[];let archiveTotal=0;
  function visit(t,fromArchive){
    if(!t||typeof t.id!=='string'||!t.id.trim()||seen.has(t.id)||!validTime(t.closedAt)||t.closedAt>now||
      !Number.isSafeInteger(t.buys)||t.buys<0)bad();
    seen.add(t.id);
    const pnl=paise(t.netPnl);
    if(!t.buys&&pnl!==0)bad();
    if(fromArchive)archiveTotal=add(archiveTotal,pnl);
    if(t.buys&&monthOf(t.closedAt)===month)closed.push({at:t.closedAt,pnl,id:t.id});
  }
  for(const row of archived)visit(row?.trade,true);
  for(const t of hot)visit(t,false);
  if(archiveTotal!==paise(archivedPnl))bad();
  let s={version:1,month,asOf:now,realizedPaise:0,locked:false,lockedAt:null,lockBasis:null};
  if(previous?.month===month&&previous.locked)s=latch(s,previous.lockedAt,previous.lockBasis);
  // Identical close timestamps have no proven order; check losses before gains conservatively.
  closed.sort((a,b)=>a.at-b.at||a.pnl-b.pnl||a.id.localeCompare(b.id));
  for(const t of closed){
    s.realizedPaise=add(s.realizedPaise,t.pnl);
    if(s.realizedPaise<=-LOSS_LIMIT)s=latch(s,t.at,'REALIZED');
  }
  validState(s);return s;
}
// Mark is total OPEN-position net P&L only, after estimated liquidation costs.
// Null, future, stale or malformed marks cannot establish a safe entry.
// A latched threshold is never cleared by price recovery.
function observeOpenMark(s,{now,markAt,netOpenPnl}={}){
  validState(s);
  if(monthOf(now)!==s.month||now<s.asOf||!validTime(markAt)||markAt>now||now-markAt>10000||markAt<s.asOf)bad();
  const net=add(s.realizedPaise,paise(netOpenPnl));
  let next={...s,asOf:now};
  if(net<=-LOSS_LIMIT)next=latch(next,markAt,'MARKED');
  validState(next);return next;
}
function summary(s){
  validState(s);
  const remaining=Math.max(0,add(LOSS_LIMIT,s.realizedPaise));
  // Paper account does not magically regain lost buying power; gains can restore
  // it up to, but never above, the starting capital ceiling.
  const capital=Math.max(0,Math.min(CAPITAL,add(CAPITAL,s.realizedPaise)));
  return {month:s.month,locked:s.locked,lockedAt:s.lockedAt,lockBasis:s.lockBasis,
    realizedPaise:s.realizedPaise,remainingPaise:s.locked?0:remaining,capitalPaise:capital};
}
// Eligibility check only: an independent risk guardian still owns quote quality,
// position caps, stop/target validity, entry count, reconciliation and execution.
function assessFlatEntry(s,{now,flat,plannedLoss,entryOutlay}={}){
  validState(s);
  if(monthOf(now)!==s.month||now<s.asOf||now-s.asOf>10000)return 'MONTHLY_STATE_STALE';
  const v=summary(s);
  if(v.locked)return 'MONTHLY_LOSS_LOCK';
  if(flat!==true)return 'EXPOSURE_ALREADY_EXISTS';
  const risk=paise(plannedLoss),outlay=paise(entryOutlay);
  if(risk<=0||outlay<=0||risk>outlay)bad();
  if(outlay>v.capitalPaise)return 'CAPITAL_LIMIT';
  if(risk>v.remainingPaise)return 'MONTHLY_RISK_BUDGET';
  return 'MONTHLY_BUDGET_ELIGIBLE'; // NOT an order authorization
}
module.exports={reconstruct,observeOpenMark,summary,assessFlatEntry,monthOf};
