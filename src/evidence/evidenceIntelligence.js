'use strict';

const { bucketDte, bucketTime } = require('./evidenceEngine');
const { setupFeatureTags, setupEvidenceKey } = require('./setupEvidence');

const DEFAULT_HORIZONS=[15,30,60,120];

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=2){return Number(Number(v).toFixed(dp));}
function avg(xs){return xs.length?round(xs.reduce((a,b)=>a+b,0)/xs.length):null;}
function median(xs){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2);return round(a.length%2?a[m]:(a[m-1]+a[m])/2);}

function measuredEpisodes(records=[]){
  const bySnapshot=new Map();
  for(const r of records){
    if(r?.recordType!=='OUTCOME'||r?.outcome?.status!=='MEASURED'||!r.snapshotId)continue;
    const prev=bySnapshot.get(r.snapshotId);
    if(!prev||Number(r.attempt||0)>=Number(prev.attempt||0))bySnapshot.set(r.snapshotId,r);
  }
  return [...bySnapshot.values()];
}

function metrics(rows=[],minSamples=20,horizons=DEFAULT_HORIZONS){
  const result={samples:rows.length,qualified:rows.length>=minSamples,descriptiveOnly:true,horizons:{},
    avgMfePct:avg(rows.map(r=>n(r.outcome?.mfePct)).filter(v=>v!==null)),
    avgMaePct:avg(rows.map(r=>n(r.outcome?.maePct)).filter(v=>v!==null)),
    avgBestMinute:avg(rows.map(r=>n(r.outcome?.bestMinute)).filter(v=>v!==null))};
  for(const h of horizons){
    const vals=rows.map(r=>n(r.outcome?.horizonsPct?.[h])).filter(v=>v!==null);
    result.horizons[h]={measured:vals.length,winRatePct:vals.length?round(vals.filter(v=>v>0).length/vals.length*100):null,avgReturnPct:avg(vals),medianReturnPct:median(vals)};
  }
  return result;
}

function groupBy(rows,keyFn,minSamples,horizons){
  const groups={};
  for(const row of rows){const key=String(keyFn(row)??'UNKNOWN');(groups[key]??=[]).push(row);}
  return Object.fromEntries(Object.entries(groups).sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0])).map(([key,items])=>[key,metrics(items,minSamples,horizons)]));
}
function snapshotOf(row){return row.snapshot||{};}
function scannerCandidate(row,type){
  return (snapshotOf(row).setupScanner?.candidates||[]).find(c=>c?.type===type)||null;
}
function scannerKey(row,type){
  const c=scannerCandidate(row,type);
  if(!c||c.observed===false||c.state==='UNAVAILABLE')return 'UNAVAILABLE';
  return [c.direction||'UNKNOWN',c.state||'UNKNOWN'].join('|');
}
function scannerCombinationKey(row){
  const s=snapshotOf(row).setupScanner;
  if(!s||!Array.isArray(s.candidates))return 'UNAVAILABLE';
  const types=['OPENING_RANGE_BREAK','VWAP_CONTINUATION','VWAP_PULLBACK','MULTI_TIMEFRAME_MOMENTUM'];
  return types.map(type=>type+'='+scannerKey(row,type)).join('||');
}

function buildEvidenceIntelligence(records=[],opts={}){
  const minSamples=Number.isFinite(Number(opts.minSamples))?Math.max(1,Number(opts.minSamples)):20;
  const horizons=Array.isArray(opts.horizons)&&opts.horizons.length?opts.horizons:DEFAULT_HORIZONS;
  const rows=measuredEpisodes(records);
  const tags=row=>setupFeatureTags(snapshotOf(row));
  const dimensions={
    strategy:groupBy(rows,r=>snapshotOf(r).strategy||'WAIT',minSamples,horizons),
    regime:groupBy(rows,r=>snapshotOf(r).regime?.direction||snapshotOf(r).bias||'UNKNOWN',minSamples,horizons),
    volatility:groupBy(rows,r=>snapshotOf(r).volatility?.richness||snapshotOf(r).ivRegime||'UNKNOWN',minSamples,horizons),
    dte:groupBy(rows,r=>bucketDte(snapshotOf(r).dte),minSamples,horizons),
    session:groupBy(rows,r=>bucketTime(snapshotOf(r).timestamp),minSamples,horizons),
    openingRange:groupBy(rows,r=>tags(r).openingRangePosition,minSamples,horizons),
    vwapSide:groupBy(rows,r=>tags(r).vwapSide,minSamples,horizons),
    vwapSlope:groupBy(rows,r=>tags(r).vwapSlopeDirection,minSamples,horizons),
    relativeVolume:groupBy(rows,r=>tags(r).relativeVolumeBucket,minSamples,horizons),
    atr:groupBy(rows,r=>tags(r).atrBucket,minSamples,horizons),
    scannerOpeningRange:groupBy(rows,r=>scannerKey(r,'OPENING_RANGE_BREAK'),minSamples,horizons),
    scannerVwapContinuation:groupBy(rows,r=>scannerKey(r,'VWAP_CONTINUATION'),minSamples,horizons),
    scannerVwapPullback:groupBy(rows,r=>scannerKey(r,'VWAP_PULLBACK'),minSamples,horizons),
    scannerMomentum:groupBy(rows,r=>scannerKey(r,'MULTI_TIMEFRAME_MOMENTUM'),minSamples,horizons)
  };
  const setupGroups=groupBy(rows,r=>r.setupEvidenceKey||setupEvidenceKey(snapshotOf(r)),minSamples,horizons);
  const scannerGroups=groupBy(rows,scannerCombinationKey,minSamples,horizons);
  return {
    version:'EVIDENCE_INTELLIGENCE_V2',generatedAt:new Date().toISOString(),researchOnly:true,liveDecisionImpact:false,
    minSamples,measuredEpisodes:rows.length,
    methodology:{population:'MEASURED READY_TO_EXECUTE episode outcomes only',dedupe:'one measured outcome per snapshotId',horizonsMinutes:horizons,
      winDefinition:'horizon return > 0',qualification:'sample-count marker only; not proof of edge or permission to trade',
      friction:'returns currently exclude brokerage, taxes, fees and execution slippage; exit marks use aligned 1m candle closes',
      scanner:'Setup Scanner dimensions are observational research labels only; qualification does not permit live trading'},
    overall:metrics(rows,minSamples,horizons),dimensions,setupGroups,scannerGroups
  };
}

module.exports={DEFAULT_HORIZONS,measuredEpisodes,metrics,buildEvidenceIntelligence};
