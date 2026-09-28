'use strict';

const https = require('https');
const { measureOutcome } = require('./evidenceEngine');

const NIFTY_KEY='NSE_INDEX|Nifty 50';
const MAX_RETRIES=6;
const BASE_RETRY_MS=60*1000;

function requestJson(path, token) {
  return new Promise((resolve, reject) => {
    const req=https.request({hostname:'api.upstox.com',path,method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'}},res=>{
      let body=''; res.on('data',d=>body+=d); res.on('end',()=>{
        try {
          const parsed=JSON.parse(body);
          if(res.statusCode<200||res.statusCode>=300||parsed.status==='error'){
            const err=new Error('UPSTOX_'+res.statusCode+': '+body.slice(0,300)); err.statusCode=res.statusCode; return reject(err);
          }
          resolve(parsed);
        } catch(e){ reject(e); }
      });
    });
    req.setTimeout(10000,()=>req.destroy(new Error('UPSTOX_CANDLE_TIMEOUT')));
    req.on('error',reject); req.end();
  });
}

function requiredLegs(snapshot){
  return Object.entries(snapshot?.tradeLegs||{}).filter(([,leg])=>leg&&typeof leg==='object'&&leg.contractId);
}
function expiryDate(snapshot){return snapshot?.expiry?String(snapshot.expiry).slice(0,10):null;}
function isExpired(snapshot,now=Date.now()){
  const exp=expiryDate(snapshot); if(!exp)return false;
  // Treat a contract as expired only after its NSE expiry calendar date.
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  return exp<today;
}
function eligible(snapshot, now=Date.now(), horizonMinutes=120){
  if(!snapshot||snapshot.recordType!=='POLL_SNAPSHOT')return false;
  if(snapshot.orchestrationStatus!=='READY_TO_EXECUTE')return false;
  if(!snapshot.tradeLegs||snapshot.strategy==='WAIT')return false;
  const age=now-new Date(snapshot.timestamp).getTime();
  if(!Number.isFinite(age)||age<horizonMinutes*60000)return false;
  const legs=requiredLegs(snapshot);
  return legs.length>0&&legs.every(([,leg])=>leg.instrumentKey);
}
function opportunityKey(snapshot){
  const legs=requiredLegs(snapshot).map(([name,leg])=>name+':'+(leg.instrumentKey||leg.contractId)).sort().join(',');
  return String(snapshot?.strategy||'WAIT')+'|'+legs;
}
function episodeStartIds(rows){
  const polls=(rows||[]).filter(x=>x.recordType==='POLL_SNAPSHOT').sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const starts=new Set(); let previous=null;
  for(const snap of polls){
    const ready=snap.orchestrationStatus==='READY_TO_EXECUTE';
    const key=ready?opportunityKey(snap):null;
    if(ready&&(!previous?.ready||previous.key!==key))starts.add(snap.id);
    previous={ready,key};
  }
  return starts;
}
function normalizeCandles(rows){
  return (rows||[]).map(c=>({timestamp:c[0],open:c[1],high:c[2],low:c[3],close:c[4],volume:c[5],oi:c[6]}));
}
async function fetchActiveHistorical1m(instrumentKey,token,fromDate,toDate){
  const path='/v3/historical-candle/'+encodeURIComponent(instrumentKey)+'/minutes/1/'+toDate+'/'+fromDate;
  const json=await requestJson(path,token); return normalizeCandles(json?.data?.candles||[]);
}
async function expiredInstrumentKey(snapshot,leg,token){
  const exp=expiryDate(snapshot); if(!exp)throw new Error('EXPIRY_MISSING');
  const path='/v2/expired-instruments/option/contract?instrument_key='+encodeURIComponent(NIFTY_KEY)+'&expiry_date='+encodeURIComponent(exp);
  const json=await requestJson(path,token);
  const strike=Number(leg.strike),type=String(leg.type||'');
  const match=(json?.data||[]).find(x=>Number(x.strike_price)===strike&&String(x.instrument_type)===type);
  if(!match?.instrument_key)throw new Error('EXPIRED_INSTRUMENT_NOT_FOUND:'+strike+type);
  return match.instrument_key;
}
async function fetchExpiredHistorical1m(snapshot,leg,token){
  const exp=expiryDate(snapshot),key=await expiredInstrumentKey(snapshot,leg,token);
  const path='/v2/expired-instruments/historical-candle/'+encodeURIComponent(key)+'/1minute/'+exp+'/'+exp;
  const json=await requestJson(path,token); return normalizeCandles(json?.data?.candles||[]);
}
async function fetchLegCandles(snapshot,leg,token){
  if(isExpired(snapshot))return fetchExpiredHistorical1m(snapshot,leg,token);
  const day=String(snapshot.timestamp).slice(0,10);
  return fetchActiveHistorical1m(leg.instrumentKey,token,day,day);
}
async function harvestOutcome(snapshot,{token,fetchCandles}={}){
  if(!token)return{status:'UNAVAILABLE',reason:'UPSTOX_TOKEN_MISSING'};
  const candlesByContract={};
  for(const [,leg] of requiredLegs(snapshot)){
    if(!leg.instrumentKey)return{status:'UNAVAILABLE',reason:'MISSING_INSTRUMENT_KEY'};
    candlesByContract[leg.contractId]=fetchCandles
      ? await fetchCandles(leg.instrumentKey,token,snapshot,leg)
      : await fetchLegCandles(snapshot,leg,token);
  }
  return measureOutcome({snapshot,candlesByContract});
}
function retryDelay(attempt){return Math.min(30*60*1000,BASE_RETRY_MS*Math.pow(2,Math.max(0,attempt-1)));}

