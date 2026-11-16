'use strict';
// Experimental bid-based paper policies, pinned when a new trade is created.
// Never modify broker stop orders; software exits use the existing cancel/reconcile/exit lifecycle.
const BASELINE='FIXED_8_8', POLICIES=[BASELINE,'STEP_LOCK','STAGNATION_15','STEP_LOCK_STAGNATION','CONVEX_RATCHET'];
const valid=x=>typeof x==='number'&&Number.isFinite(x);
const round=x=>Math.round(x*100)/100;
const step=peak=>peak>=12?8:peak>=7?1.5:-8;
function convex(peak,qty,costReserve){
 if(peak<5)return -8;
 if(peak<9)return Math.ceil((costReserve/qty+1)*20)/20; // estimated reserve plus 1pt adverse exit allowance
 return peak<20?peak*(.45+.012*(peak-9)):peak*Math.min(.82,.58+.008*(peak-20));
}
function evaluate(t,q,quote,now){
 const policy=t.exitIqPolicy;
 if(!POLICIES.includes(policy)||policy===BASELINE||t.entrySource!=='AUTOPILOT_PAPER')return null;
 if(!Number.isSafeInteger(q.buys)||q.buys!==t.quantity||q.sells!==0||q.net!==q.buys||
  !valid(q.cost)||q.cost<=0||!valid(t.costReserve)||!valid(t.stop)||!valid(t.tickSize)||t.tickSize<=0)return null;
 if(!quote||quote.instrumentKey!==t.instrumentKey||!valid(quote.bid)||quote.bid<=0||!valid(quote.ask)||quote.ask<quote.bid||
  !valid(quote.exchangeAt)||quote.exchangeAt>now+1000||now-quote.exchangeAt>10000||
  !valid(quote.receivedAt)||quote.receivedAt>now||now-quote.receivedAt>10000)return null;
 const entry=q.cost/q.buys, prior=t.exitIqState;
 if(prior&&(!valid(prior.peakBid)||!valid(prior.floor)||!valid(prior.lastExchangeAt)||prior.entry!==entry))return 'EXIT_IQ_STATE_INVALID';
 if(prior&&quote.exchangeAt<prior.lastExchangeAt)return null;
 const peakBid=Math.max(entry,prior?.peakBid??entry,quote.bid),peak=peakBid-entry;
 let floor=Math.max(t.stop,prior?.floor??t.stop);
 if(policy==='STEP_LOCK'||policy==='STEP_LOCK_STAGNATION')floor=Math.max(floor,entry+step(peak));
 if(policy==='CONVEX_RATCHET')floor=Math.max(floor,entry+convex(peak,q.net,t.costReserve));
 floor=round(Math.floor((floor+1e-8)/t.tickSize)*t.tickSize);
 t.exitIqState={version:'EXIT_IQ_PAPER_V1',policy,entry,peakBid,floor,lastExchangeAt:quote.exchangeAt,
  observedAt:now,peakPoints:round(peak),basis:'OBSERVED_EXECUTABLE_BID_REFERENCE'};
 if(floor>t.stop&&quote.bid<=floor)return 'EXIT_IQ_RATCHET';
 if((policy==='STAGNATION_15'||policy==='STEP_LOCK_STAGNATION')&&now-t.createdAt>=15*60000&&peak<3.5&&quote.bid-entry<1)return 'EXIT_IQ_STAGNATION';
 return null;
}
module.exports={BASELINE,POLICIES,evaluate};
