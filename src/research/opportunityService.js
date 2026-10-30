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
// Quick-exit backfill budget per pass: distinct contract-day candle fetches and records written.
const QUICK_FETCHES=10,QUICK_WRITES=60,QUICK_WAIT_MS=32*60000;
function createOpportunityResearch({pool,store,ownerToken,token,enabled=true,dependencies={}}){
 const now=dependencies.now||Date.now,load=dependencies.load||((previous,options)=>loadOpportunitySource(pool,previous,options)),harvest=dependencies.harvest||harvestOutcome;
 const fetchCandles=dependencies.fetchCandles||((leg,snapshot)=>fetchLegCandles(snapshot,leg,token));
 let timer=null,running=false,quickRunning=false,recording=false,stopped=false,cache=null,cacheAt=0,pending=null;
 const status={enabled:!!enabled,lastRecordedAt:null,recordingError:null,lastHarvestAt:null,harvestError:null,lastProcessed:0,
  quickExit:{lastRunAt:null,error:null,lastWritten:0,lastFetches:0},
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
 const cycle=async()=>{await run();await runQuickExit();};
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
 return {observe,start,stop,routes,run,runQuickExit,status:()=>({...status,running}),invalidate};
}
module.exports={createOpportunityResearch};
