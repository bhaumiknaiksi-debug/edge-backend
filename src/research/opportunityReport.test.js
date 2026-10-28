'use strict';
const assert=require('node:assert/strict');
const R=require('./opportunityReport');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
const iso=t=>new Date(t).toISOString();
const leg=(strike=23000)=>({contractId:'NIFTY 03 NOV '+strike+' CE',instrumentKey:'NSE_FO|'+strike,strike,type:'CE',bid:99.95,ask:100,premium:100});
function observation(at=BASE,{strike=23000,ready=false,hash='rules-1',tier='C',cards=['A','C']}={}){
 const gates={market:true,regime:true,strategy:true,setup:true,trigger:ready,price:true,liquidity:true,risk:true,position:true};
 return {id:iso(at)+'|OPPORTUNITY',recordType:'OPPORTUNITY_OBSERVATION',timestamp:iso(at),observedAt:iso(at+100),ruleSpec:{implementationHash:hash},signalTier:{tier},
  candidates:cards.map(t=>({tier:t,strategy:'LONG_CALL',expiry:'2026-11-03',legs:{buyLeg:leg(strike),lotSize:65},lotSize:65,
   gates,gateScope:'CANDIDATE_REPLAY_OF_CURRENT_RULES',executionAllowed:t==='A'&&ready}))};
}
function fill({strike=23000,time='2026-10-28T10:00:30',side='BUY',key='f1'}={}){return {key,symbol:'NIFTY26N03'+strike+'CE',side,quantity:65,price:100,time,tradeDate:time.slice(0,10),orderId:key,tradeId:key};}
{
 const records=[observation(),observation(BASE+60000,{ready:true,tier:'A'})];
 const input={records,ledger:{brokerFills:[fill()]},now:BASE+4*3600000},f=R.buildOpportunityReport(input).fills[0];
 assert.equal(f.coverage.status,'FLAGGED_BUT_REJECTED');assert.equal(f.coverage.signalTier,'C');assert.ok(f.coverage.rejectedBy.includes('TRIGGER'));
 assert.ok(f.coverage.history.every(h=>Date.parse(h.at)<=BASE+30000),'future A never retroactively authorizes an earlier fill');
 assert.equal(R.buildOpportunityReport({...input,ledger:{brokerFills:[fill({time:'2026-10-09T10:00:30'})]}}).fills[0].coverage.status,'UNKNOWN_RECORDING_GAP');
 assert.equal(R.buildOpportunityReport({...input,ledger:{brokerFills:[fill({strike:23100})]}}).fills[0].coverage.status,'NOT_FLAGGED_AT_OBSERVED_POLL');
 const monthly=fill();monthly.symbol='NIFTY26NOV23000CE';assert.equal(R.buildOpportunityReport({...input,ledger:{brokerFills:[monthly]}}).fills[0].coverage.status,'UNRESOLVED_CONTRACT_OR_TIME');
 assert.equal(R.candidateEpisodes(R.normalizeObservations(records)).length,2,'same card/contract repeated does not add samples');
 const approved=R.buildOpportunityReport({...input,records:[observation(BASE,{ready:true,tier:'A'})]});assert.equal(approved.fills[0].coverage.status,'FLAGGED_AND_READY');assert.equal(approved.gateChangeQueue.length,0,'an executable A matching a research C is not a missed trade');
 const replaced=R.buildOpportunityReport({...input,records:[observation(BASE,{ready:true,tier:'A'}),observation(BASE+20000,{strike:23100,ready:true,tier:'A'})]});
 assert.equal(replaced.fills[0].coverage.status,'NOT_FLAGGED_AT_OBSERVED_POLL');assert.equal(replaced.fills[0].coverage.history.length,1);assert.equal(replaced.fills[0].coverage.observedAt,iso(BASE+20000));
 const missing=R.buildOpportunityReport({...input,records:[{id:'old',recordType:'POLL_SNAPSHOT',timestamp:iso(BASE)}]});assert.equal(missing.fills[0].coverage.status,'UNKNOWN_CANDIDATE_RECORD','a poll without candidate metadata is not proof that a contract was absent');
 const savedC={id:'zzzz-snapshot',payload:{analysisAt:iso(BASE),capturedAt:iso(BASE+10000),tier:'C',actualSignalTier:'A',expiry:'2026-11-03',strategy:'LONG_CALL',selectedCandidate:{strategy:'LONG_CALL',legs:{buyLeg:leg()}},authorization:{executionAllowed:false}}};
 const withSnapshot=R.buildOpportunityReport({...input,records:[observation(BASE,{ready:true,tier:'A'})],snapshots:[savedC]});
 assert.equal(withSnapshot.fills[0].coverage.status,'FLAGGED_AND_READY');assert.equal(withSnapshot.gateChangeQueue.length,0);assert.equal(withSnapshot.fills[0].coverage.history.length,1);assert.equal(withSnapshot.fills[0].coverage.history[0].source,'CENSUS');
 const newer=structuredClone(savedC);newer.payload.analysisAt=iso(BASE+10000);newer.payload.capturedAt=iso(BASE+20000);newer.payload.actualSignalTier='C';
 const savedAfterPoll=R.buildOpportunityReport({...input,records:[observation(BASE,{strike:23100})],snapshots:[newer]});assert.equal(savedAfterPoll.fills[0].coverage.status,'FLAGGED_BUT_REJECTED');assert.equal(savedAfterPoll.fills[0].coverage.primaryMiss,'RESEARCH_ONLY','newer selected-contract evidence is not erased by an older complete poll');
 const partialOther=structuredClone(newer);partialOther.payload.selectedCandidate.legs.buyLeg=leg(23100);
 const uncertain=R.buildOpportunityReport({...input,records:[observation(BASE,{ready:true,tier:'A'})],snapshots:[partialOther]});assert.equal(uncertain.fills[0].coverage.status,'UNKNOWN_CANDIDATE_RECORD','a newer partial analysis does not prove that an older candidate remains ready or is absent');
 const readiness=R.candidateEpisodes(R.normalizeObservations(records),{axis:'READINESS_TIER'});assert.deepEqual(readiness.map(e=>e.tier),['C','A']);
 const pre=observation(),open=observation(BASE+30000);pre.marketPhase='PRE_OPEN';open.marketPhase='OPEN';assert.equal(R.candidateEpisodes(R.normalizeObservations([pre,open])).length,4,'market open starts a new measurable episode after a premarket flag');
 const different=observation();different.candidates[0].strategy='BULL_CALL_SPREAD';different.candidates[0].legs.sellLeg={...leg(23100),bid:40,ask:40.05};different.candidates[1].gates=null;
 const separate=R.buildOpportunityReport({...input,records:[different]}).fills[0].coverage;
 assert.deepEqual(separate.rejectedBy,['RESEARCH_ONLY']);assert.ok(separate.relatedPlanGates[0].rejectedBy.includes('TRIGGER'),'a spread rejection remains separate from the single-leg C trade');
}
{
 const records=[observation(),observation(BASE+30000),observation(BASE+60000,{hash:'rules-2'}),observation(BASE+240000,{hash:'rules-2'})];
 assert.equal(R.candidateEpisodes(R.normalizeObservations(records)).length,6,'rule changes and recording gaps split episodes');
}
{
 const records=[0,60000,120000].map((n,i)=>observation(BASE+n,{strike:23000+i*50,cards:['C']}));
 const episodes=R.candidateEpisodes(R.normalizeObservations(records));
 for(const [i,ep] of episodes.entries())if(i<2)records.push({id:'out-'+i,recordType:'OPPORTUNITY_OUTCOME',episodeId:ep.id,timestamp:iso(BASE+7200000),outcome:{status:'MEASURED',
  entryLegMarks:{buyLeg:{contractId:leg(23000+i*50).contractId,side:'BUY',price:100}},horizonLegMarks:{60:{timestamp:iso(Date.parse(ep.at)+3600000),marks:{buyLeg:i===0?102:99}}}}});
 const report=R.buildOpportunityReport({records,now:BASE+7200000}),c=report.byCandidateTier.find(t=>t.tier==='C');
 assert.equal(c.flagged,3);assert.equal(c.measured,2);assert.equal(c.unmeasured,1);assert.equal(c.wins,1);assert.equal(c.losses,1);assert.equal(c.estimatedMeanNetRupees,-67.5);
 assert.equal(report.candidateEpisodes[2].result.status,'UNMEASURED');assert.deepEqual(report.gateChangesApplied,[]);
 assert.equal(R.buildOpportunityReport({records,now:BASE+30*60000}).byCandidateTier.find(t=>t.tier==='C').measured,0,'future horizon results are not available before their observation time');
 const mutated=structuredClone(records);mutated[3].outcome.horizonLegMarks[60].timestamp=iso(BASE+7200000);
 assert.equal(R.buildOpportunityReport({records:mutated,now:BASE+7200000}).byCandidateTier.find(t=>t.tier==='C').measured,1,'distant candle not accepted as the requested horizon');
 mutated.push({id:'repaired-loss',recordType:'OPPORTUNITY_OUTCOME',episodeId:episodes[0].id,timestamp:iso(BASE+3*3600000),outcome:{status:'MEASURED',entryLegMarks:{buyLeg:{contractId:leg().contractId,side:'BUY',price:100}},horizonLegMarks:{60:{timestamp:iso(BASE+3600000),marks:{buyLeg:99}}}}});
 const repaired=R.buildOpportunityReport({records:mutated,now:BASE+4*3600000});assert.equal(repaired.candidateEpisodes[0].result.sourceId,'repaired-loss');assert.equal(repaired.byCandidateTier.find(t=>t.tier==='C').measured,2);
 mutated.push({...mutated.at(-1),id:'later-bigger-win',timestamp:iso(BASE+3.5*3600000),outcome:{...mutated.at(-1).outcome,horizonLegMarks:{60:{timestamp:iso(BASE+3600000),marks:{buyLeg:150}}}}});
 assert.equal(R.buildOpportunityReport({records:mutated,now:BASE+4*3600000}).candidateEpisodes[0].result.sourceId,'repaired-loss','choose first valid measurement, never the most profitable retry');
}
{
 const snapshot={id:'snapshot',payload:{analysisAt:iso(BASE),capturedAt:iso(BASE+60000),tier:'C',actualSignalTier:'C',expiry:'2026-11-03',strategy:'LONG_CALL',selectedCandidate:{strategy:'LONG_CALL',legs:{buyLeg:leg()}},authorization:{executionAllowed:false}}};
 const report=R.buildOpportunityReport({snapshots:[snapshot],ledger:{brokerFills:[fill()]},now:BASE+7200000});
 assert.equal(report.fills[0].coverage.status,'POST_TRADE_SNAPSHOT_ONLY');assert.equal(report.snapshots.length,1);
 assert.equal(report.snapshots[0].actualSignalTier,'C');assert.equal(report.totals.candidateEpisodes,0,'manual clicks are not a population of all flagged candidates');
}
{
 const records=Array.from({length:3000},(_,i)=>observation(BASE+i*1000,{strike:23000+i})),start=performance.now();
 const report=R.buildOpportunityReport({records,now:BASE+4*3600000});
 assert.equal(report.totals.candidateEpisodes,6000);assert.ok(performance.now()-start<5000,'large all-candidate report must not regress to quadratic outcome scans');
}
console.log('Opportunity report PASS: exact contract/time matching, no hindsight, gaps, dedupe, both tier axes, wins/losses/unavailable results and 3,000-poll scale regression');
module.exports={observation,fill,BASE,iso};
