'use strict';
// GUARDIAN observation only. No orders, arming, writes, or risk-policy changes.
const core=require('./monthlyRiskCore');
const unavailable=reason=>({status:'UNAVAILABLE',reason,mode:'PAPER_SHADOW',executionAllowed:false,enforced:false});
function paperProvenance(trade,orders){
 if(!Array.isArray(orders)||!orders.every(o=>o&&Number.isSafeInteger(o.filled)&&o.filled>=0))return false;
 const filled=orders.filter(o=>o.filled>0);
 if(!filled.every(o=>o.broker==='PAPER'&&typeof o.orderId==='string'&&o.orderId.startsWith('paper-')))return false;
 return filled.filter(o=>o.side==='BUY').reduce((a,o)=>a+o.filled,0)===trade.buys&&
 filled.filter(o=>o.side==='SELL').reduce((a,o)=>a+o.filled,0)===trade.buys;
}
function observeGuardian({state,archived,now,readLimit=20000}={}){
 if(state?.mode!=='SANDBOX'||state.broker!=='PAPER')return unavailable('PAPER_BROKER_REQUIRED');
 if(!Array.isArray(archived))return unavailable('ARCHIVE_UNAVAILABLE');
 const hot=Object.values(state.trades||{}),orders=Object.values(state.orders||{});
 const closed=hot.filter(t=>t.closedAt);
 if(!archived.every(r=>r?.trade&&paperProvenance(r.trade,r.orders))||
    !closed.every(t=>paperProvenance(t,orders.filter(o=>o.tradeId===t.id))))return unavailable('PAPER_HISTORY_PROVENANCE_UNAVAILABLE');
 try{
  const result=core.reconstruct({now,archived,hot:closed,archivedTrades:state.archivedTrades??0,archivedPnl:state.archivedPnl??0,readLimit});
  const v=core.summary(result);
  const cumulativePnl=(state.archivedPnl??0)+closed.reduce((a,t)=>a+t.netPnl,0);
  return {status:'MEASURED_REALIZED_ONLY',mode:'PAPER_SHADOW',executionAllowed:false,enforced:false,
   asOf:new Date(now).toISOString(),month:v.month,startingCapitalRupees:10000,lossCeilingRupees:7000,
   monthlyRealizedNetRupees:v.realizedPaise/100,remainingRealizedBudgetRupees:v.remainingPaise/100,
   realizedThresholdTouched:v.locked,firstRealizedThresholdAt:v.lockedAt===null?null:new Date(v.lockedAt).toISOString(),
   cumulativeClosedNetRupees:Math.round(cumulativePnl*100)/100,
   openTradeCount:hot.length-closed.length,markedPnlAvailable:false,markedLockHistoryAvailable:false,
   basis:'ESTIMATED_NET_FROM_PAPER_FILLS_AND_STORED_COST_RESERVES',
   limitations:['No open-position marks evaluated; historical marked threshold touches cannot be reconstructed.',
    'No durable lock, reset or order authorization. Realized threshold is descriptive only.',
    'No implied capital replenishment or change to actual buying power.']};
 }catch(_){return unavailable('MONTHLY_RISK_EVIDENCE_INVALID');}
}
module.exports={observeGuardian};
