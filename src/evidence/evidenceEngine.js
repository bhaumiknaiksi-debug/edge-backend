'use strict';

function n(v){if(v===null||v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=2){return Number(Number(v).toFixed(dp));}

function bucketDte(dte){const d=n(dte);if(d===null)return'UNKNOWN';if(d<=0)return'0DTE';if(d<=3)return'1_3DTE';if(d<=7)return'4_7DTE';return'8PLUS_DTE';}
function bucketTime(ts){
  const d=new Date(ts); if(Number.isNaN(d.getTime()))return'UNKNOWN';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
  const h=Number(parts.find(p=>p.type==='hour')?.value),m=Number(parts.find(p=>p.type==='minute')?.value),x=h*60+m;
  if(x<570)return'OPENING'; if(x<690)return'MORNING'; if(x<810)return'MIDDAY'; if(x<900)return'AFTERNOON'; return'CLOSING';
}
function evidenceKey(s){
  return [s.regime?.direction||s.bias||'UNKNOWN',s.volatility?.richness||s.ivRegime||'UNKNOWN',bucketDte(s.dte),bucketTime(s.timestamp),s.strategy||s.decision?.strategy||'WAIT'].join('|');
}
function legEntry(leg, side){
  if(!leg)return null;
  const bid=n(leg.bid),ask=n(leg.ask),premium=n(leg.premium);
  if(side==='BUY')return ask??premium;
  return bid??premium;
}
function markFromCandle(c){return n(c?.close);}
function buildInstrumentMarks(tradeLegs, candlesByContract, timestamp){
  const out={};
  for(const [name,leg] of Object.entries(tradeLegs||{})){
    if(!leg||!leg.contractId)continue;
    const rows=(candlesByContract[leg.contractId]||[]).filter(c=>new Date(c.timestamp)>=new Date(timestamp)).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    out[name]=rows;
  }
  return out;
}
function strategyValue(strategy,legs,marks,i){
  const px=name=>markFromCandle(marks[name]?.[i]);
  if(strategy==='LONG_CALL'||strategy==='LONG_PUT')return px('buyLeg');
  if(strategy==='BULL_CALL_SPREAD'||strategy==='BEAR_PUT_SPREAD'){const a=px('buyLeg'),b=px('sellLeg');return a===null||b===null?null:a-b;}
  if(strategy==='BULL_PUT_SPREAD'||strategy==='BEAR_CALL_SPREAD'){const a=px('sellLeg'),b=px('buyLeg');return a===null||b===null?null:a-b;}
  if(strategy==='IRON_CONDOR'){const a=px('ceShort'),b=px('ceLong'),c=px('peShort'),d=px('peLong');return[a,b,c,d].some(x=>x===null)?null:(a-b)+(c-d);}
  return null;
}
function entryValue(strategy,legs){
  if(strategy==='LONG_CALL'||strategy==='LONG_PUT')return legEntry(legs.buyLeg,'BUY');
  if(strategy==='BULL_CALL_SPREAD'||strategy==='BEAR_PUT_SPREAD'){
    const a=legEntry(legs.buyLeg,'BUY'),b=legEntry(legs.sellLeg,'SELL');return a===null||b===null?null:a-b;
  }
  if(strategy==='BULL_PUT_SPREAD'||strategy==='BEAR_CALL_SPREAD'){
    const a=legEntry(legs.sellLeg,'SELL'),b=legEntry(legs.buyLeg,'BUY');return a===null||b===null?null:a-b;
  }
  if(strategy==='IRON_CONDOR'){
    const vals=[legEntry(legs.ceShort,'SELL'),legEntry(legs.ceLong,'BUY'),legEntry(legs.peShort,'SELL'),legEntry(legs.peLong,'BUY')];
    return vals.some(x=>x===null)?null:(vals[0]-vals[1])+(vals[2]-vals[3]);
  }
  return null;
}
function entrySides(strategy){
  if(strategy==='LONG_CALL'||strategy==='LONG_PUT')return{buyLeg:'BUY'};
  if(strategy==='BULL_CALL_SPREAD'||strategy==='BEAR_PUT_SPREAD')return{buyLeg:'BUY',sellLeg:'SELL'};
  if(strategy==='BULL_PUT_SPREAD'||strategy==='BEAR_CALL_SPREAD')return{sellLeg:'SELL',buyLeg:'BUY'};
  if(strategy==='IRON_CONDOR')return{ceShort:'SELL',ceLong:'BUY',peShort:'SELL',peLong:'BUY'};
  return{};
}
function entryLegMarks(strategy,legs){
  const sides=entrySides(strategy),out={};
  for(const [name,side] of Object.entries(sides)){
    const leg=legs?.[name],price=legEntry(leg,side);
    if(!leg?.contractId||price===null)continue;
    out[name]={contractId:leg.contractId,side,price:round(price,4)};
  }
  return out;
}
function legMarksAt(names,aligned,i){
  return Object.fromEntries(names.map(name=>[name,round(markFromCandle(aligned[name]?.[i]),4)]).filter(([,v])=>Number.isFinite(v)));
}
function pnlPct(strategy,entry,value){
  if(entry===null||value===null||entry<=0)return null;
  const credit=['BULL_PUT_SPREAD','BEAR_CALL_SPREAD','IRON_CONDOR'].includes(strategy);
  return (credit?(entry-value):(value-entry))/entry*100;
}
function measureOutcome({snapshot,candlesByContract={},horizons=[15,30,60,120]}){
  const strategy=snapshot.strategy||snapshot.decision?.strategy||'WAIT',legs=snapshot.tradeLegs||snapshot.decision?.tradeLegs;
  if(strategy==='WAIT'||!legs)return{status:'SKIPPED',reason:'NO_EXECUTABLE_TRADE'};
  const entry=entryValue(strategy,legs); if(entry===null||entry<=0)return{status:'UNAVAILABLE',reason:'NO_EXECUTABLE_ENTRY_PRICE'};
  const marks=buildInstrumentMarks(legs,candlesByContract,snapshot.timestamp);
  const required=Object.values(legs).filter(v=>v&&typeof v==='object'&&v.contractId).length;
  if(Object.keys(marks).length<required||Object.values(marks).some(x=>!x.length))return{status:'UNAVAILABLE',reason:'MISSING_FUTURE_CONTRACT_CANDLES'};
  // Multi-leg values must be measured at the same candle timestamp. Pairing
  // rows by array index can silently combine different minutes when one leg
  // has a missing/illiquid candle.
  const names=Object.keys(marks);
  const snapshotMs=new Date(snapshot.timestamp).getTime();
  const maxRequested=Math.max(...horizons);
  const targetEndMs=snapshotMs+maxRequested*60000;
  const maps=Object.fromEntries(names.map(name=>[name,new Map(marks[name].map(c=>[new Date(c.timestamp).getTime(),c]))]));
  const commonTimes=[...maps[names[0]].keys()]
    .filter(ts=>names.every(name=>maps[name].has(ts)))
    .sort((a,b)=>a-b);
  if(!commonTimes.length)return{status:'UNAVAILABLE',reason:'NO_ALIGNED_FUTURE_CANDLES'};
  // A snapshot can occur between one-minute candle boundaries. Include the
  // first common candle at/after the requested horizon, then stop. This avoids
  // both false INCOMPLETE_HORIZON results and all-day MFE/MAE contamination.
  const cutoff=commonTimes.findIndex(ts=>ts>=targetEndMs);
  if(cutoff<0)return{status:'UNAVAILABLE',reason:'INCOMPLETE_HORIZON',entryValue:round(entry),observedThroughMinute:round((commonTimes[commonTimes.length-1]-snapshotMs)/60000,0),horizonsPct:{}};
  const studyTimes=commonTimes.slice(0,cutoff+1);
  const aligned=Object.fromEntries(names.map(name=>[name,studyTimes.map(ts=>maps[name].get(ts))]));
  let mfe=-Infinity,mae=Infinity,bestMinute=null,worstMinute=null,bestLegMarks=null,worstLegMarks=null;
  const horizonResults={},horizonLegMarks={};
  for(let i=0;i<studyTimes.length;i++){
    const v=strategyValue(strategy,legs,aligned,i),p=pnlPct(strategy,entry,v); if(p===null)continue;
    const mins=Math.max(0,(studyTimes[i]-snapshotMs)/60000);
    if(p>mfe){mfe=p;bestMinute=round(mins,0);bestLegMarks=legMarksAt(names,aligned,i);}
    if(p<mae){mae=p;worstMinute=round(mins,0);worstLegMarks=legMarksAt(names,aligned,i);}
    for(const h of horizons) if(horizonResults[h]===undefined&&mins>=h){
      horizonResults[h]=round(p);
      horizonLegMarks[h]={timestamp:new Date(studyTimes[i]).toISOString(),marks:legMarksAt(names,aligned,i)};
    }
  }
  if(!Number.isFinite(mfe)||!Number.isFinite(mae))return{status:'UNAVAILABLE',reason:'NO_VALID_MARKS'};
  if(horizonResults[maxRequested]===undefined)return{status:'UNAVAILABLE',reason:'INCOMPLETE_HORIZON',entryValue:round(entry),observedThroughMinute:studyTimes.length?round((studyTimes[studyTimes.length-1]-snapshotMs)/60000,0):null,horizonsPct:horizonResults};
  return{
    status:'MEASURED',
    entryValue:round(entry),
    entryLegMarks:entryLegMarks(strategy,legs),
    horizonLegMarks,
    mfePct:round(mfe),
    maePct:round(mae),
    bestMinute,
    worstMinute,
    bestLegMarks,
    worstLegMarks,
    horizonsPct:horizonResults
  };
}
function summarizeEvidence(records,minSamples=20){
  const groups={};
  for(const r of records||[]){if(r.outcome?.status!=='MEASURED')continue;const k=r.evidenceKey||evidenceKey(r.snapshot||r);(groups[k]??=[]).push(r.outcome);}
  const summary={};
  for(const [k,rows] of Object.entries(groups)){
    const vals=rows.map(x=>x.horizonsPct?.[60]).filter(Number.isFinite);
    const mfe=rows.map(x=>x.mfePct).filter(Number.isFinite),mae=rows.map(x=>x.maePct).filter(Number.isFinite),holds=rows.map(x=>x.bestMinute).filter(Number.isFinite);
    const avg=a=>a.length?round(a.reduce((x,y)=>x+y,0)/a.length):null;
    summary[k]={samples:rows.length,qualified:rows.length>=minSamples,winRate60m:vals.length?round(vals.filter(x=>x>0).length/vals.length*100):null,avgReturn60mPct:avg(vals),avgMfePct:avg(mfe),avgMaePct:avg(mae),avgBestMinute:avg(holds)};
  }
  return summary;
}
module.exports={bucketDte,bucketTime,evidenceKey,entrySides,entryLegMarks,measureOutcome,summarizeEvidence};
