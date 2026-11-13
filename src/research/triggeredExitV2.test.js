'use strict';
const assert=require('node:assert/strict');
const {measureTriggered,modeledNet,buildTriggeredExitReport,VERSION}=require('./triggeredExitV2');
const {buildOpportunityReport,normalizeObservations,candidateEpisodes}=require('./opportunityReport');
const {createOpportunityResearch}=require('./opportunityService');
const M=60000,T=Date.parse('2026-10-28T10:00:00+05:30'),iso=t=>new Date(t).toISOString();
const candidate=()=>({tier:'C',strategy:'LONG_CALL',expiry:'2026-11-03',lotSize:65,
 legs:{lotSize:65,buyLeg:{instrumentKey:'NSE_FO|1',contractId:'NIFTY-1',strike:23000,type:'CE',bid:99,ask:100}}});
const validTrigger=()=>({at:iso(T+30000),analysisAt:iso(T+25000),ask:100,bid:99,lotSize:65,
 instrumentKey:'NSE_FO|1',contractId:'NIFTY-1',breakoutId:'sample-cross',
 timingRule:'OPENING_RANGE_SHADOW_V3',crossedAt:iso(T-60000),entryWindowEndsAt:iso(T+8*M)});
const bar=(t,o,h,l,c)=>({timestamp:iso(t),open:o,high:h,low:l,close:c});
const bars=[bar(T,100,180,99,170),bar(T+M,100,101,99,100),bar(T+2*M,100,109,99,108)];
const obs=(at,ready,ask)=>({id:iso(at)+'|OPPORTUNITY',recordType:'OPPORTUNITY_OBSERVATION',
 timestamp:iso(at),observedAt:iso(at+5000),marketPhase:'OPEN',ruleSpec:{implementationHash:'unchanged-rules'},
 signalTier:{tier:'C'},candidates:[{...candidate(),legs:{...candidate().legs,buyLeg:{...candidate().legs.buyLeg,ask}},
 triggerObservation:{timingRule:'OPENING_RANGE_SHADOW_V3',status:ready?'CONFIRMED':'WAITING',
 shadowEntryReady:ready,breakoutId:ready?'sample-cross':null,
 crossedAt:ready?iso(T-60000):null,entryWindowEndsAt:ready?iso(T+8*M):null}}]});
{
 const result=measureTriggered({candidate:candidate(),trigger:validTrigger(),candles:bars});
 assert.equal(result.version,VERSION);assert.equal(result.status,'MEASURED');
 assert.equal(result.entry.firstCandleAt,iso(T+M),'no intra-candle look-ahead');
 assert.equal(result.results.T8_S8_30M.exit,'TARGET');
 assert.equal(result.results.T8_S8_30M.referenceExitPrice,108);
 assert.equal(result.results.T8_S8_30M.scenarios.BASE_1PT.assumedSellPrice,107);
 assert.ok(result.results.T8_S8_30M.scenarios.BASE_1PT.estimatedNetRupees>300);
 assert.ok(result.results.T8_S8_30M.scenarios.STRESS_2PT.estimatedNetRupees<result.results.T8_S8_30M.scenarios.BASE_1PT.estimatedNetRupees);
 assert.ok(result.results.T8_S8_30M.scenarios.OPTIMISTIC_0PT.estimatedNetRupees>result.results.T8_S8_30M.scenarios.BASE_1PT.estimatedNetRupees);
 assert.equal(measureTriggered({candidate:candidate(),trigger:validTrigger(),candles:[bars[0],bars[2]]}).reason,'INCOMPLETE_EXIT_CANDLE_PATH','never jump across missing candles');
 const both=measureTriggered({candidate:candidate(),trigger:validTrigger(),
  candles:[bar(T+M,100,109,91,100)]});
 assert.equal(both.results.T8_S8_30M.exit,'STOP','if stop and target touched in same minute, count stop');
 const gap=measureTriggered({candidate:candidate(),trigger:validTrigger(),
  candles:[bar(T+M,88,91,87,89)]});
 assert.equal(gap.results.T8_S8_30M.referenceExitPrice,88,'stop gap fills at candle open, not ideal stop');
 const stale={...validTrigger(),analysisAt:iso(T)};
 assert.equal(measureTriggered({candidate:candidate(),trigger:stale,candles:bars}).reason,'UNTRUSTED_TRIGGER_TIMING_OR_STALE_ASK');
 const later={...validTrigger(),entryWindowEndsAt:iso(T+20000)};
 assert.equal(measureTriggered({candidate:candidate(),trigger:later,candles:bars}).reason,'UNTRUSTED_TRIGGER_TIMING_OR_STALE_ASK');
 const mismatch={...validTrigger(),instrumentKey:'NSE_FO|other'};
 assert.equal(measureTriggered({candidate:candidate(),trigger:mismatch,candles:bars}).reason,'TRIGGER_CONTRACT_MISMATCH');
 assert.equal(measureTriggered({candidate:candidate(),trigger:validTrigger(),candles:[bars[1],bars[1]]}).reason,'DUPLICATE_EXIT_CANDLE');
 const fee=modeledNet({entry:100,referenceExitPrice:108,quantity:65,exitHaircutPoints:1});
 assert.equal(fee.assumedSellPrice,107);assert.ok(fee.feesRupees>50&&fee.feesRupees<100,'explicit taxes and brokerage');
 assert.equal(modeledNet({entry:100,referenceExitPrice:108,quantity:0}),null);
}
{
 const first=obs(T,false,96),later=obs(T+25000,true,100);
 const eps=candidateEpisodes(normalizeObservations([first,later]));
 assert.equal(eps.length,1,'one episode across multiple polls');
 assert.equal(eps[0].candidate.legs.buyLeg.ask,96,'first flag is retained');
 assert.equal(eps[0].firstConfirmed.ask,100,'confirmed ask is not retroactively replaced by the first flag ask');
 assert.equal(eps[0].firstConfirmed.at,iso(T+30000));
 assert.equal(candidateEpisodes(normalizeObservations([first]))[0].firstConfirmed,undefined,'no invented trigger without V3 confirmation');
 const out=measureTriggered({candidate:eps[0].candidate,trigger:eps[0].firstConfirmed,candles:bars});
 assert.equal(out.status,'MEASURED');
 const rec={id:'triggered-outcome',recordType:'OPPORTUNITY_TRIGGER_EXIT_V2',timestamp:iso(T+40*M),
  episodeId:eps[0].id,terminal:true,outcome:out};
 const report=buildOpportunityReport({records:[first,later,rec],now:T+45*M});
 assert.equal(report.triggeredExitV2.overall.episodes,1);
 assert.equal(report.triggeredExitV2.overall.confirmed,1);
 assert.equal(report.triggeredExitV2.overall.measured,1);
 assert.equal(report.triggeredExitV2.overall.distinctMeasuredDays,1);
 assert.equal(report.triggeredExitV2.overall.pairedWithFirstFlag,0,'do not invent baseline V1 outcome');
 assert.equal(report.triggeredExitV2.promotionEligible,false);
 const older=buildOpportunityReport({records:[first,later,rec],now:T+30*M});
 assert.equal(older.triggeredExitV2.overall.measured,0,'no future outcomes enter earlier reports');
 const missing=buildOpportunityReport({records:[first],now:T+45*M});
 assert.equal(missing.triggeredExitV2.overall.unmeasuredReasons.NO_CONFIRMED_V3_ENTRY,1);
 const pairs=buildTriggeredExitReport([{tier:'C',session:'2026-10-28',at:iso(T),confirmedAt:iso(T+30000),
  triggered:out,firstFlag:{status:'MEASURED',entry:96,lotSize:65,
   results:{T8_S8_30M:{status:'MEASURED',exitPrice:104}}}}]);
 assert.equal(pairs.overall.pairedWithFirstFlag,1,'same fee profile for paired first-flag and confirmed outcomes');
}
(async()=>{
 const records=[obs(T,false,96),obs(T+25000,true,100)],writes=[],fetched=[];
 const service=createOpportunityResearch({pool:{},token:'research-read-only',ownerToken:'owner-secret',
  store:{async append(r){writes.push(r);records.push(r);return true;}},
  dependencies:{now:()=>T+45*M,load:async()=>({records:structuredClone(records),ledger:{brokerFills:[]},snapshots:[]}),
    fetchCandles:async leg=>{fetched.push(leg.instrumentKey);return bars;}}});
 await service.runTriggeredExitV2();
 assert.equal(writes.length,1);assert.equal(writes[0].recordType,'OPPORTUNITY_TRIGGER_EXIT_V2');
 assert.equal(writes[0].outcome.status,'MEASURED');assert.equal(fetched.length,1);
 assert.equal(writes[0].terminal,true);assert.ok(!JSON.stringify(writes).includes('research-read-only'));
 service.invalidate();await service.runTriggeredExitV2();
 assert.equal(writes.length,1,'never duplicate an already measured result');
 service.stop();
 console.log('Triggered entry/exit V2 PASS: recorded V3 entry, same-contract ask, full candle coverage, modeled fees/slippage, no lookahead, paired comparisons, bounded durable collection');
})().catch(e=>{console.error(e);process.exitCode=1;});
