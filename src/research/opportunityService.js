'use strict';
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {timingSafeOwnerToken}=require('../notifications/edgeWebPush');
const {rejectOwner}=require('../health/authThrottle');
const {loadOpportunitySource}=require('./opportunitySource');
const {buildObservation}=require('./opportunityCensus');
const {buildOpportunityReport,normalizeObservations,candidateEpisodes,indexOutcomes,outcomeFor,validateOutcome,HORIZON}=require('./opportunityReport');
const {harvestOutcome,fetchLegCandles}=require('../evidence/outcomeHarvester');
const {measureCard}=require('./quickExit');
const {measureTriggered,VERSION:TRIGGERED_VERSION}=require('./triggeredExitV2');
const {createTimingLab,candidateQuotes,measureEvent,VERSION:LAB_VERSION}=require('./timingLab');
const {fetchIndex1mResearch}=require('../data/marketContext');
// Quick-exit backfill budget per pass: distinct contract-day candle fetches and records written.
const QUICK_FETCHES=10,QUICK_WRITES=60,QUICK_WAIT_MS=32*60000;
function createOpportunityResearch({pool,store,ownerToken,token,enabled=true,dependencies={}}){
 const now=dependencies.now||Date.now,load=dependencies.load||((previous,options)=>loadOpportunitySource(pool,previous,options)),harvest=dependencies.harvest||harvestOutcome;
 const triggeredEnabled=(dependencies.env||process.env).EDGE_TRIGGERED_EXIT_V2_ENABLED==='true';
 const timingLabEnabled=(dependencies.env||process.env).EDGE_TIMING_LAB_ENABLED==='true';
 const lab=createTimingLab(),fetchOneMinute=dependencies.fetchIndex1m||fetchIndex1mResearch;
 const fetchCandles=dependencies.fetchCandles||((leg,snapshot)=>fetchLegCandles(snapshot,leg,token));
 let timer=null,running=false,quickRunning=false,v2Running=false,labRunning=false,labHarvestRunning=false,recording=false,stopped=false,cache=null,cacheAt=0,pending=null;
 const status={enabled:!!enabled,lastRecordedAt:null,recordingError:null,lastHarvestAt:null,harvestError:null,lastProcessed:0,
  quickExit:{lastRunAt:null,error:null,lastWritten:0,lastFetches:0},
  triggeredExitV2:{enabled:triggeredEnabled,lastRunAt:null,error:null,lastWritten:0,lastFetches:0},
  timingLab:{enabled:timingLabEnabled,lastObservedAt:null,lastStatus:null,lastEvents:0,error:null,
   outcomes:{lastRunAt:null,lastWritten:0,lastFetches:0,error:null}},
  // Archive reads as they happen (background or report), so full re-downloads are visible without forcing a load.
  // full / payloadRowsFetched / payloadBytesFetched count completed downloads, including loads that later failed.
  sourceReads:{total:0,failed:0,full:0,gapRecoveries:0,payloadRowsFetched:0,payloadBytesFetched:0,lastReadAt:null,lastReadMode:null,lastRecordsFetched:0,lastFullReadAt:null,lastError:null}};
 function counted({kind,rows,bytes}){const r=status.sourceReads;r.payloadRowsFetched+=rows;r.payloadBytesFetched+=bytes;
  if(kind==='FULL'){r.full++;r.lastFullReadAt=new Date(now()).toISOString();}}
 function invalidate(){cacheAt=0;}
 async function source(fresh=false){if(!fresh&&cache&&now()-cacheAt<30000)return cache;if(!pending)pending=load(cache,{onFetch:counted}).then(x=>{cache=x;cacheAt=now();
  const r=status.sourceReads,mode=x?.source?.readMode||(x?.source?.incrementalRead?'INCREMENTAL':'FULL');
  r.total++;r.lastReadAt=new Date(now()).toISOString();r.lastReadMode=mode;r.lastRecordsFetched=x?.source?.recordsFetched??0;r.lastError=null;
  if(mode==='GAP_RECOVERY')r.gapRecoveries++;
  return x;},e=>{status.sourceReads.failed++;status.sourceReads.lastError=/^[A-Z_]{3,80}$/.test(e?.message||'')?e.message:'SOURCE_READ_FAILED';throw e;}).finally(()=>{pending=null;});return pending;}
 async function observe(analysis,options){
  if(!enabled||!pool||recording||stopped)return;recording=true;
  try{const row=buildObservation(analysis,options);if(!row)return;if(await store.append(row)===false)throw Error();status.lastRecordedAt=row.observedAt;status.recordingError=null;invalidate();}
  catch(_){status.recordingError='CANDIDATE_RECORDING_UNAVAILABLE';}finally{recording=false;}
 }
 // Independent best-effort observer. Runs AFTER the main decision and never edits it.
 async function observeTiming(analysis,{marketContext,lotSize,observedAt=now()}={}){
  if(!enabled||!timingLabEnabled||!pool||labRunning||stopped||analysis?.market?.phase!=='OPEN')return;
  labRunning=true;
  try{
   const raw=await fetchOneMinute();
   const at=now();
   const result=lab.observe({now:at,index1m:raw?.rows||[],
    index1mFetchedAt:raw?.fetchedAt||at,index5m:marketContext?.researchCandles?.index5m||[],
    future5m:marketContext?.researchCandles?.future5m||[]});
   status.timingLab.lastStatus=result.status;
   status.timingLab.lastObservedAt=new Date(at).toISOString();
   status.timingLab.lastEvents=result.events.length;
   status.timingLab.error=null;
   for(const event of result.events){
    const quotes=candidateQuotes(analysis,event.direction,at,lotSize);
    const v3=Object.fromEntries(['A','B','C'].map(tier=>{
     const x=analysis?.decision?.shadowTiming?.plans?.[tier];
     return [tier,x?{status:x.status||null,shadowEntryReady:x.shadowEntryReady===true,
      breakoutId:x.breakoutId||null,entryBlocker:x.entryBlocker||null}:null];
    }));
    const record={id:'TIMING_LAB|'+event.id,recordType:'OPPORTUNITY_TIMING_LAB',
     timestamp:new Date(at).toISOString(),observedAt:event.confirmedAt,version:LAB_VERSION,
     eventId:event.id,session:event.session,family:event.family,direction:event.direction,
     confirmedAt:event.confirmedAt,firstSeenAt:event.firstSeenAt,candleClosedAt:event.candleClosedAt,
     level:event.level,close:event.close,sourceRuleVersion:analysis?.decision?.ruleSpec?.implementationHash||'UNKNOWN',
     v3,candidateQuotes:quotes,liveDecisionImpact:false,executionAllowed:false};
    if(await store.append(record)===false)throw Error('TIMING_LAB_APPEND_FAILED');
    lab.ack([event]);invalidate();
   }
  }catch(_){status.timingLab.error='TIMING_LAB_OBSERVATION_UNAVAILABLE';}
  finally{labRunning=false;}
 }
 async function run(){
  if(!enabled||!pool||!token||running||stopped)return {running};running=true;status.lastHarvestAt=new Date(now()).toISOString();status.harvestError=null;
  try{
   const input=await source(),observations=normalizeObservations(input.records,[]),outcomeIndex=indexOutcomes(input.records,now()),episodes=[...candidateEpisodes(observations),...candidateEpisodes(observations,{axis:'READINESS_TIER'})].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));let processed=0;
   for(const ep of episodes){
    if(stopped||processed>=4)break;if(['NOT_OPEN','CLOSED','PRE_OPEN'].includes(ep.marketPhase)||outcomeFor(ep,outcomeIndex,now()).status==='MEASURED')continue;
    const prior=outcomeIndex.byEpisode.get(ep.id)||[];
    if(prior.some(r=>r.terminal)||prior.at(-1)?.nextRetryAt&&Date.parse(prior.at(-1).nextRetryAt)>now())continue;
    const at=Date.parse(ep.at),end=at+HORIZON*60000,close=Date.parse(new Date(at+19800000).toISOString().slice(0,10)+'T15:30:00+05:30');
    if(end+120000>now())continue;
    const snapshot={id:ep.id,timestamp:ep.at,expiry:ep.candidate.expiry,strategy:ep.candidate.strategy,tradeLegs:ep.candidate.legs};
    let outcome;
    if(end>close)outcome={status:'UNAVAILABLE',reason:'HORIZON_OUTSIDE_SESSION'};
    else try{outcome=await harvest(snapshot,{token,horizons:[HORIZON]});}catch(_){outcome={status:'UNAVAILABLE',reason:'CANDLE_FETCH_UNAVAILABLE'};}
    if(outcome.status==='MEASURED'){const checked=validateOutcome(ep,{id:'new',outcome});if(checked.status!=='MEASURED')outcome={...outcome,status:'UNAVAILABLE',reason:checked.reason};}
    const attempt=prior.length+1,terminal=outcome.status==='MEASURED'||outcome.reason==='HORIZON_OUTSIDE_SESSION'||attempt>=3;
    const record={id:ep.id+'|OPPORTUNITY_OUTCOME|'+attempt,recordType:'OPPORTUNITY_OUTCOME',timestamp:new Date(now()).toISOString(),episodeId:ep.id,
     tier:ep.tier,cardTier:ep.cardTier,snapshotId:ep.firstObservationId,ruleVersion:ep.ruleVersion,measurementRule:'FIXED_60M_CANDLE_MARK_V1',attempt,terminal,
     nextRetryAt:terminal?null:new Date(now()+attempt*300000).toISOString(),outcome};
    if(await store.append(record)===false)throw Error();outcomeIndex.add(record,now());invalidate();processed++;
   }
   status.lastProcessed=processed;
  }catch(_){status.harvestError='OUTCOME_COLLECTION_UNAVAILABLE';}finally{running=false;}
  return {...status,running};
 }
 // Research only: for every flagged single-leg card, the quick-target / hard-stop / time-limit result on that
 // contract's own 1-minute candles (see quickExit.js). One candle download per contract and day serves every card on it.
 async function runQuickExit(){
  if(!enabled||!pool||!token||quickRunning||stopped)return {...status.quickExit,running:quickRunning};
  quickRunning=true;Object.assign(status.quickExit,{lastRunAt:new Date(now()).toISOString(),error:null,lastWritten:0,lastFetches:0});
  try{
   const input=await source(),observations=normalizeObservations(input.records,[]),done=new Map();
   for(const r of input.records){if(r.recordType!=='OPPORTUNITY_QUICK_EXIT'||!r.episodeId)continue;const list=done.get(r.episodeId)||[];list.push(r);done.set(r.episodeId,list);}
   const candles=new Map();let fetches=0,written=0;
   for(const ep of candidateEpisodes(observations)){
    if(stopped||written>=QUICK_WRITES)break;
    const c=ep.candidate,leg=c?.legs?.buyLeg;
    if(ep.marketPhase!=='OPEN'||!['LONG_CALL','LONG_PUT'].includes(c?.strategy)||!leg?.instrumentKey||c.legs.sellLeg)continue;
    const at=Date.parse(ep.at),session=new Date(at+19800000).toISOString().slice(0,10),close=Date.parse(session+'T15:30:00+05:30');
    if(Math.min(at+QUICK_WAIT_MS,close)+120000>now())continue;
    const prior=done.get(ep.id)||[];
    if(prior.some(r=>r.terminal)||prior.at(-1)?.nextRetryAt&&Date.parse(prior.at(-1).nextRetryAt)>now())continue;
    const key=leg.instrumentKey+'|'+session;
    if(!candles.has(key)){
     if(fetches>=QUICK_FETCHES)continue;
     fetches++;candles.set(key,await fetchCandles(leg,{timestamp:ep.at,expiry:c.expiry}).catch(()=>null));
    }
    const rows=candles.get(key);
    const outcome=rows?measureCard({candidate:c,at:ep.at,candles:rows}):{status:'UNAVAILABLE',reason:'CANDLE_FETCH_UNAVAILABLE'};
    const attempt=prior.length+1,terminal=outcome.status==='MEASURED'||['NOT_SINGLE_LEG_LONG','NO_EXECUTABLE_ENTRY_PRICE','LOT_SIZE_UNAVAILABLE','FLAG_TIME_UNAVAILABLE'].includes(outcome.reason)||attempt>=3;
    const record={id:ep.id+'|OPPORTUNITY_QUICK_EXIT|'+attempt,recordType:'OPPORTUNITY_QUICK_EXIT',timestamp:new Date(now()).toISOString(),episodeId:ep.id,
     tier:ep.tier,cardTier:ep.cardTier,snapshotId:ep.firstObservationId,ruleVersion:ep.ruleVersion,measurementRule:'QUICK_EXIT_V1',attempt,terminal,
     nextRetryAt:terminal?null:new Date(now()+attempt*300000).toISOString(),outcome};
    if(await store.append(record)===false)throw Error();
    done.set(ep.id,[...prior,record]);written++;
   }
   if(written)invalidate();
   Object.assign(status.quickExit,{lastWritten:written,lastFetches:fetches});
  }catch(_){status.quickExit.error='QUICK_EXIT_COLLECTION_UNAVAILABLE';}finally{quickRunning=false;}
  return {...status.quickExit,running:false};
 }

 // V2: confirmed-entry research is independent of V1 first-flag backfill and paper execution.
 // A missing confirmed quote is NOT reconstructed from later candles or from the original flag.
 async function runTriggeredExitV2(){
  if(!enabled||!triggeredEnabled||!pool||!token||v2Running||stopped)return {...status.triggeredExitV2,running:v2Running};
  v2Running=true;Object.assign(status.triggeredExitV2,{lastRunAt:new Date(now()).toISOString(),error:null,lastWritten:0,lastFetches:0});
  try{
   const input=await source(),observations=normalizeObservations(input.records,[]);
   const done=new Map();
   for(const r of input.records){if(r.recordType!=='OPPORTUNITY_TRIGGER_EXIT_V2'||!r.episodeId)continue;
    const list=done.get(r.episodeId)||[];list.push(r);done.set(r.episodeId,list);}
   const candles=new Map();let fetches=0,written=0;
   for(const ep of candidateEpisodes(observations)){
    if(stopped||written>=QUICK_WRITES)break;
    const c=ep.candidate,leg=c?.legs?.buyLeg,trigger=ep.firstConfirmed;
    if(ep.marketPhase!=='OPEN'||!['LONG_CALL','LONG_PUT'].includes(c?.strategy)||
       !leg?.instrumentKey||c.legs.sellLeg||!trigger)continue;
    const at=Date.parse(trigger.at),session=new Date(at+19800000).toISOString().slice(0,10);
    const close=Date.parse(session+'T15:30:00+05:30');
    if(!Number.isFinite(at)||Math.min(at+QUICK_WAIT_MS,close)+120000>now())continue;
    const prior=done.get(ep.id)||[];
    if(prior.some(r=>r.terminal)||prior.at(-1)?.nextRetryAt&&Date.parse(prior.at(-1).nextRetryAt)>now())continue;
    const key=leg.instrumentKey+'|'+session;
    if(!candles.has(key)){
     if(fetches>=QUICK_FETCHES)continue;
     fetches++;candles.set(key,await fetchCandles(leg,{timestamp:trigger.at,expiry:c.expiry}).catch(()=>null));
    }
    const rows=candles.get(key);
    const outcome=rows?measureTriggered({candidate:c,trigger,candles:rows}):{status:'UNAVAILABLE',reason:'CANDLE_FETCH_UNAVAILABLE',version:TRIGGERED_VERSION};
    const attempt=prior.length+1,terminal=outcome.status==='MEASURED'||
     ['NOT_SINGLE_LEG_LONG','NO_CONFIRMED_EXECUTABLE_ASK','LOT_SIZE_UNAVAILABLE','TRIGGER_CONTRACT_MISMATCH',
      'V3_CONFIRMATION_NOT_VERIFIED','UNTRUSTED_TRIGGER_TIMING_OR_STALE_ASK'].includes(outcome.reason)||attempt>=3;
    const record={id:ep.id+'|OPPORTUNITY_TRIGGER_EXIT_V2|'+attempt,recordType:'OPPORTUNITY_TRIGGER_EXIT_V2',
     timestamp:new Date(now()).toISOString(),episodeId:ep.id,tier:ep.tier,cardTier:ep.cardTier,
     snapshotId:ep.firstObservationId,ruleVersion:ep.ruleVersion,measurementRule:TRIGGERED_VERSION,attempt,terminal,
     nextRetryAt:terminal?null:new Date(now()+attempt*300000).toISOString(),outcome};
    if(await store.append(record)===false)throw Error();
    done.set(ep.id,[...prior,record]);written++;
   }
   if(written)invalidate();
   Object.assign(status.triggeredExitV2,{lastWritten:written,lastFetches:fetches});
  }catch(_){status.triggeredExitV2.error='TRIGGERED_EXIT_COLLECTION_UNAVAILABLE';}finally{v2Running=false;}
  return {...status.triggeredExitV2,running:false};
 }
 async function runTimingLabOutcomes(){
  if(!enabled||!timingLabEnabled||!pool||!token||labHarvestRunning||stopped)
   return {...status.timingLab.outcomes,running:labHarvestRunning};
  labHarvestRunning=true;
  const statusOut=status.timingLab.outcomes;
  Object.assign(statusOut,{lastRunAt:new Date(now()).toISOString(),lastWritten:0,lastFetches:0,error:null});
  try{
   const input=await source(),events=input.records.filter(r=>r.recordType==='OPPORTUNITY_TIMING_LAB');
   const done=new Map();
   for(const r of input.records)if(r.recordType==='OPPORTUNITY_TIMING_LAB_OUTCOME'){
    const key=[r.eventId,r.entryTier,r.instrumentKey].join('|'),items=done.get(key)||[];
    items.push(r);done.set(key,items);
   }
   const candles=new Map();let written=0,fetches=0;
   for(const event of events){
    if(stopped||written>=QUICK_WRITES)break;
    const at=Date.parse(event.confirmedAt),close=Date.parse(event.session+'T15:30:00+05:30');
    if(!Number.isFinite(at)||Math.min(at+QUICK_WAIT_MS,close)+2*60000>now())continue;
    for(const q of event.candidateQuotes||[]){
     if(stopped||written>=QUICK_WRITES)break;
     const key=[event.eventId,q.tier,q.instrumentKey].join('|'),prior=done.get(key)||[];
     if(prior.some(r=>r.terminal)||prior.at(-1)?.nextRetryAt&&Date.parse(prior.at(-1).nextRetryAt)>now())continue;
     const contractDay=q.instrumentKey+'|'+event.session;
     if(!candles.has(contractDay)){
      if(fetches>=QUICK_FETCHES)continue;
      fetches++;
      candles.set(contractDay,await fetchCandles(q,{timestamp:event.confirmedAt,expiry:q.expiry}).catch(()=>null));
     }
     const rows=candles.get(contractDay),outcome=rows?measureEvent({entry:q,candles:rows}):
      {status:'UNAVAILABLE',version:LAB_VERSION,reason:'CANDLE_FETCH_UNAVAILABLE'};
     const attempt=prior.length+1,terminal=outcome.status==='MEASURED'||
      ['EXECUTABLE_ENTRY_QUOTE_MISSING','ENTRY_TIME_MISSING'].includes(outcome.reason)||attempt>=3;
     const record={id:event.eventId+'|'+q.tier+'|'+q.instrumentKey+'|LAB_OUTCOME|'+attempt,
      recordType:'OPPORTUNITY_TIMING_LAB_OUTCOME',timestamp:new Date(now()).toISOString(),
      eventId:event.eventId,session:event.session,family:event.family,direction:event.direction,
      entryTier:q.tier,instrumentKey:q.instrumentKey,measurementRule:LAB_VERSION,
      attempt,terminal,nextRetryAt:terminal?null:new Date(now()+attempt*300000).toISOString(),outcome};
     if(await store.append(record)===false)throw Error('TIMING_LAB_OUTCOME_APPEND_FAILED');
     written++;done.set(key,[...prior,record]);
    }
   }
   if(written)invalidate();
   Object.assign(statusOut,{lastWritten:written,lastFetches:fetches});
  }catch(_){statusOut.error='TIMING_LAB_OUTCOME_COLLECTION_UNAVAILABLE';}
  finally{labHarvestRunning=false;}
  return {...statusOut,running:false};
 }
 const cycle=async()=>{await run();await runQuickExit();await runTriggeredExitV2();await runTimingLabOutcomes();};
 function start(){if(!enabled||timer)return;stopped=false;timer=setInterval(()=>{void cycle();},60000);timer.unref?.();void cycle();}
 function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;}
 function routes(app){
  const base='/api/v1/opportunities';
  app.get(base+'/status',(_req,res)=>{res.set('Cache-Control','no-store');res.json({...status,running,liveDecisionImpact:false,liveTradingInScope:false});});
  for(const [url,file,type] of [['/control','control.html','html'],['/control.js','control.js','js'],['/control.css','control.css','css']])app.get(base+url,(_req,res)=>{
   res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
   res.type(type).send(readFileSync(path.join(__dirname,file),'utf8'));
  });
  const guard=fn=>async(req,res)=>{
   res.set('Cache-Control','no-store');
   if(rejectOwner(req,res,{ownerToken,compare:timingSafeOwnerToken,throttle:dependencies.throttle}))return;
   if(!enabled)return res.status(404).json({error:'OPPORTUNITY_REPORTS_DISABLED'});
   try{await fn(req,res);}catch(e){res.status(503).json({error:e.message==='REPORT_SOURCE_LIMIT'?e.message:'OPPORTUNITY_REPORT_UNAVAILABLE'});}
  };
  app.get(base,guard(async(_req,res)=>res.json({...buildOpportunityReport({...await source(true),now:now()}),collection:{...status,running}})));
  app.post(base+'/measure',guard(async(_req,res)=>{void cycle();res.status(202).json({accepted:true,running,ordersPlaced:0});}));
 }
 return {observe,observeTiming,start,stop,routes,run,runQuickExit,runTriggeredExitV2,runTimingLabOutcomes,status:()=>({...status,running}),invalidate};
}
module.exports={createOpportunityResearch};
