'use strict';
// Triggered-entry research only. Does not qualify, rank, or place trades.
// Unlike QUICK_EXIT_V1, entry is the recorded ask at the first contemporaneous V3-confirmed poll.
// Historical 1m OHLC is NOT a sell-side executable bid: model an explicit exit-price haircut.
const {normalize,RULES,PRIMARY}=require('./quickExit');
const {getProfile,optionOrderCharges}=require('../evidence/tradingFriction');
const VERSION='TRIGGERED_EXIT_V2';
const PROFILE='UPSTOX_STANDARD_NSE_OPTIONS_2026';
const MINUTE=60000,MAX_QUOTE_AGE_MS=15000;
const SCENARIOS=Object.freeze([{id:'OPTIMISTIC_0PT',exitHaircutPoints:0},{id:'BASE_1PT',exitHaircutPoints:1},{id:'STRESS_2PT',exitHaircutPoints:2}]);
const round=x=>Math.round(x*100)/100;
const numeric=x=>typeof x==='number'&&Number.isFinite(x);

function modeledNet({entry,referenceExitPrice,quantity,exitHaircutPoints=1}){
 const profile=getProfile(PROFILE);
 if(!numeric(entry)||entry<=0||!numeric(referenceExitPrice)||referenceExitPrice<0||
  !Number.isSafeInteger(quantity)||quantity<=0||!numeric(exitHaircutPoints)||exitHaircutPoints<0)return null;
 const assumedSellPrice=Math.max(0,round(referenceExitPrice-exitHaircutPoints));
 const buy=optionOrderCharges({premium:entry,side:'BUY',quantity,profile});
 const sell=optionOrderCharges({premium:assumedSellPrice,side:'SELL',quantity,profile});
 if(!buy||!sell)return null;
 const grossRupees=round((assumedSellPrice-entry)*quantity);
 const feesRupees=round(buy.totalRupees+sell.totalRupees);
 return {assumedSellPrice,grossRupees,feesRupees,estimatedNetRupees:round(grossRupees-feesRupees),
  exitHaircutPoints,profile:PROFILE,basis:'RECORDED_ENTRY_ASK; HISTORICAL_OPTION_OHLC_EXIT_REFERENCE_MINUS_ASSUMED_HAIRCUT'};
}

function evaluateRule({entry,quantity,firstCandleMs,rows,rule}){
 const endMs=Math.min(firstCandleMs+rule.maxMinutes*MINUTE,Date.parse(
  new Date(firstCandleMs+19800000).toISOString().slice(0,10)+'T15:30:00+05:30'));
 if(!(firstCandleMs<endMs))return {status:'UNAVAILABLE',reason:'NO_COMPLETE_EXIT_CANDLE_IN_SESSION'};
 const byTime=new Map();
 for(const c of rows){
  if(c.t<firstCandleMs||c.t>=endMs)continue;
  if(byTime.has(c.t))return {status:'UNAVAILABLE',reason:'DUPLICATE_EXIT_CANDLE'};
  byTime.set(c.t,c);
 }
 let exit=null,last=null;
 for(let t=firstCandleMs;t<endMs;t+=MINUTE){
  const c=byTime.get(t);
  // Never skip over an unknown candle even if a later candle shows an attractive target.
  if(!c)return {status:'UNAVAILABLE',reason:'INCOMPLETE_EXIT_CANDLE_PATH'};
  last=c;
  if(c.low<=entry-rule.stop){exit={kind:'STOP',price:Math.min(entry-rule.stop,c.open),at:t};break;}
  if(c.high>=entry+rule.target){exit={kind:'TARGET',price:entry+rule.target,at:t};break;}
 }
 if(!exit)exit={kind:'TIME',price:last.close,at:last.t};
 const scenarios=Object.fromEntries(SCENARIOS.map(s=>[s.id,modeledNet({
  entry,referenceExitPrice:exit.price,quantity,exitHaircutPoints:s.exitHaircutPoints
 })]));
 return {status:'MEASURED',exit:exit.kind,exitCandleAt:new Date(exit.at).toISOString(),
  referenceExitPrice:round(exit.price),minutes:(exit.at-firstCandleMs)/MINUTE+1,
  grossReferencePoints:round(exit.price-entry),scenarios};
}

