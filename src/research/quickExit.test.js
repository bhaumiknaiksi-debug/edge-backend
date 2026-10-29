'use strict';
const assert=require('node:assert/strict');
const {simulate,measureCard,normalize,buildQuickExitReport,expiryBucket,RULES,PRIMARY}=require('./quickExit');
const {createOpportunityResearch}=require('./opportunityService');
const {buildOpportunityReport}=require('./opportunityReport');
const FLAG=Date.parse('2026-10-15T10:02:20+05:30'),M=60000,iso=t=>new Date(t).toISOString();
const rule={target:8,stop:8,maxMinutes:30};
// 1-minute candles from the minute after the flag; each item [open,high,low,close].
const series=(start,bars)=>bars.map((b,i)=>({timestamp:iso(start+i*M),open:b[0],high:b[1],low:b[2],close:b[3]}));
const after=Date.parse('2026-10-15T10:03:00+05:30');
const flat=(n,p=100)=>Array.from({length:n},()=>[p,p+1,p-1,p]);
const run=(bars,extra={})=>simulate({entry:100,candles:normalize(series(after,bars)),startMs:FLAG,lotSize:65,rule,...extra});

// --- simulation ---
{
 const t=run([[100,104,99,103],[103,108.5,102,108]]);
 assert.equal(t.exit,'TARGET');assert.equal(t.grossPoints,8);assert.equal(t.grossRupees,520);assert.equal(t.estimatedNetRupees,420);assert.equal(t.minutes,3,'minutes counted from the flag to the end of the exit candle');
 const s=run([[100,101,95,96],[96,97,91,92]]);
 assert.equal(s.exit,'STOP');assert.equal(s.grossPoints,-8);assert.equal(s.estimatedNetRupees,-620);
 const both=run([[100,109,91,100]]);assert.equal(both.exit,'STOP','a minute that touches both counts as the stop');
 const gap=run([[100,101,99,100],[88,90,87,89]]);assert.equal(gap.exit,'STOP');assert.equal(gap.grossPoints,-12,'a gap through the stop fills at the open, not the stop');
 const time=run(flat(30,103));assert.equal(time.exit,'TIME');assert.equal(time.grossPoints,3);assert.equal(time.minutes,31,'flag at :20 seconds, last candle in the window closes 30m40s later');
 const early=run(flat(5));assert.equal(early.status,'UNAVAILABLE');assert.equal(early.reason,'INCOMPLETE_CANDLE_WINDOW','missing data never reads as a time exit');
 const before=simulate({entry:100,candles:normalize(series(FLAG-10*M,[[100,120,99,119]])),startMs:FLAG,lotSize:65,rule});
 assert.equal(before.reason,'NO_CANDLES_AFTER_FLAG','candles before the flag are never used');
 // Near the close the window ends at the 15:29 candle, and a time exit there is valid.
 const late=Date.parse('2026-10-15T15:20:30+05:30'),bars=series(Date.parse('2026-10-15T15:21:00+05:30'),flat(9,102));
 const closing=simulate({entry:100,candles:normalize(bars),startMs:late,lotSize:65,rule});
 assert.equal(closing.exit,'TIME');assert.equal(closing.grossPoints,2);
 assert.equal(RULES.filter(r=>r.primary).length,1);assert.equal(PRIMARY,'T8_S8_30M');
}
// --- one card ---
{
 const card={strategy:'LONG_CALL',lotSize:65,expiry:'2026-10-19',legs:{lotSize:65,buyLeg:{instrumentKey:'NSE_FO|1',ask:100,bid:99.9}}};
 const m=measureCard({candidate:card,at:iso(FLAG),candles:series(after,[[100,108,99,108]])});
 assert.equal(m.status,'MEASURED');assert.equal(m.results.T8_S8_30M.exit,'TARGET');assert.equal(m.results.T6_S6_30M.exit,'TARGET');
 assert.equal(m.results.T10_S10_30M.status,'UNAVAILABLE','each rule is measured on its own');
 assert.equal(measureCard({candidate:{...card,strategy:'BULL_CALL_SPREAD',legs:{...card.legs,sellLeg:{}}},at:iso(FLAG),candles:[]}).reason,'NOT_SINGLE_LEG_LONG');
 assert.equal(measureCard({candidate:{...card,legs:{...card.legs,buyLeg:{instrumentKey:'NSE_FO|1'}}},at:iso(FLAG),candles:series(after,flat(31))}).reason,'NO_EXECUTABLE_ENTRY_PRICE','an LTP is never used as the entry');
}
// --- summary ---
{
 assert.equal(expiryBucket('2026-10-19','2026-10-19'),'EXPIRY_DAY');assert.equal(expiryBucket('2026-10-19','2026-10-16'),'DAY_BEFORE_EXPIRY');assert.equal(expiryBucket('2026-10-27','2026-10-16'),'OTHER_DAYS');
 const r=(tier,strategy,net,exit,session='2026-10-15')=>({tier,strategy,expiry:'2026-10-19',session,at:session+'T05:00:00.000Z',status:'MEASURED',
  results:{T8_S8_30M:{status:'MEASURED',exit,minutes:4,estimatedNetRupees:net}}});
 const rep=buildQuickExitReport([r('C','LONG_CALL',420,'TARGET'),r('C','LONG_PUT',-620,'STOP','2026-10-19'),r('A','LONG_CALL',95,'TIME'),{tier:'C',strategy:'LONG_CALL',status:'UNMEASURED',reason:'NOT_YET_MEASURED'}]);
 const all=rep.overall.T8_S8_30M;
 assert.equal(all.flagged,4);assert.equal(all.measured,3);assert.equal(all.wins,2);assert.equal(all.losses,1);assert.equal(all.targetHits,1);assert.equal(all.stopHits,1);assert.equal(all.timeExits,1);
 assert.equal(all.totalNetRupees,-105);assert.equal(all.meanNetRupees,-35);assert.equal(all.days,2);
 const c=rep.byCardTier.T8_S8_30M.find(x=>x.key==='C');assert.equal(c.measured,2);assert.equal(c.totalNetRupees,-200);
 assert.equal(rep.byExpiry.T8_S8_30M.find(x=>x.key==='EXPIRY_DAY').totalNetRupees,-620);
 assert.equal(rep.unmeasuredReasons.NOT_YET_MEASURED,1);assert.ok(rep.limits.some(x=>x.includes('sensitivity')));
}
// --- collection: one candle download per contract-day, every card on it measured, waits for the window ---
(async()=>{
 const T=Date.parse('2026-10-28T10:00:00+05:30');
 const obs=(i,key,strategy='LONG_CALL')=>({id:'poll-'+i,recordType:'OPPORTUNITY_OBSERVATION',timestamp:iso(T+i*60000),observedAt:iso(T+i*60000),ruleSpec:{implementationHash:'rules-test'},signalTier:{tier:'C'},marketPhase:'OPEN',
  candidates:[{tier:'C',strategy,expiry:'2026-11-03',lotSize:65,legs:{lotSize:65,buyLeg:{contractId:'c-'+key,instrumentKey:'NSE_FO|'+key,strike:23000,type:'CE',bid:99.95,ask:100},...(strategy==='LONG_CALL'?{}:{sellLeg:{contractId:'s',instrumentKey:'NSE_FO|9',strike:23100,type:'CE',bid:50,ask:50.1}})}}]});
 // Two separate episodes on contract 1 (a 3-minute gap restarts it), one on contract 2, one spread (never measured).
 const records=[obs(0,1),obs(4,1),obs(5,2),obs(6,3,'BULL_CALL_SPREAD')];
 records[1].candidates[0].legs.buyLeg.strike=23000;
 let clock=T+20*60000;const writes=[],fetched=[];
 const candlesFor=start=>series(start,[[100,101,99,100],[100,109,99,108],...flat(40,108)]);
 const service=createOpportunityResearch({pool:{},token:'t',ownerToken:'o',store:{async append(r){writes.push(r);records.push(r);return true;}},
  dependencies:{now:()=>clock,load:async()=>({records:structuredClone(records),ledger:{brokerFills:[]},snapshots:[]}),
   fetchCandles:async(leg)=>{fetched.push(leg.instrumentKey);return candlesFor(T);}}});
 await service.runQuickExit();assert.equal(writes.length,0,'nothing is measured before its 30-minute window has passed');
 clock=T+45*60000;service.invalidate();await service.runQuickExit();
 assert.deepEqual(fetched.sort(),['NSE_FO|1','NSE_FO|2'],'one download per contract and day, none for the spread');
 const quick=writes.filter(w=>w.recordType==='OPPORTUNITY_QUICK_EXIT');
 assert.equal(quick.length,3,'both episodes on contract 1 and the one on contract 2');
 assert.ok(quick.every(w=>w.terminal&&w.outcome.status==='MEASURED'&&w.measurementRule==='QUICK_EXIT_V1'));
 assert.ok(quick.every(w=>!JSON.stringify(w).includes('"t"')),'no token in records');
 service.invalidate();await service.runQuickExit();assert.equal(writes.length,3,'measured episodes are not measured again');
 // The report picks the records up.
 const report=buildOpportunityReport({records,ledger:{brokerFills:[]},snapshots:[],now:clock});
 assert.equal(report.quickExit.overall.T8_S8_30M.measured,3);assert.equal(report.quickExit.episodes,3,'spread excluded from the quick-exit cohort');
 const ep=report.candidateEpisodes.find(e=>e.quickExit?.rule);assert.ok(ep&&['TARGET','STOP','TIME'].includes(ep.quickExit.exit));
 // A failed download retries with backoff and stops after three attempts.
 const rows=[obs(0,7)],failWrites=[];let t2=T+45*60000;
 const failing=createOpportunityResearch({pool:{},token:'t',ownerToken:'o',store:{async append(r){failWrites.push(r);rows.push(r);return true;}},
  dependencies:{now:()=>t2,load:async()=>({records:structuredClone(rows),ledger:{brokerFills:[]},snapshots:[]}),fetchCandles:async()=>{throw Error('x');}}});
 await failing.runQuickExit();assert.equal(failWrites[0].outcome.reason,'CANDLE_FETCH_UNAVAILABLE');assert.equal(failWrites[0].terminal,false);
 failing.invalidate();await failing.runQuickExit();assert.equal(failWrites.length,1,'waits for the retry time');
 for(let i=0;i<3;i++){t2+=20*60000;failing.invalidate();await failing.runQuickExit();}
 assert.equal(failWrites.length,3);assert.equal(failWrites[2].terminal,true,'gives up after three attempts');
 console.log('quickExit PASS: target/stop/time fills, stop-first on ambiguous minutes, gap fills, no LTP entries, incomplete data unmeasured, one download per contract-day, retries bounded, report grouping');
})().catch(e=>{console.error(e);process.exit(1);});
