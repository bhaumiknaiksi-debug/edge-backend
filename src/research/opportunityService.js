'use strict';
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {timingSafeOwnerToken}=require('../notifications/edgeWebPush');
const {loadOpportunitySource}=require('./opportunitySource');
const {buildObservation}=require('./opportunityCensus');
const {buildOpportunityReport,normalizeObservations,candidateEpisodes,outcomeFor,HORIZON}=require('./opportunityReport');
const {harvestOutcome}=require('../evidence/outcomeHarvester');
function createOpportunityResearch({pool,store,ownerToken,token,enabled=true,dependencies={}}){
 const now=dependencies.now||Date.now,load=dependencies.load||(previous=>loadOpportunitySource(pool,previous)),harvest=dependencies.harvest||harvestOutcome;
 let timer=null,running=false,recording=false,stopped=false,cache=null,cacheAt=0,pending=null;
 const status={enabled:!!enabled,lastRecordedAt:null,recordingError:null,lastHarvestAt:null,harvestError:null,lastProcessed:0};
 function invalidate(){cacheAt=0;}
 async function source(fresh=false){if(!fresh&&cache&&now()-cacheAt<30000)return cache;if(!pending)pending=load(cache).then(x=>{cache=x;cacheAt=now();return x;}).finally(()=>{pending=null;});return pending;}
 async function observe(analysis,options){
  if(!enabled||!pool||recording||stopped)return;recording=true;
  try{const row=buildObservation(analysis,options);if(!row)return;if(await store.append(row)===false)throw Error();status.lastRecordedAt=row.observedAt;status.recordingError=null;invalidate();}
  catch(_){status.recordingError='CANDIDATE_RECORDING_UNAVAILABLE';}finally{recording=false;}
 }
 async function run(){
  if(!enabled||!pool||!token||running||stopped)return {running};running=true;status.lastHarvestAt=new Date(now()).toISOString();status.harvestError=null;
  try{
   const input=await source(),localRecords=input.records.slice(),observations=normalizeObservations(localRecords,[]),episodes=[...candidateEpisodes(observations),...candidateEpisodes(observations,{axis:'READINESS_TIER'})].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));let processed=0;
   for(const ep of episodes){
    if(stopped||processed>=4)break;if(['NOT_OPEN','CLOSED','PRE_OPEN'].includes(ep.marketPhase)||outcomeFor(ep,localRecords,now()).status==='MEASURED')continue;
    const prior=localRecords.filter(r=>r.recordType==='OPPORTUNITY_OUTCOME'&&r.episodeId===ep.id);
    if(prior.some(r=>r.terminal)||prior.at(-1)?.nextRetryAt&&Date.parse(prior.at(-1).nextRetryAt)>now())continue;
    const at=Date.parse(ep.at),end=at+HORIZON*60000,close=Date.parse(new Date(at+19800000).toISOString().slice(0,10)+'T15:30:00+05:30');
    if(end+120000>now())continue;
    const snapshot={id:ep.id,timestamp:ep.at,expiry:ep.candidate.expiry,strategy:ep.candidate.strategy,tradeLegs:ep.candidate.legs};
    let outcome;
    if(end>close)outcome={status:'UNAVAILABLE',reason:'HORIZON_OUTSIDE_SESSION'};
    else try{outcome=await harvest(snapshot,{token,horizons:[HORIZON]});}catch(_){outcome={status:'UNAVAILABLE',reason:'CANDLE_FETCH_UNAVAILABLE'};}
    const attempt=prior.length+1,terminal=outcome.status==='MEASURED'||outcome.reason==='HORIZON_OUTSIDE_SESSION'||attempt>=3;
    const record={id:ep.id+'|OPPORTUNITY_OUTCOME|'+attempt,recordType:'OPPORTUNITY_OUTCOME',timestamp:new Date(now()).toISOString(),episodeId:ep.id,
     tier:ep.tier,cardTier:ep.cardTier,snapshotId:ep.firstObservationId,ruleVersion:ep.ruleVersion,measurementRule:'FIXED_60M_CANDLE_MARK_V1',attempt,terminal,
     nextRetryAt:terminal?null:new Date(now()+attempt*300000).toISOString(),outcome};
    if(await store.append(record)===false)throw Error();localRecords.push(record);invalidate();processed++;
   }
   status.lastProcessed=processed;
  }catch(_){status.harvestError='OUTCOME_COLLECTION_UNAVAILABLE';}finally{running=false;}
  return {...status,running};
 }
 function start(){if(!enabled||timer)return;stopped=false;timer=setInterval(()=>{void run();},60000);timer.unref?.();void run();}
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
   res.set('Cache-Control','no-store');const auth=String(req.headers.authorization||'');
   if(!ownerToken||!auth.startsWith('Bearer ')||!timingSafeOwnerToken(auth.slice(7),ownerToken))return res.status(401).json({error:'OWNER_AUTH_REQUIRED'});
   if(!enabled)return res.status(404).json({error:'OPPORTUNITY_REPORTS_DISABLED'});
   try{await fn(req,res);}catch(e){res.status(503).json({error:e.message==='REPORT_SOURCE_LIMIT'?e.message:'OPPORTUNITY_REPORT_UNAVAILABLE'});}
  };
  app.get(base,guard(async(_req,res)=>res.json({...buildOpportunityReport({...await source(true),now:now()}),collection:{...status,running}})));
  app.post(base+'/measure',guard(async(_req,res)=>{void run();res.status(202).json({accepted:true,running,ordersPlaced:0});}));
 }
 return {observe,start,stop,routes,run,status:()=>({...status,running}),invalidate};
}
module.exports={createOpportunityResearch};
