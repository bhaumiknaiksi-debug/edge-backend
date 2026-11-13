'use strict';
const assert=require('node:assert/strict');
const L=require('./timingLab');
const {createOpportunityResearch}=require('./opportunityService');
const {buildOpportunityReport}=require('./opportunityReport');
const MIN=60000,FIVE=5*MIN;
const DAY='2026-11-12',t=x=>Date.parse(DAY+'T'+x+'+05:30'),iso=x=>new Date(x).toISOString();
const candle=(at,o,h,l,c,v=1000)=>[iso(at),o,h,l,c,v];
const opening5=[
 candle(t('09:15:00'),95,100,90,95),candle(t('09:20:00'),95,100,91,95),
 candle(t('09:25:00'),95,99,92,95),candle(t('09:30:00'),95,104,94,102)
];
const future5=Array.from({length:9},(_,i)=>{
 const p=100+i;return candle(t('09:15:00')+i*FIVE,p,p+1,p-1,p+0.5,1000+i*100);
});
const minute1=Array.from({length:25},(_,i)=>{
 const at=t('09:15:00')+i*MIN;
 if(i===16)return candle(at,95,103,95,102);
 if(i===17)return candle(at,102,104,101,103);
 if(i>=18)return candle(at,103,104,102,103);
 return candle(at,95,96,94,95);
});
const at1=t('09:34:40'),at2=t('09:35:50');
const read1=minute1.filter(c=>Date.parse(c[0])+MIN<=at1-30000);
const read2=minute1.filter(c=>Date.parse(c[0])+MIN<=at2-30000);
const market5=opening5.concat(candle(t('09:35:00'),102,104,99,103));
const runData=(now,one=read1,ix=opening5)=>({now,index1m:one,index5m:ix,
 future5m:future5.filter(c=>Date.parse(c[0])+FIVE<=now-30000),index1mFetchedAt:now});
{
 assert.equal(L.VERSION,'TIMING_LAB_V1');
 assert.equal(L.parsed(read1,MIN,at1,DAY).ok,true);
 const broken=read1.filter(c=>Date.parse(c[0])!==t('09:28:00'));
 assert.equal(L.parsed(broken,MIN,at1,DAY).reason,'SESSION_CANDLE_GAP','missing intermediate candles fail closed');
 const duplicate=[...read1,read1[5]];
 assert.equal(L.parsed(duplicate,MIN,at1,DAY).reason,'DUPLICATE_PROVIDER_CANDLE');
 const lab=L.createTimingLab(),first=lab.observe(runData(at1));
 assert.equal(first.events.length,0,'one provider read cannot confirm a signal');
 const repeat=lab.observe({...runData(at2,read2,market5),index1mFetchedAt:at1});
 assert.equal(repeat.events.length,0,'reused cached provider fetch is not an independent second read');
 const second=lab.observe(runData(at2,read2,market5));
 const families=second.events.map(e=>e.family);
 assert.ok(families.includes('ORB_1M'),'1m crossing recorded after two distinct stable reads');
 assert.ok(families.includes('ORB_3M'),'3m bars assembled from closed 1m bars');
 assert.ok(second.events.every(e=>e.executionAllowed===false));
 assert.equal(lab.observe(runData(at2,read2,market5)).events.length,second.events.length,'unacknowledged events replay until persisted; not silently dropped after an append failure');
 lab.ack(second.events);
 assert.equal(lab.observe({...runData(at2+65000,read2,market5),index1mFetchedAt:at2+65000}).events.length,0,'acked events never repeat');
 const changed=opening5.map(x=>x.slice());changed[0][2]=110;
 assert.equal(lab.observe(runData(at2+65000,read2,changed)).status,'OPENING_RANGE_REVISED','frozen opening range is not silently changed');
 const noSource=L.createTimingLab();
 assert.equal(noSource.observe(runData(at1,broken)).status,'INDEX_1M_SESSION_CANDLE_GAP');
}
{
 const future=[
  {t:t('09:15:00'),o:100,h:101,l:99,c:100,v:1000},
  {t:t('09:20:00'),o:101,h:102,l:100,c:101,v:1000},
  {t:t('09:25:00'),o:102,h:103,l:101,c:102,v:1000},
  {t:t('09:30:00'),o:103,h:104,l:102,c:103,v:1000},
  {t:t('09:35:00'),o:104,h:105,l:103,c:104,v:1000},
  {t:t('09:40:00'),o:104,h:105.5,l:102,c:105,v:1000},
  {t:t('09:45:00'),o:105,h:107,l:104,c:106,v:1000}
 ];
 const result=L.futuresVwapCrossings(future,t('09:51:40'));
 assert.equal(result[0]?.family,'FUTURES_VWAP_PULLBACK');
 assert.equal(result[0]?.direction,'UP');
 assert.equal(result[0]?.source,'NEAREST_NIFTY_FUTURE_VOLUME_WEIGHTED_5M');
 assert.equal(L.futuresVwapCrossings(future.map(c=>({...c,v:0})),t('09:51:40')).length,0,
  'spot-style zero volume cannot create a fictitious VWAP');
}
const plans=()=>({C:{available:true,strategy:'LONG_CALL',legs:{lotSize:65,buyLeg:{
 instrumentKey:'NSE_FO|777',contractId:'NIFTY-777',strike:23000,type:'CE',ask:100,bid:99.9}}},
 A:{available:false,strategy:'LONG_CALL'}});
