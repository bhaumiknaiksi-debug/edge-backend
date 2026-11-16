'use strict';
// EDGE Brain v1: read-only strategy proposal comparison over timing-lab observations.
// No order authorization, position changes, live gate changes, or new strike selection.
const {FAMILIES}=require('./timingLab');
const {PRIMARY}=require('./quickExit');
const {getProfile,optionOrderCharges}=require('../evidence/tradingFriction');
const VERSION='EDGE_BRAIN_RESEARCH_V1',PROFILE='UPSTOX_STANDARD_NSE_OPTIONS_2026';
const MIN=60000, IST=19800000, MAX_OUTLAY=10000, MAX_EVENT_AGE=5*MIN, QUOTE_AGE=15000;
const isNum=x=>typeof x==='number'&&Number.isFinite(x);
const round=x=>Math.round(x*100)/100;
const stamp=x=>typeof x==='string'?Date.parse(x):NaN;
const day=x=>new Date(x+IST).toISOString().slice(0,10);
const text=x=>typeof x==='string'&&x.length>0;
const key=(event,q)=>JSON.stringify([event.eventId,q.tier,q.instrumentKey]);
const NO_AUTH={executionAllowed:false,liveDecisionImpact:false,promotionEligible:false};
function validEvent(e,now){
 const at=stamp(e?.confirmedAt),closed=stamp(e?.candleClosedAt),recorded=stamp(e?.timestamp);
 return text(e?.eventId)&&FAMILIES.includes(e.family)&&['UP','DOWN'].includes(e.direction)&&
  [at,closed,recorded].every(Number.isFinite)&&closed<=at&&at<=recorded&&recorded<=now&&at-closed<=MAX_EVENT_AGE&&
  e.session===day(at)&&day(closed)===e.session&&day(recorded)===e.session&&text(e.sourceRuleVersion);
}
function contractCandidate(e,q){
 const at=stamp(e.confirmedAt),qa=stamp(q?.analysisAt),seen=stamp(q?.observedAt),recorded=stamp(e.timestamp);
 if(!q||!['A','B','C'].includes(q.tier)||!text(q.instrumentKey)||!text(q.contractId)||!isNum(q.strike)||q.strike<=0||
    q.type!==(e.direction==='UP'?'CE':'PE')||q.strategy!==(e.direction==='UP'?'LONG_CALL':'LONG_PUT')||
    typeof q.expiry!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(q.expiry)||q.expiry<e.session||
    !Number.isSafeInteger(q.lotSize)||q.lotSize<=0||
    !isNum(q.ask)||!isNum(q.bid)||q.bid<=0||q.ask<q.bid||
    ![qa,seen].every(Number.isFinite)||qa>seen||seen<at||seen>recorded||seen-at>QUOTE_AGE||seen-qa>QUOTE_AGE||qa<stamp(e.candleClosedAt))return null;
 const charges=optionOrderCharges({premium:q.ask,side:'BUY',quantity:q.lotSize,profile:getProfile(PROFILE)});
 if(!charges)return null;
 const outlay=round(q.ask*q.lotSize+charges.totalRupees),spread=(q.ask-q.bid)/q.ask;
 return {...q,outlay,spread,eligible:outlay<=MAX_OUTLAY&&spread<=0.025,
  reason:outlay>MAX_OUTLAY?'ILLUSTRATIVE_CAPITAL_LIMIT':spread>0.025?'SPREAD_TOO_WIDE':null,...NO_AUTH};
}
// Tie-break only on observed quote geometry and stable identity, never tier or future outcomes.
const compare=(a,b)=>a.spread-b.spread||a.outlay-b.outlay||a.instrumentKey.localeCompare(b.instrumentKey)||a.contractId.localeCompare(b.contractId)||a.tier.localeCompare(b.tier);
function proposalsFor(e){
 const all=(Array.isArray(e.candidateQuotes)?e.candidateQuotes:[]).map(q=>contractCandidate(e,q)).filter(Boolean);
 const sorted=all.filter(q=>q.eligible).sort(compare);
 const unique=new Map();
 for(const q of sorted){
  const k=q.instrumentKey;
  if(!unique.has(k))unique.set(k,{quote:q,tiers:[]});
  unique.get(k).tiers.push(q.tier);
 }
 const best=unique.values().next().value;
 return {eventId:e.eventId,family:e.family,direction:e.direction,session:e.session,sourceRuleVersion:e.sourceRuleVersion,
  confirmedAt:e.confirmedAt,recordedAt:e.timestamp,candleClosedAt:e.candleClosedAt,quote:best?.quote||null,
  equivalentTiers:best?[...new Set(best.tiers)].sort():[],candidateCount:all.length,
  eligibleContracts:unique.size,reason:best?null:all.length?'NO_AFFORDABLE_LIQUID_CONTRACT':'NO_MATCHING_EXISTING_STRIKE_QUOTE',...NO_AUTH};
}
function buildBrainReport(events=[],outcomes=[],now=Date.now()){
 if(!Number.isFinite(now))throw Error('BRAIN_REPORT_TIME_INVALID');
 const session=day(now),seen=new Set(),valid=[];
 // Exclude all duplicate event identities rather than silently choose an arbitrary revision.
 const counts=new Map();for(const e of events)counts.set(e?.eventId,(counts.get(e?.eventId)||0)+1);
 for(const e of events)if(validEvent(e,now)&&counts.get(e.eventId)===1){valid.push(e);seen.add(e.eventId);}
 const proposals=valid.map(proposalsFor).sort((a,b)=>stamp(a.confirmedAt)-stamp(b.confirmedAt)||a.eventId.localeCompare(b.eventId));
 // One first eligible proposal per strategy/version/session. This deliberately conservative
 // benchmark avoids counting repeated ticks or several tiers on one move as separate samples.
 const firstByDay=new Map(),unfilled=new Map();
 for(const p of proposals){
  if(p.session>=session)continue;
  const k=JSON.stringify([p.family,p.sourceRuleVersion,p.session]);
  if(!p.quote){unfilled.set(k,(unfilled.get(k)||0)+1);continue;}
  if(!firstByDay.has(k))firstByDay.set(k,p);
 }
 const outcomeIndex=new Map();
 for(const o of outcomes){
  const at=stamp(o?.timestamp);
  // A current/future session's outcome cannot influence today's report.
  if(!Number.isFinite(at)||at>now||day(at)>=session||!seen.has(o?.eventId))continue;
  const k=JSON.stringify([o.eventId,o.entryTier,o.instrumentKey]),rows=outcomeIndex.get(k)||[];
  rows.push(o);outcomeIndex.set(k,rows);
 }
 const buckets=new Map();
 for(const p of firstByDay.values()){
  const k=JSON.stringify([p.family,p.sourceRuleVersion]),b=buckets.get(k)||{family:p.family,sourceRuleVersion:p.sourceRuleVersion,days:0,measured:0,base:[],stress:[]};
  b.days++;
  const rows=(outcomeIndex.get(key(p,p.quote))||[]).filter(o=>o.session===p.session&&o.family===p.family&&o.direction===p.direction&&stamp(o.timestamp)>=stamp(p.recordedAt)).sort((a,b)=>stamp(a.timestamp)-stamp(b.timestamp));
  const hit=rows.find(o=>o.outcome?.status==='MEASURED');
  const entry=hit?.outcome?.entry,rule=hit?.outcome?.results?.[PRIMARY];
  const base=rule?.scenarios?.BASE_1PT?.estimatedNetRupees,stress=rule?.scenarios?.STRESS_2PT?.estimatedNetRupees;
  if(rule?.status==='MEASURED'&&entry?.instrumentKey===p.quote.instrumentKey&&entry?.contractId===p.quote.contractId&&
    entry?.ask===p.quote.ask&&entry?.lotSize===p.quote.lotSize&&entry?.observedAt===p.quote.observedAt&&
    isNum(base)&&isNum(stress)&&stress<=base){b.measured++;b.base.push(base);b.stress.push(stress);}
  buckets.set(k,b);
 }
 const mean=a=>a.length?round(a.reduce((x,y)=>x+y,0)/a.length):null;
 const history=[...buckets.values()].map(b=>({family:b.family,sourceRuleVersion:b.sourceRuleVersion,days:b.days,measuredDays:b.measured,
  meanNetBase:mean(b.base),meanNetStress:mean(b.stress),
  complete:b.days===b.measured,evidenceStatus:b.measured===0?'NO_MEASURED_OUTCOMES':b.measured!==b.days?'INCOMPLETE':'DESCRIPTIVE_ONLY',...NO_AUTH}));
 const current=proposals.filter(p=>p.session===session&&now-stamp(p.confirmedAt)<=QUOTE_AGE&&now-stamp(p.quote?.observedAt||'')<=QUOTE_AGE)
  .map(p=>({...p,history:history.find(b=>b.family===p.family&&b.sourceRuleVersion===p.sourceRuleVersion)||null}));
 // Ranking is descriptive (not a forecast or probability); no rank for incomplete/nonpositive stress evidence.
 const ranked=current.filter(p=>p.quote&&p.history?.complete&&p.history.measuredDays>=20&&p.history.meanNetStress>0)
  .sort((a,b)=>b.history.meanNetStress-a.history.meanNetStress||a.eventId.localeCompare(b.eventId));
 const conflict=new Set(current.filter(p=>p.quote).map(p=>p.direction)).size>1;
 // A report cannot send a trade or select a broker order. A research lead is not an executable choice.
 const lead=!conflict&&ranked.length&&(!ranked[1]||ranked[0].history.meanNetStress>ranked[1].history.meanNetStress)?ranked[0].eventId:null;
 return {version:VERSION,generatedAt:new Date(now).toISOString(),...NO_AUTH,action:'NO_ORDER',
  observationCount:events.length,validEvents:valid.length,invalidOrDuplicateEvents:events.length-valid.length,
  noMatchingQuoteEvents:proposals.filter(p=>!p.quote).length,history,activeProposals:current,
  latestProposals:proposals.slice(-20).reverse(),researchLeadEventId:lead,
  status:conflict?'DIRECTION_CONFLICT':lead?'DESCRIPTIVE_RESEARCH_LEAD':current.length?'INSUFFICIENT_COMPARABLE_EVIDENCE':'NO_CURRENT_PROPOSAL',
  evidenceBasis:'FIRST_ELIGIBLE_EVENT_PER_STRATEGY_VERSION_SESSION; PRIOR_SESSIONS_ONLY; MODELED_OHLC_EXITS',
  limitations:['20 measured days is a display threshold, not statistical validation or paper/live promotion.',
   'Strategies share sessions and market moves; evidence is correlated, not an independent portfolio backtest.',
   'Affordability uses illustrative starting capital, not actual buying power or monthly risk budget.',
   'An unavailable opposite-direction strike cannot be replaced by this layer; it preserves the existing candidate selector.',
   'Research report only; no real-time broker quote or order authorization. Missing outcomes are not silently treated as wins or losses.']};
}
module.exports={VERSION,buildBrainReport,proposalsFor};
