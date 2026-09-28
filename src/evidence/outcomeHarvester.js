'use strict';

const https = require('https');
const { measureOutcome } = require('./evidenceEngine');

function requestJson(path, token) {
  return new Promise((resolve, reject) => {
    const req=https.request({hostname:'api.upstox.com',path,method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'}},res=>{
      let body=''; res.on('data',d=>body+=d); res.on('end',()=>{
        try {
          const parsed=JSON.parse(body);
          if(res.statusCode<200||res.statusCode>=300||parsed.status==='error') return reject(new Error('UPSTOX_'+res.statusCode+': '+body.slice(0,300)));
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

function eligible(snapshot, now=Date.now(), horizonMinutes=120){
  if(!snapshot||snapshot.recordType!=='POLL_SNAPSHOT')return false;
  if(snapshot.orchestrationStatus!=='READY_TO_EXECUTE')return false;
  if(!snapshot.tradeLegs||snapshot.strategy==='WAIT')return false;
  const age=now-new Date(snapshot.timestamp).getTime();
  if(!Number.isFinite(age)||age<horizonMinutes*60000)return false;
  const legs=requiredLegs(snapshot);
  return legs.length>0&&legs.every(([,leg])=>leg.instrumentKey);
}

function normalizeCandles(rows){
  return (rows||[]).map(c=>({timestamp:c[0],open:c[1],high:c[2],low:c[3],close:c[4],volume:c[5],oi:c[6]}));
}

async function fetchIntraday1m(instrumentKey, token){
  const path='/v3/historical-candle/intraday/'+encodeURIComponent(instrumentKey)+'/minutes/1';
  const json=await requestJson(path,token);
  return normalizeCandles(json?.data?.candles||[]);
}

async function harvestOutcome(snapshot,{token,fetchCandles=fetchIntraday1m}={}){
  if(!token)return{status:'UNAVAILABLE',reason:'UPSTOX_TOKEN_MISSING'};
  const candlesByContract={};
  for(const [,leg] of requiredLegs(snapshot)){
    if(!leg.instrumentKey)return{status:'UNAVAILABLE',reason:'MISSING_INSTRUMENT_KEY'};
    candlesByContract[leg.contractId]=await fetchCandles(leg.instrumentKey,token);
  }
  return measureOutcome({snapshot,candlesByContract});
}

function createOutcomeHarvester({store,snapshots,token,intervalMs=60000,horizonMinutes=120}={}){
  let timer=null,running=false;
  const harvested=new Set((snapshots||[]).filter(x=>x.recordType==='OUTCOME').map(x=>x.snapshotId));
  const status={lastRun:null,lastError:null,measured:harvested.size,eligible:0,skipped:0};

  async function run(){
    if(running)return status;
    running=true; status.lastRun=new Date().toISOString(); status.lastError=null; status.eligible=0; status.skipped=0;
    try{
      const now=Date.now();
      for(const snap of [...(snapshots||[])]){
        if(harvested.has(snap.id)){status.skipped++;continue;}
        if(!eligible(snap,now,horizonMinutes))continue;
        status.eligible++;
        let outcome;
        try{ outcome=await harvestOutcome(snap,{token}); }
        catch(e){ outcome={status:'UNAVAILABLE',reason:'HARVEST_ERROR',error:e.message}; }
        const rec={id:snap.id+'|OUTCOME',recordType:'OUTCOME',timestamp:new Date().toISOString(),snapshotId:snap.id,evidenceKey:snap.evidenceKey,setupEvidenceKey:snap.setupEvidenceKey,snapshot:snap,outcome};
        store.append(rec); snapshots.push(rec);
        if(outcome.status==='MEASURED'){harvested.add(snap.id);status.measured++;}
      }
    }catch(e){status.lastError=e.message;}
    finally{running=false;}
    return status;
  }
  function start(){if(timer)return; timer=setInterval(run,intervalMs); timer.unref?.();}
  function getStatus(){return{...status,pending:[...(snapshots||[])].filter(s=>eligible(s,Date.now(),horizonMinutes)&&!harvested.has(s.id)).length};}
  return{run,start,getStatus};
}

module.exports={eligible,harvestOutcome,createOutcomeHarvester,normalizeCandles};