const analysis=at=>({timestamp:iso(at),expiry:'2026-11-17',market:{phase:'OPEN'},
 decision:{researchCandidatePlans:{plans:plans()},ruleSpec:{implementationHash:'original-rule'},
 shadowTiming:{version:'OPENING_RANGE_SHADOW_V3',plans:{C:{status:'CONFIRMED',shadowEntryReady:false}}}}});
{
 assert.equal(L.candidateQuotes(analysis(at2), 'UP',at2+16000,65).length,0,'stale options ask never attributed to fast signal');
 const quotes=L.candidateQuotes(analysis(at2),'UP',at2+5000,65);
 assert.equal(quotes.length,1);assert.equal(quotes[0].contractId,'NIFTY-777');
 assert.equal(L.candidateQuotes(analysis(at2),'DOWN',at2+5000,65).length,0);
 const entry={...quotes[0],observedAt:iso(t('10:00:20'))};
 const option=[candle(t('10:01:00'),100,101,99,100),candle(t('10:02:00'),100,109,99,108)];
 const measured=L.measureEvent({entry,candles:option});
 assert.equal(measured.status,'MEASURED');assert.equal(measured.results.T8_S8_30M.exit,'TARGET');
 assert.equal(measured.entry.firstCandleAt,iso(t('10:01:00')));
 assert.ok(measured.results.T8_S8_30M.scenarios.BASE_1PT.estimatedNetRupees>250);
 assert.equal(L.measureEvent({entry,candles:[option[1]]}).reason,'INCOMPLETE_EXIT_CANDLE_PATH');
 const paired=L.buildTimingLabReport([{eventId:'e',session:DAY,family:'ORB_1M',direction:'UP',
 confirmedAt:iso(t('10:00:20')),candleClosedAt:iso(t('09:59:00')),
 sourceRuleVersion:'original-rule',candidateQuotes:[entry]}],[{eventId:'e',entryTier:'C',
 instrumentKey:entry.instrumentKey,outcome:measured}],[
 {session:DAY,tier:'C',instrumentKey:entry.instrumentKey,contractId:entry.contractId,
  direction:'UP',ruleVersion:'original-rule',crossedAt:iso(t('10:01:00')),confirmedAt:iso(t('10:02:20')),outcome:measured}
 ]);
 assert.equal(paired.comparisonVsV3.ORB_1M.pairs,1);
 assert.equal(paired.comparisonVsV3.ORB_1M.meanLeadMinutes,2);
 assert.equal(paired.comparisonVsV3.ORB_1M.pairedMeanNetDifferenceRupees,0);
}
(async()=>{
 let clock=at1;
 const records=[],requests=[],fetchOptions=[];
 const service=createOpportunityResearch({pool:{},token:'read-only',ownerToken:'test-owner',
  store:{async append(row){records.push(row);return true;}},
  dependencies:{env:{EDGE_TIMING_LAB_ENABLED:'true',EDGE_TRIGGERED_EXIT_V2_ENABLED:'false'},
   now:()=>clock,fetchIndex1m:async()=>({rows:clock===at1?read1:read2,fetchedAt:clock}),
   fetchCandles:async q=>{fetchOptions.push(q.instrumentKey);
    return [candle(t('09:36:00'),100,109,99,108)];},
   load:async()=>({records:structuredClone(records),ledger:{brokerFills:[]},snapshots:[]})}});
 await service.observeTiming(analysis(clock),{marketContext:{researchCandles:{index5m:opening5,future5m:future5}},lotSize:65});
 assert.equal(records.length,0,'first read cannot persist event');
 clock=at2;
 await service.observeTiming(analysis(clock),{marketContext:{researchCandles:{index5m:market5,future5m:future5}},lotSize:65});
 const events=records.filter(r=>r.recordType==='OPPORTUNITY_TIMING_LAB');
 assert.ok(events.length>=2,'fast ORB hypotheses durably recorded');
 assert.ok(events.every(r=>r.executionAllowed===false&&r.candidateQuotes[0].instrumentKey==='NSE_FO|777'));
 assert.equal(service.status().timingLab.error,null);
 clock=t('10:45:00');service.invalidate();
 await service.runTimingLabOutcomes();
 const outcomes=records.filter(r=>r.recordType==='OPPORTUNITY_TIMING_LAB_OUTCOME');
 assert.equal(outcomes.length,events.length,'one after-cost outcome per event and contract');
 assert.ok(outcomes.every(r=>r.outcome.status==='MEASURED'&&r.terminal));
 service.invalidate();await service.runTimingLabOutcomes();
 assert.equal(records.length,events.length+outcomes.length,'terminal entries never remeasured');
 const rep=buildOpportunityReport({records,now:clock});
 assert.equal(rep.timingLab.events,events.length);
 assert.equal(rep.timingLab.overall.measured,outcomes.length);
 assert.equal(rep.timingLab.promotionEligible,false);
 service.stop();
 // Disabled by default: never fetch new 1m market data or modify existing trading.
 let called=0;const no=createOpportunityResearch({pool:{},store:{append:async()=>true},token:'token',
  dependencies:{env:{},fetchIndex1m:async()=>{called++;throw Error('MUST_NOT_FETCH');}}});
 await no.observeTiming(analysis(clock),{});
 assert.equal(called,0,'separate opt-in flag required');
 console.log('Timing lab PASS: separate confirmed provider reads, 1m/3m and futures VWAP, strict coverage, immutable range, fresh quotes, after-cost option exits, paired V3 reporting, disabled default');
})().catch(e=>{console.error(e);process.exitCode=1;});