function measureTriggered({candidate,trigger,candles}){
 if(!['LONG_CALL','LONG_PUT'].includes(candidate?.strategy)||candidate?.legs?.sellLeg)
  return {status:'UNAVAILABLE',reason:'NOT_SINGLE_LEG_LONG',version:VERSION};
 const entry=trigger?.ask,qty=trigger?.lotSize,at=Date.parse(trigger?.at||'');
 if(!numeric(entry)||entry<=0)return {status:'UNAVAILABLE',reason:'NO_CONFIRMED_EXECUTABLE_ASK',version:VERSION};
 if(!Number.isSafeInteger(qty)||qty<=0)return {status:'UNAVAILABLE',reason:'LOT_SIZE_UNAVAILABLE',version:VERSION};
 if(!Number.isFinite(at))return {status:'UNAVAILABLE',reason:'CONFIRMED_ENTRY_TIME_UNAVAILABLE',version:VERSION};
 if(!trigger?.instrumentKey||trigger.instrumentKey!==candidate.legs?.buyLeg?.instrumentKey||
  trigger?.contractId!==candidate.legs?.buyLeg?.contractId)
  return {status:'UNAVAILABLE',reason:'TRIGGER_CONTRACT_MISMATCH',version:VERSION};
 if(trigger?.timingRule!=='OPENING_RANGE_SHADOW_V3'||!trigger?.breakoutId)
  return {status:'UNAVAILABLE',reason:'V3_CONFIRMATION_NOT_VERIFIED',version:VERSION};
 const crossed=Date.parse(trigger.crossedAt||''),deadline=Date.parse(trigger.entryWindowEndsAt||'');
 const analyzed=Date.parse(trigger.analysisAt||'');
 if(!Number.isFinite(crossed)||!Number.isFinite(deadline)||!Number.isFinite(analyzed)||
  crossed>analyzed||analyzed>at||at-analyzed>MAX_QUOTE_AGE_MS||at>deadline||
  new Date(at+19800000).toISOString().slice(0,10)!==new Date(crossed+19800000).toISOString().slice(0,10))
  return {status:'UNAVAILABLE',reason:'UNTRUSTED_TRIGGER_TIMING_OR_STALE_ASK',version:VERSION};
 const rows=normalize(candles);
 const firstCandleMs=(Math.floor(at/MINUTE)+1)*MINUTE; // never look into the partly elapsed minute
 const results=Object.fromEntries(RULES.map(rule=>[rule.id,evaluateRule({
  entry,quantity:qty,firstCandleMs,rows,rule
 })]));
 const primary=results[PRIMARY];
 return primary.status==='MEASURED'?{status:'MEASURED',version:VERSION,
  entry:{at:trigger.at,analysisAt:trigger.analysisAt,firstCandleAt:new Date(firstCandleMs).toISOString(),
   ask:entry,bid:trigger.bid,quantity:qty,contractId:trigger.contractId,breakoutId:trigger.breakoutId,
   timingRule:trigger.timingRule},results}:
  {status:'UNAVAILABLE',reason:primary.reason,version:VERSION};
}
function summary(rows){
 const measured=rows.filter(r=>r.triggered?.results?.[PRIMARY]?.status==='MEASURED');
 const money=measured.map(r=>r.triggered.results[PRIMARY].scenarios.BASE_1PT.estimatedNetRupees);
 const paired=measured.map(r=>{
  const flag=r.firstFlag,first=flag?.results?.[PRIMARY],trigger=r.triggered.results[PRIMARY];
  const old=first?.status==='MEASURED'?modeledNet({
   entry:flag.entry,referenceExitPrice:first.exitPrice,quantity:flag.lotSize,exitHaircutPoints:1
  }):null;
  return old?round(trigger.scenarios.BASE_1PT.estimatedNetRupees-old.estimatedNetRupees):null;
 }).filter(numeric);
 const reasons={};for(const r of rows)if(r.triggered?.status!=='MEASURED'){
  const k=r.triggered?.reason||'NOT_YET_MEASURED';reasons[k]=(reasons[k]||0)+1;
 }
 return {episodes:rows.length,confirmed:rows.filter(r=>r.confirmedAt).length,measured:measured.length,
  distinctMeasuredDays:new Set(measured.map(r=>r.session)).size,
  wins:money.filter(x=>x>0).length,losses:money.filter(x=>x<=0).length,
  meanNetRupees:money.length?round(money.reduce((a,b)=>a+b,0)/money.length):null,
  pairedWithFirstFlag:paired.length,
  pairedMeanDifferenceRupees:paired.length?round(paired.reduce((a,b)=>a+b,0)/paired.length):null,
  unmeasuredReasons:reasons};
}
function buildTriggeredExitReport(rows){
 return {version:VERSION,primaryRule:PRIMARY,profile:PROFILE,
  exitScenarios:SCENARIOS,overall:summary(rows),
  byCardTier:['A','B','C'].map(tier=>({tier,...summary(rows.filter(r=>r.tier===tier))})),
  promotionEligible:false,liveDecisionImpact:false,
  basis:'First contemporaneously recorded V3-confirmed ask versus historical 1-minute option candles. Assumed exit-price haircuts of 0/1/2 premium points plus broker/tax charges; NOT broker fills.',
  limits:[
   'No V3-confirmed poll with a fresh quote means unmeasured, not a losing trade or confirmed missed opportunity.',
   'The first flagged card and its confirmed entry differ in time and entry price; paired comparisons use the same cost scenario but are still counterfactual.',
   '1-minute OHLC does not contain bid-ask quotes or order-book depth at exit, so modeled exits cannot validate executable fills.',
   'Overlapping tiers, strikes and episodes on one market move are correlated and must not be counted as independent trading days.',
   'Baseline one-point haircut is a hypothesis, not measured slippage. No parameter promotion from this retrospective comparison.'
  ]};
}
module.exports={VERSION,PROFILE,SCENARIOS,modeledNet,evaluateRule,measureTriggered,buildTriggeredExitReport};