function createOutcomeHarvester({store,snapshots,token,intervalMs=60000,horizonMinutes=120,harvest=harvestOutcome}={}){
  let timer=null,running=false;
  const terminal=new Set();
  const attempts=new Map();
  for(const row of snapshots||[]){
    if(row.recordType!=='OUTCOME'||!row.snapshotId)continue;
    if(row.outcome?.status==='MEASURED'||row.outcome?.terminal===true)terminal.add(row.snapshotId);
    const a=Number(row.attempt); if(Number.isFinite(a))attempts.set(row.snapshotId,Math.max(attempts.get(row.snapshotId)||0,a));
  }
  const status={lastRun:null,lastError:null,measured:[...(snapshots||[])].filter(x=>x.recordType==='OUTCOME'&&x.outcome?.status==='MEASURED').length,eligible:0,skipped:0,retried:0,terminalFailures:terminal.size};

  async function run(){
    if(running)return{...status,running:true};
    running=true; status.lastRun=new Date().toISOString(); status.lastError=null; status.eligible=0; status.skipped=0; status.retried=0;
    try{
      const now=Date.now();
      const episodeStarts=episodeStartIds(snapshots||[]);
      const existingIds=new Set((snapshots||[]).map(x=>x.id));
      for(const snap of [...(snapshots||[])]){
        if(terminal.has(snap.id)){status.skipped++;continue;}
        if(!episodeStarts.has(snap.id)){continue;}
        if(!eligible(snap,now,horizonMinutes))continue;
        const prior=attempts.get(snap.id)||0;
        const last=(snapshots||[]).filter(x=>x.recordType==='OUTCOME'&&x.snapshotId===snap.id).slice(-1)[0];
        if(last?.nextRetryAt&&now<new Date(last.nextRetryAt).getTime()){status.skipped++;continue;}
        status.eligible++;
        const attempt=prior+1; let outcome;
        try{ outcome=await harvest(snap,{token}); }
        catch(e){ outcome={status:'UNAVAILABLE',reason:'HARVEST_ERROR',error:e.message}; }
        const measured=outcome.status==='MEASURED';
        const terminalFailure=!measured&&attempt>=MAX_RETRIES;
        if(terminalFailure)outcome={...outcome,terminal:true};
        const recId=snap.id+'|OUTCOME|'+attempt;
        if(existingIds.has(recId)){status.skipped++;continue;}
        const rec={id:recId,recordType:'OUTCOME',timestamp:new Date().toISOString(),snapshotId:snap.id,attempt,nextRetryAt:measured||terminalFailure?null:new Date(now+retryDelay(attempt)).toISOString(),evidenceKey:snap.evidenceKey,setupEvidenceKey:snap.setupEvidenceKey,snapshot:snap,outcome};
        if(store.append(rec)===false)throw new Error('EVIDENCE_STORE_APPEND_FAILED');
        snapshots.push(rec); existingIds.add(recId); attempts.set(snap.id,attempt);
        if(measured){terminal.add(snap.id);status.measured++;}
        else if(terminalFailure){terminal.add(snap.id);status.terminalFailures++;}
        else status.retried++;
      }
    }catch(e){status.lastError=e.message;}
    finally{running=false;}
    return{...status};
  }
  function start(){if(timer)return; timer=setInterval(run,intervalMs); timer.unref?.();}
  function getStatus(){const starts=episodeStartIds(snapshots||[]);return{...status,running,pending:[...(snapshots||[])].filter(s=>starts.has(s.id)&&eligible(s,Date.now(),horizonMinutes)&&!terminal.has(s.id)).length};}
  return{run,start,getStatus};
}

module.exports={eligible,isExpired,opportunityKey,episodeStartIds,harvestOutcome,createOutcomeHarvester,normalizeCandles,retryDelay};
