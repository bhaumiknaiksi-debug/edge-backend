'use strict';
// Durable SANDBOX-only state machine. Pure functions; never calls a broker or alters EDGE decisions.
const {createHash}=require('node:crypto');
const {selectCandidate,expiryBucket,MODES,DEFAULT_MODE}=require('./candidateSelection');
const {entryPrice,stopLimitPrice,orderRisk}=require('./riskMath');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const money=x=>Math.round(x*100)/100;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const day=t=>new Date(t+19800000).toISOString().slice(0,10);
const minutes=t=>{const d=new Date(t+19800000);return d.getUTCHours()*60+d.getUTCMinutes();};
const terminal=o=>['COMPLETE','CANCELLED','REJECTED','EXPIRED'].includes(o.state);
const working=o=>!terminal(o);
function initialState(){return {version:1,mode:'SANDBOX',armed:false,armedDay:null,killed:true,haltReason:null,bootId:null,reconciledAt:null,
  orders:{},trades:{},commands:{},lockedDays:[],policy:{capital:10000,dailyGoal:1000,perTradeRisk:250,dailyLoss:500,costReserve:100,maxTradesPerDay:3,entryMode:DEFAULT_MODE,maxConsecutiveLosses:2}};}
function assertState(s){
  const p=s?.policy;
  if(s?.version!==1||s.mode!=='SANDBOX'||!p||!positive(p.capital)||p.capital>10000||!positive(p.perTradeRisk)||
    !positive(p.dailyLoss)||p.dailyLoss>1000||p.perTradeRisk>p.dailyLoss||!Number.isFinite(p.costReserve)||p.costReserve<0||
    !Number.isSafeInteger(p.maxTradesPerDay)||p.maxTradesPerDay<1||p.maxTradesPerDay>10||
    (p.dailyGoal!==undefined&&(!positive(p.dailyGoal)||p.dailyGoal>100000))||(p.entryMode!==undefined&&!MODES.includes(p.entryMode))||
    (p.maxConsecutiveLosses!==undefined&&!(Number.isSafeInteger(p.maxConsecutiveLosses)&&p.maxConsecutiveLosses>=1&&p.maxConsecutiveLosses<=5))||
    (s.archivedPnl!==undefined&&!Number.isFinite(s.archivedPnl))||
    !s.orders||Array.isArray(s.orders)||!s.trades||Array.isArray(s.trades)||!s.commands||!Array.isArray(s.lockedDays))throw Error('INVALID_SANDBOX_STATE');
}
function configurePolicy(s,input,now=Date.now()){
  assertState(s);
  const {dailyGoal,dailyLoss,requestId,perTradeRisk,entryMode,maxConsecutiveLosses}=input;
  const extended=perTradeRisk!==undefined||entryMode!==undefined||maxConsecutiveLosses!==undefined;
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId||'')||!positive(dailyGoal)||dailyGoal>100000||!positive(dailyLoss)||dailyLoss>1000||
    money(dailyGoal)!==dailyGoal||money(dailyLoss)!==dailyLoss||
    (perTradeRisk!==undefined&&(!positive(perTradeRisk)||money(perTradeRisk)!==perTradeRisk||perTradeRisk>dailyLoss||perTradeRisk<=s.policy.costReserve))||
    (entryMode!==undefined&&!MODES.includes(entryMode))||
    (maxConsecutiveLosses!==undefined&&!(Number.isSafeInteger(maxConsecutiveLosses)&&maxConsecutiveLosses>=1&&maxConsecutiveLosses<=5)))throw Error('INVALID_SANDBOX_POLICY');
  // Requests that set only goal and loss keep their original idempotency fingerprint.
  const command='POLICY:'+hash(extended?[dailyGoal,dailyLoss,perTradeRisk??null,entryMode??null,...(maxConsecutiveLosses!==undefined?[maxConsecutiveLosses]:[])]:[dailyGoal,dailyLoss]);
  if(s.commands[requestId]){if(s.commands[requestId]!==command)throw Error('REQUEST_ID_REUSED');return;}
  if(!s.killed||s.armed||Object.values(s.trades).some(t=>!t.closedAt)||Object.values(s.orders).some(working))throw Error('STOP_AND_FLATTEN_BEFORE_POLICY_CHANGE');
  if(Object.keys(s.commands).length>=1000)throw Error('COMMAND_LIMIT');
  // Per-trade risk is its own setting. It is never raised implicitly; tightening the daily loss can only lower it.
  s.policy={...s.policy,dailyGoal,dailyLoss,perTradeRisk:perTradeRisk??Math.min(s.policy.perTradeRisk,dailyLoss),
    entryMode:entryMode??s.policy.entryMode??DEFAULT_MODE,maxConsecutiveLosses:maxConsecutiveLosses??s.policy.maxConsecutiveLosses??2};
  const realized=Object.values(s.trades).filter(t=>t.closedAt&&day(t.closedAt)===day(now)).reduce((a,t)=>a+t.netPnl,0);
  if(realized<=-dailyLoss&&!s.lockedDays.includes(day(now)))s.lockedDays.push(day(now));
  s.commands[requestId]=command;assertState(s);
}
// Owner command for a trade left open on a PRIOR day (broker books roll and intraday positions are squared off).
// It never touches a same-day trade, which must be stopped and reconciled normally. Unsold quantity is valued at zero
// (worst case) and the result is booked on the trade's own day, so today's loss lock is not charged for it.
function resolveTrade(s,input,now=Date.now()){
  assertState(s);
  const {requestId,tradeId,reason}=input;
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId||'')||typeof tradeId!=='string'||!s.trades[tradeId]||
    typeof reason!=='string'||reason.trim().length<3||reason.length>200)throw Error('INVALID_RESOLVE_REQUEST');
  const command='RESOLVE:'+hash([tradeId,reason]);
  if(s.commands[requestId]){if(s.commands[requestId]!==command)throw Error('REQUEST_ID_REUSED');return;}
  const t=s.trades[tradeId];
  if(!s.killed||s.armed)throw Error('STOP_BEFORE_RESOLVING_TRADE');
  if(t.closedAt)throw Error('TRADE_ALREADY_CLOSED');
  if(!(t.day<day(now)))throw Error('ONLY_PRIOR_DAY_TRADES_CAN_BE_RESOLVED');
  if(Object.keys(s.commands).length>=1000)throw Error('COMMAND_LIMIT');
  const q=quantities(s,t);
  for(const o of Object.values(s.orders))if(o.tradeId===t.id&&working(o)){o.state='EXPIRED';o.cancelState=null;}
  t.closedAt=Date.parse(t.day+'T15:30:00+05:30');t.buys=q.buys;
  t.netPnl=q.buys?money(q.proceeds-q.cost-t.costReserve):0;
  if(q.net>0)t.pnlBasis='OWNER_RESOLVED_UNSOLD_QUANTITY_AT_ZERO';
  t.exitReason||='OWNER_RESOLVED';
  t.resolution={at:now,reason:reason.trim(),netQuantity:q.net};
  s.commands[requestId]=command;assertState(s);
}
// A fresh model EXIT for the open trade is just another exit reason; the normal stop-cancel-then-sell path does the work.
function requestModelExit(s,tradeId,now){
  assertState(s);const t=s.trades[tradeId];
  if(!t||t.closedAt||t.day!==day(now))return false;
  t.exitReason||='MODEL_EXIT';return true;
}
// Consecutive losing trades closed today (the streak resets with the IST session, like the daily loss limit).
function losingStreak(s,now){
  const today=Object.values(s.trades).filter(t=>t.closedAt&&t.buys>0&&day(t.closedAt)===day(now)).sort((a,b)=>a.closedAt-b.closedAt);
  let streak=0;for(let i=today.length-1;i>=0&&today[i].netPnl<0;i--)streak++;return streak;
}
// Moves closed prior-day trades (and their terminal orders) to the durable archive so the hot state never fills up.
// Realized P&L is carried in archivedPnl so the capital ceiling still reflects every past loss.
function archiveClosed(s,now,max=20){
  assertState(s);let moved=0;
  for(const t of Object.values(s.trades)){
    if(moved>=max)break;
    if(!t.closedAt||!(t.day<day(now)))continue;
    const orders=Object.values(s.orders).filter(o=>o.tradeId===t.id);
    if(orders.some(working))continue;
    (s.archiveQueue||=[]).push({id:'trade:'+t.id,kind:'TRADE',payload:{trade:t,orders}});
    s.archivedPnl=money((s.archivedPnl||0)+(t.buys>0?t.netPnl:0));s.archivedTrades=(s.archivedTrades||0)+1;
    for(const o of orders)delete s.orders[o.id];
    delete s.trades[t.id];moved++;
  }
  return moved;
}
function halt(s,reason){s.haltReason=reason;s.armed=false;}
function quantities(s,t){
  const orders=Object.values(s.orders).filter(o=>o.tradeId===t.id);
  const buys=orders.filter(o=>o.side==='BUY').reduce((a,o)=>a+o.filled,0);
  const sells=orders.filter(o=>o.side==='SELL').reduce((a,o)=>a+o.filled,0);
  const cost=orders.filter(o=>o.side==='BUY').reduce((a,o)=>a+o.filled*o.averagePrice,0);
  const proceeds=orders.filter(o=>o.side==='SELL').reduce((a,o)=>a+o.filled*o.averagePrice,0);
  return {buys,sells,net:buys-sells,cost,proceeds};
}
function addOrder(s,t,kind,quantity,price,trigger=0){
  const seq=Object.values(s.orders).filter(o=>o.tradeId===t.id&&o.kind===kind).length;
  const id=hash([t.id,kind,seq]);
  const o={id,tradeId:t.id,kind,tag:'edgesb_'+id.slice(0,30),instrumentKey:t.instrumentKey,contractId:t.contractId,strategy:t.strategy,expiry:t.expiry,quantity,
    side:kind==='ENTRY'?'BUY':'SELL',orderType:kind==='STOP'?'SL':'LIMIT',price,trigger,
    state:'QUEUED',orderId:null,filled:0,averagePrice:0,cancelState:null,submittedAt:null};
  s.orders[id]=o;return o;
}
function control(s,operation,requestId,now){
  assertState(s);
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId||''))throw Error('INVALID_REQUEST_ID');
  if(s.commands[requestId]){if(s.commands[requestId]!==operation)throw Error('REQUEST_ID_REUSED');return;}
  if(operation==='STOP') {s.killed=true;s.armed=false;for(const t of Object.values(s.trades))if(!t.closedAt)t.exitReason='KILL_SWITCH';}
  else if(operation==='ARM') {
    if(Object.keys(s.commands).length>=1000)throw Error('COMMAND_LIMIT');
    if(!s.reconciledAt||now-s.reconciledAt>10000||s.reconciledAt>now)throw Error('FRESH_RECONCILIATION_REQUIRED');
    if(Object.values(s.orders).some(o=>working(o))||Object.values(s.trades).some(t=>!t.closedAt))throw Error('FLAT_ACCOUNT_REQUIRED');
    s.killed=false;s.haltReason=null;s.armed=true;s.armedDay=day(now);
  } else throw Error('INVALID_CONTROL');
  if(Object.keys(s.commands).length<1000)s.commands[requestId]=operation;
}
function recover(s,bootId){
  assertState(s);if(s.bootId===bootId)return;
  s.bootId=bootId;s.armed=false;s.killed=true;s.reconciledAt=null;
  for(const o of Object.values(s.orders)){
    if(o.state==='SUBMITTING')o.state='UNCERTAIN';
    if(o.cancelState==='SUBMITTING')o.cancelState='UNCERTAIN';
  }
  for(const t of Object.values(s.trades))if(!t.closedAt)t.exitReason='RESTART';
}
function planEntry(s,result,quote,meta,now){
  assertState(s);
  if(!s.armed||s.killed||s.haltReason||s.armedDay!==day(now))return 'DISARMED';
  if(!s.reconciledAt||now-s.reconciledAt>10000||s.reconciledAt>now)return 'RECONCILIATION_STALE';
  if(minutes(now)<570||minutes(now)>=900||result?.market?.phase!=='OPEN')return 'ENTRY_WINDOW_CLOSED';
  const at=Date.parse(result.timestamp);
  if(!Number.isFinite(at)||at>now||now-at>60000)return 'STALE_DECISION';
  const pick=selectCandidate(s.policy,result);
  if(pick.reason)return pick.reason;
  const leg=pick.leg;
  if(!meta||meta.instrumentKey!==leg.instrumentKey||meta.underlying!=='NIFTY'||meta.expiry!==result.expiry||meta.expiry<day(now)||
    meta.optionType!==leg.type||meta.strike!==leg.strike||meta.session!==day(now)||!Number.isSafeInteger(meta.lotSize)||meta.lotSize<=0||
    !positive(meta.tickSizeRupees)||meta.lotSize>100000)return 'INSTRUMENT_METADATA_REQUIRED';
  if(!quote||quote.instrumentKey!==leg.instrumentKey||!positive(quote.bid)||!positive(quote.ask)||quote.ask<quote.bid||
    !Number.isFinite(quote.receivedAt)||quote.receivedAt>now||now-quote.receivedAt>10000)return 'FRESH_QUOTE_REQUIRED';
  if((quote.ask-quote.bid)/quote.ask>0.025)return 'SPREAD_TOO_WIDE';
  const tick=meta.tickSizeRupees,up=x=>money(Math.ceil((x-1e-8)/tick)*tick),down=x=>money(Math.floor((x+1e-8)/tick)*tick);
  // Entry, stop-limit and planned loss come from riskMath, the same formula the signal engine sizes with.
  const price=entryPrice(quote.ask,tick),{stop,target}=pick.exitPlan({price,bid:quote.bid,ask:quote.ask,tick,down});
  const stopLimit=stopLimitPrice(stop,tick);
  if(!positive(stop)||!positive(target)||stop>=price||target<=price||!positive(stopLimit))return 'EXECUTABLE_EXIT_PLAN_REQUIRED';
  const policy=s.policy;
  const closed=Object.values(s.trades).filter(t=>t.closedAt&&t.buys>0);
  const pnlToday=closed.filter(t=>day(t.closedAt)===day(now)).reduce((a,t)=>a+t.netPnl,0);
  const totalPnl=closed.reduce((a,t)=>a+t.netPnl,0)+(s.archivedPnl||0); // archived losses still lower the capital ceiling
  if(s.lockedDays.includes(day(now))||pnlToday<=-policy.dailyLoss)return 'DAILY_LOSS_LOCK';
  if(losingStreak(s,now)>=(policy.maxConsecutiveLosses||2))return 'LOSING_STREAK_LOCK';
  if(Object.values(s.trades).some(t=>!t.closedAt)||Object.values(s.orders).some(o=>working(o)))return 'EXPOSURE_ALREADY_EXISTS';
  if(Object.keys(s.orders).length>=500||Object.keys(s.trades).length>=100)return 'STATE_CAPACITY_LIMIT';
  if(Object.values(s.trades).filter(t=>t.day===day(now)).length>=policy.maxTradesPerDay)return 'DAILY_TRADE_LIMIT';
  const risk=orderRisk({price,stopLimit,lotSize:meta.lotSize,costReserve:policy.costReserve}).risk;
  if(risk>policy.perTradeRisk||risk>policy.dailyLoss-Math.max(0,-pnlToday))return 'RISK_LIMIT';
  if(price*meta.lotSize+policy.costReserve>Math.max(0,policy.capital+Math.min(0,totalPnl)))return 'CAPITAL_LIMIT';
  // One entry per original contract/session. Poll timestamps never manufacture new entry identities.
  const base=[day(now),pick.strategy,result.expiry,leg.instrumentKey,leg.contractId];
  const id=hash(pick.identity?[...base,pick.identity]:base); // a model decision is its own identity; other modes are unchanged
  if(s.trades[id])return 'SIGNAL_ALREADY_CONSUMED';
  const t={id,day:day(now),createdAt:now,entryExpiresAt:now+15000,analysisAt:result.timestamp,
    instrumentKey:leg.instrumentKey,contractId:leg.contractId,strategy:pick.strategy,expiry:result.expiry,
    tier:pick.tier,entrySource:pick.source,expiryBucket:expiryBucket(result.expiry,day(now)),ruleVersion:pick.ruleVersion,riskModel:pick.riskModel,anchor:pick.anchor,
    tickSize:tick,quantity:meta.lotSize,stop,stopLimit,target,plannedRisk:risk,costReserve:policy.costReserve,
    exitReason:null,closedAt:null,netPnl:null,pnlBasis:'BROKER_FILLS_MINUS_ESTIMATED_FRICTION',buys:0};
  s.trades[id]=t;addOrder(s,t,'ENTRY',t.quantity,price);return 'QUEUED';
}
function reconcile(s,book,positions,now,{positionBasis='BROKER_POSITIONS'}={}){
  assertState(s);
  const derived=positionBasis==='SANDBOX_ORDER_BOOK_DERIVED';
  if(!Array.isArray(book)||(!derived&&!Array.isArray(positions))||(derived&&positions!==null)||
    !['BROKER_POSITIONS','SANDBOX_ORDER_BOOK_DERIVED'].includes(positionBasis))throw Error('BROKER_RECONCILIATION_REQUIRED');
  if(derived&&Object.values(s.trades).some(t=>!t.closedAt&&t.day!==day(now)))throw Error('PRIOR_DAY_EXPOSURE_UNVERIFIED');
  const seen=new Set(),byTag=new Map();
  for(const b of book){
    if(typeof b.order_id!=='string'||!b.order_id||seen.has(b.order_id))throw Error('INVALID_BROKER_BOOK');
    seen.add(b.order_id);
    if(b.tag){const rows=byTag.get(b.tag)||[];rows.push(b);byTag.set(b.tag,rows);}
  }
  for(const o of Object.values(s.orders)){
    if(o.state==='QUEUED'||o.state==='EXPIRED')continue;
    if(terminal(o)&&s.trades[o.tradeId]?.closedAt)continue; // Broker books roll daily; persisted terminal fills do not.
    const rows=o.orderId?book.filter(b=>b.order_id===o.orderId):(byTag.get(o.tag)||[]);
    if(rows.length!==1){if(derived)throw Error('ORDER_RECONCILIATION_REQUIRED');halt(s,'ORDER_RECONCILIATION_REQUIRED');continue;}
    const b=rows[0],filled=b.filled_quantity;
    if(b.tag!==o.tag||b.instrument_token!==o.instrumentKey||b.quantity!==o.quantity||b.transaction_type!==o.side||b.product!=='I'||
      b.order_type!==o.orderType||b.price!==o.price||b.trigger_price!==o.trigger||!Number.isSafeInteger(filled)||filled<o.filled||filled>o.quantity||
      (filled>0&&!positive(b.average_price)))throw Error('BROKER_ORDER_MISMATCH');
    let state;
    if(b.status==='complete'&&filled===o.quantity)state='COMPLETE';
    else if(b.status==='cancelled')state='CANCELLED';
    else if(b.status==='rejected'&&filled===0)state='REJECTED';
    else if(['open','trigger pending','validation pending','open pending','put order req received','cancel pending','modify pending','not modified'].includes(b.status))state=filled?'PARTIAL':'OPEN';
    else throw Error('UNKNOWN_BROKER_ORDER_STATUS');
    if(terminal(o)&&o.state!==state)throw Error('BROKER_STATUS_REGRESSION');
    o.orderId=b.order_id;o.filled=filled;o.averagePrice=filled?b.average_price:0;o.state=state;
    if(terminal(o))o.cancelState=null;
    else if(o.cancelState&&o.cancelStartedAt&&now-o.cancelStartedAt>=15000){
      if((o.cancelAttempts||0)<3)o.cancelState=null;
      else halt(s,'CANCELLATION_NOT_CONFIRMED');
    }
  }
  const ownedIds=new Set(Object.values(s.orders).map(o=>o.orderId).filter(Boolean));
  if(derived&&book.some(b=>!ownedIds.has(b.order_id)))throw Error('UNMANAGED_SANDBOX_ORDER');
  if(book.some(b=>!ownedIds.has(b.order_id)&&!['complete','cancelled','rejected'].includes(b.status)))throw Error('UNMANAGED_PENDING_ORDER');
  const expected={};
  for(const t of Object.values(s.trades)){
    const q=quantities(s,t);if(q.net<0)throw Error('OVERSELL_DETECTED');
    if(t.resolution)continue; // owner-resolved prior-day trade: the broker has already squared off intraday exposure
    expected[t.instrumentKey]=(expected[t.instrumentKey]||0)+q.net;
    const orders=Object.values(s.orders).filter(o=>o.tradeId===t.id);
    if(!t.closedAt&&orders.every(terminal)&&q.net===0){
      t.closedAt=now;t.buys=q.buys;t.netPnl=q.buys?money(q.proceeds-q.cost-t.costReserve):0;
      const closedDay=day(now);
      const daily=Object.values(s.trades).filter(x=>x.closedAt&&day(x.closedAt)===closedDay).reduce((a,x)=>a+x.netPnl,0);
      if(daily<=-s.policy.dailyLoss&&!s.lockedDays.includes(closedDay))s.lockedDays.push(closedDay);
    }
  }
  const actual={};
  for(const p of positions||[]){
    if(p.product!=='I'||typeof p.instrument_token!=='string'||!Number.isSafeInteger(p.quantity))throw Error('INVALID_BROKER_POSITION');
    actual[p.instrument_token]=(actual[p.instrument_token]||0)+p.quantity;
  }
  if(!derived)for(const instrument of new Set([...Object.keys(expected),...Object.keys(actual)]))
    if((expected[instrument]||0)!==(actual[instrument]||0))throw Error('BROKER_POSITION_MISMATCH');
  s.positionBasis=positionBasis;s.reconciledAt=now;
}
function manage(s,quotes,now){
  assertState(s);
  for(const t of Object.values(s.trades)){
    if(t.closedAt)continue;
    const orders=Object.values(s.orders).filter(o=>o.tradeId===t.id),entry=orders.find(o=>o.kind==='ENTRY'),q=quantities(s,t);
    const quote=quotes[t.instrumentKey],fresh=quote&&Number.isFinite(quote.receivedAt)&&quote.receivedAt<=now&&now-quote.receivedAt<=10000&&positive(quote.bid)&&positive(quote.ask)&&quote.ask>=quote.bid;
    if(s.killed||t.day!==day(now)||minutes(now)>=915)t.exitReason ||= s.killed?'KILL_SWITCH':'TIME_EXIT';
    if(entry.state==='QUEUED'&&(t.exitReason||now>=t.entryExpiresAt)){entry.state='EXPIRED';continue;}
    if(entry.filled>0&&working(entry))entry.wantCancel=true; // Freeze quantity before sizing its protective exit.
    if(now>=t.entryExpiresAt&&working(entry))entry.wantCancel=true;
    if(!fresh&&q.net>0)halt(s,'POSITION_QUOTE_STALE');
    if(fresh&&q.net>0){
      const pnlToday=Object.values(s.trades).filter(x=>x.day===day(now)&&x.closedAt).reduce((a,x)=>a+x.netPnl,0);
      const marked=quote.bid*q.net+q.proceeds-q.cost-t.costReserve;
      if(pnlToday+marked<=-s.policy.dailyLoss){t.exitReason ||= 'DAILY_LOSS';if(!s.lockedDays.includes(day(now)))s.lockedDays.push(day(now));}
      if(quote.bid<=t.stop)t.exitReason ||= 'STOP_BREACHED';
      if(quote.bid>=t.target)t.exitReason ||= 'TARGET';
    }
    const stop=orders.find(o=>o.kind==='STOP');
    if(stop?.state==='REJECTED')t.exitReason ||= 'PROTECTIVE_STOP_REJECTED';
    if(stop&&terminal(stop)&&q.net>0)t.exitReason ||= 'PROTECTIVE_STOP_ENDED';
    if(t.exitReason){
      for(const o of orders)if(['ENTRY','STOP'].includes(o.kind)&&working(o)){
        if(o.state==='QUEUED'){o.state='EXPIRED';continue;}
        // Keep an acknowledged protective stop while an exit quote is unavailable.
        if(o.kind==='ENTRY'||fresh)o.wantCancel=true;
      }
      if(orders.some(o=>['ENTRY','STOP'].includes(o.kind)&&working(o)))continue; // Cancel acknowledgement alone is not cancellation.
      if(q.net>0&&fresh&&!orders.some(o=>o.kind==='EXIT'&&working(o))){
        const attempts=orders.filter(o=>o.kind==='EXIT').length;
        if(attempts>=3){halt(s,'EXIT_ATTEMPTS_EXHAUSTED');continue;}
        const price=money(Math.floor((quote.bid+1e-8)/t.tickSize)*t.tickSize);
        if(positive(price))addOrder(s,t,'EXIT',q.net,price);
      }
    } else if(terminal(entry)&&q.net>0&&!stop)addOrder(s,t,'STOP',q.net,t.stopLimit,t.stop);
    for(const o of orders)if(o.kind==='EXIT'&&working(o)&&o.submittedAt&&now-o.submittedAt>=15000)o.wantCancel=true;
  }
}
function claim(s,now,currentAllowed=true){
  assertState(s);
  if(!s.reconciledAt||now-s.reconciledAt>10000)return null;
  if(Object.values(s.orders).some(o=>o.state==='SUBMITTING'||o.state==='UNCERTAIN'||o.cancelState==='SUBMITTING'||o.cancelState==='UNCERTAIN'))return null;
  for(const o of Object.values(s.orders))if(o.wantCancel&&o.orderId&&working(o)&&!o.cancelState){o.cancelState='SUBMITTING';o.cancelStartedAt=now;o.cancelAttempts=(o.cancelAttempts||0)+1;return {action:'CANCEL',order:clone(o)};}
  const priority={STOP:0,EXIT:1,ENTRY:2};
  for(const o of Object.values(s.orders).filter(o=>o.state==='QUEUED').sort((a,b)=>priority[a.kind]-priority[b.kind])){
    if(o.kind==='ENTRY'&&(!currentAllowed||!s.armed||s.killed||s.haltReason||minutes(now)<570||minutes(now)>=900||now>=s.trades[o.tradeId].entryExpiresAt)){o.state='EXPIRED';continue;}
    if(s.haltReason&&o.kind==='ENTRY')continue;
    o.state='SUBMITTING';o.submittedAt=now;return {action:'PLACE',order:clone(o)};
  }
  return null;
}
function finish(s,action,result){
  assertState(s);const o=s.orders[action.order.id];if(!o)throw Error('UNKNOWN_ORDER');
  if(action.action==='CANCEL'){
    if(o.cancelState!=='SUBMITTING')throw Error('INVALID_CANCEL_TRANSITION');
    o.cancelState=result.state==='ACKNOWLEDGED'?'ACKNOWLEDGED':result.state==='REJECTED'?'REJECTED':'UNCERTAIN';
    if(o.cancelState!=='ACKNOWLEDGED')halt(s,'CANCEL_RECONCILIATION_REQUIRED');
  } else {
    if(o.state!=='SUBMITTING')throw Error('INVALID_SUBMIT_TRANSITION');
    o.state=result.state==='ACKNOWLEDGED'&&typeof result.orderId==='string'&&/^[A-Za-z0-9-]{1,100}$/.test(result.orderId)?'ACKNOWLEDGED':result.state==='REJECTED'?'REJECTED':'UNCERTAIN';
    if(o.state==='ACKNOWLEDGED')o.orderId=result.orderId;
    if(o.state==='UNCERTAIN')halt(s,'SUBMIT_RECONCILIATION_REQUIRED');
  }
}
function claimEmergencyCancel(s,now){
  assertState(s);if(!s.killed&&!s.haltReason)return null; // STOP or any error halt: unfilled entries must not stay live
  for(const o of Object.values(s.orders))if(o.kind==='ENTRY'&&o.orderId&&working(o)&&(o.cancelAttempts||0)<3&&
      (!o.cancelStartedAt||now-o.cancelStartedAt>=15000)){
    o.cancelState='SUBMITTING';o.cancelStartedAt=now;o.cancelAttempts=(o.cancelAttempts||0)+1;
    return {action:'CANCEL',order:clone(o)};
  }
  return null;
}
module.exports={initialState,assertState,control,configurePolicy,resolveTrade,requestModelExit,archiveClosed,losingStreak,selectCandidate,expiryBucket,recover,planEntry,reconcile,manage,claim,finish,claimEmergencyCancel,quantities,terminal,halt,day};
