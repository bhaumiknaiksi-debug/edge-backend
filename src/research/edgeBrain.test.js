'use strict';
const assert=require('node:assert/strict');
const {buildBrainReport,proposalsFor}=require('./edgeBrain');
const {PRIMARY}=require('./quickExit');
const at=(day,clock='10:00:00')=>Date.parse(day+'T'+clock+'+05:30');
const iso=t=>new Date(t).toISOString();
const today='2026-11-16',now=at(today)+2000;
function event({session=today,family='ORB_1M',direction='UP',id='e',version='known-version',quote=true}={}){
 const t=at(session),type=direction==='UP'?'CE':'PE',strategy=type==='CE'?'LONG_CALL':'LONG_PUT';
 const q={tier:'C',strategy,expiry:'2026-11-17',contractId:'NIFTY 17 NOV 25000 '+type,instrumentKey:'NSE_FO|'+type,
  strike:25000,type,lotSize:65,ask:100,bid:99.5,analysisAt:iso(t-1000),observedAt:iso(t)};
 return {eventId:id,family,direction,session,sourceRuleVersion:version,timestamp:iso(t),confirmedAt:iso(t),
  candleClosedAt:iso(t-120000),candidateQuotes:quote?[q]:[]};
}
function outcome(e,base=200,stress=135){
 const q=e.candidateQuotes[0];
 return {eventId:e.eventId,entryTier:q.tier,instrumentKey:q.instrumentKey,session:e.session,family:e.family,direction:e.direction,
  timestamp:iso(at(e.session,'11:00:00')),outcome:{status:'MEASURED',entry:{...q},results:{[PRIMARY]:{status:'MEASURED',scenarios:{
   BASE_1PT:{estimatedNetRupees:base},STRESS_2PT:{estimatedNetRupees:stress}}}}}};
}
const e=event(),q=e.candidateQuotes[0];
assert.equal(proposalsFor(e).quote.tier,'C','Tier C is not blocked by a legacy readiness gate');
assert.equal(proposalsFor({...e,candidateQuotes:[{...q,tier:'A'},q]}).eligibleContracts,1,'duplicate cards are one contract');
assert.deepEqual(proposalsFor({...e,candidateQuotes:[{...q,tier:'A'},q]}).equivalentTiers,['A','C']);
assert.equal(proposalsFor({...e,candidateQuotes:[{...q,type:'PE'}]}).quote,null);
assert.equal(proposalsFor({...e,candidateQuotes:[{...q,ask:200,bid:199}]}).quote,null);
assert.equal(proposalsFor({...e,candidateQuotes:[{...q,analysisAt:iso(at(today)-16000)}]}).quote,null);
assert.equal(proposalsFor({...e,candidateQuotes:[{...q,bid:0}]}).quote,null);
const empty=buildBrainReport([event({quote:false})],[],now);
assert.equal(empty.noMatchingQuoteEvents,1);
assert.equal(empty.activeProposals[0].reason,'NO_MATCHING_EXISTING_STRIKE_QUOTE');
assert.equal(empty.action,'NO_ORDER');
assert.equal(buildBrainReport([e,e],[],now).validEvents,0);
assert.equal(buildBrainReport([{...e,timestamp:iso(now+1000)}],[],now).validEvents,0);
assert.equal(buildBrainReport([e],[],now+30000).activeProposals.length,0);
const prior=[];
for(let i=1;prior.length<20;i++){
 const d=new Date(Date.parse(today+'T00:00:00Z')-i*86400000);
 if([0,6].includes(d.getUTCDay()))continue;
 prior.push(event({session:d.toISOString().slice(0,10),id:'past-'+i}));
}
const history=prior.map(x=>outcome(x));
let r=buildBrainReport([...prior,e],history,now);
assert.equal(r.researchLeadEventId,e.eventId);
assert.equal(r.history[0].measuredDays,20);
assert.equal(r.action,'NO_ORDER');
assert.equal(r.promotionEligible,false);
assert.equal(r.executionAllowed,false);
const repeated={...prior[0],eventId:'repeat',confirmedAt:iso(at(prior[0].session)+2000),timestamp:iso(at(prior[0].session)+2000),
 candidateQuotes:prior[0].candidateQuotes.map(q=>({...q,observedAt:iso(at(prior[0].session)+2000)}))};
r=buildBrainReport([...prior,repeated,e],[...history,outcome(repeated,5000,4900)],now);
assert.equal(r.history[0].days,20);assert.equal(r.history[0].meanNetStress,135);
r=buildBrainReport([...prior,e],history.slice(1),now);
assert.equal(r.researchLeadEventId,null);assert.equal(r.history[0].evidenceStatus,'INCOMPLETE');
r=buildBrainReport([...prior,e],prior.map(x=>outcome(x,10,-55)),now);
assert.equal(r.researchLeadEventId,null);
r=buildBrainReport([...prior,e,event({family:'FUTURES_VWAP_PULLBACK',direction:'DOWN',id:'opposite'})],history,now);
assert.equal(r.status,'DIRECTION_CONFLICT');assert.equal(r.researchLeadEventId,null);
r=buildBrainReport([...prior,e],history.map((o,i)=>i===0?{...o,timestamp:iso(at(today,'11:00:00'))}:o),now);
assert.equal(r.history[0].measuredDays,19,'future outcome must not leak into the current report');
r=buildBrainReport([...prior,e],history.map((o,i)=>i===0?{...o,outcome:{...o.outcome,entry:{...o.outcome.entry,ask:999}}}:o),now);
assert.equal(r.history[0].measuredDays,19,'a different entry cannot be attributed to this proposal');
console.log('EDGE Brain PASS: tier independent proposals, exact contract/direction, cost and freshness gates, correlated sample reduction, no future outcomes, conflict abstention, no authorization');
