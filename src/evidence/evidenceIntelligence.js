'use strict';

const { bucketDte, bucketTime } = require('./evidenceEngine');
const { setupFeatureTags, setupEvidenceKey } = require('./setupEvidence');

const DEFAULT_HORIZONS=[15,30,60,120];

function n(v){if(v===null||v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;}
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

function groupRows(rows,keyFn){
  const groups={};
  for(const row of rows){const key=String(keyFn(row)??'UNKNOWN');(groups[key]??=[]).push(row);}
  return groups;
}
function groupBy(rows,keyFn,minSamples,horizons){
  const groups=groupRows(rows,keyFn);
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

function executableLegs(row){
  return Object.values(snapshotOf(row).tradeLegs||{}).filter(v=>v&&typeof v==='object'&&v.contractId);
}
function grossPremiumPoints(row){
  return executableLegs(row).reduce((sum,leg)=>{
    const px=n(leg.ask)??n(leg.bid)??n(leg.premium);
    return sum+(px===null?0:Math.abs(px));
  },0);
}
function normalizeFriction(opts={}){
  const roundTripBpsOnGrossPremium=Math.max(0,n(opts.roundTripBpsOnGrossPremium)??0);
  const flatRupeesPerLegRoundTrip=Math.max(0,n(opts.flatRupeesPerLegRoundTrip)??0);
  const lotSize=Math.max(1,n(opts.lotSize)??65);
  return {
    configured:roundTripBpsOnGrossPremium>0||flatRupeesPerLegRoundTrip>0,
    roundTripBpsOnGrossPremium,
    flatRupeesPerLegRoundTrip,
    lotSize,
    basis:'research stress model; bps apply to gross option premium across executable legs, flat rupees are per leg round trip'
  };
}
function frictionCostPct(row,friction={}){
  const model=normalizeFriction(friction);
  const entry=n(row?.outcome?.entryValue);
  if(entry===null||entry<=0)return 0;
  const legs=executableLegs(row).length;
  if(!legs)return 0;
  const gross=grossPremiumPoints(row);
  const bpsPoints=gross*(model.roundTripBpsOnGrossPremium/10000);
  const flatPoints=(model.flatRupeesPerLegRoundTrip*legs)/model.lotSize;
  return round((bpsPoints+flatPoints)/entry*100,4);
}
function applyFriction(rows=[],friction={}){
  return rows.map(row=>{
    const cost=frictionCostPct(row,friction);
    const outcome=row.outcome||{};
    const horizonsPct={};
    for(const [h,v] of Object.entries(outcome.horizonsPct||{})){
      const x=n(v); horizonsPct[h]=x===null?v:round(x-cost,4);
    }
    const mfe=n(outcome.mfePct),mae=n(outcome.maePct);
    return {...row,outcome:{...outcome,
      frictionCostPct:cost,
      grossHorizonsPct:outcome.horizonsPct||{},
      horizonsPct,
      mfePct:mfe===null?outcome.mfePct:round(mfe-cost,4),
      maePct:mae===null?outcome.maePct:round(mae-cost,4)
    }};
  });
}
function snapshotTimestamp(row){
  const ts=snapshotOf(row).timestamp||row.timestamp;
  const ms=new Date(ts).getTime();
  return Number.isFinite(ms)?ms:Infinity;
}
function chronologicalSplit(rows=[],testFraction=0.30){
  const fraction=Math.min(0.5,Math.max(0.1,n(testFraction)??0.30));
  const sorted=[...rows].sort((a,b)=>snapshotTimestamp(a)-snapshotTimestamp(b));
  if(sorted.length<2)return{fraction,train:sorted,test:[],cutoffTimestamp:null};
  const testCount=Math.max(1,Math.floor(sorted.length*fraction));
  const splitAt=Math.max(1,sorted.length-testCount);
  const train=sorted.slice(0,splitAt),test=sorted.slice(splitAt);
  return{fraction,train,test,cutoffTimestamp:snapshotOf(test[0])?.timestamp||test[0]?.timestamp||null};
}
function validationMetrics(rows,minSamples,horizons,friction){
  return {
    gross:metrics(rows,minSamples,horizons),
    frictionAdjusted:metrics(applyFriction(rows,friction),minSamples,horizons)
  };
}
function validationGroups(train,test,keyFn,minTrainSamples,minTestSamples,horizons,friction){
  const a=groupRows(train,keyFn),b=groupRows(test,keyFn);
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];
  const out={};
  for(const key of keys){
    const tr=a[key]||[],te=b[key]||[];
    out[key]={
      validationReady:tr.length>=minTrainSamples&&te.length>=minTestSamples,
      train:validationMetrics(tr,minTrainSamples,horizons,friction),
      test:validationMetrics(te,minTestSamples,horizons,friction)
    };
  }
  return Object.fromEntries(Object.entries(out).sort((x,y)=>{
    const ax=x[1].train.gross.samples+x[1].test.gross.samples;
    const ay=y[1].train.gross.samples+y[1].test.gross.samples;
    return ay-ax||x[0].localeCompare(y[0]);
  }));
}
function buildChronologicalValidation(rows=[],opts={}){
  const horizons=Array.isArray(opts.horizons)&&opts.horizons.length?opts.horizons:DEFAULT_HORIZONS;
  const minTrainSamples=Math.max(1,n(opts.minTrainSamples)??20);
  const minTestSamples=Math.max(1,n(opts.minTestSamples)??10);
  const friction=normalizeFriction(opts.friction||{});
  const split=chronologicalSplit(rows,opts.testFraction);
  const common={
    version:'CHRONOLOGICAL_HOLDOUT_V1',
    researchOnly:true,
    liveDecisionImpact:false,
    testFraction:split.fraction,
    cutoffTimestamp:split.cutoffTimestamp,
    trainEpisodes:split.train.length,
    testEpisodes:split.test.length,
    minTrainSamples,
    minTestSamples,
    enoughForHoldout:split.train.length>=minTrainSamples&&split.test.length>=minTestSamples,
    frictionModel:friction,
    methodology:'Oldest observations form training; newest observations form a frozen chronological holdout. No shuffling. Validation-ready is only a sample gate, not proof of edge or permission to trade.'
  };
  return {
    ...common,
    overall:{
      validationReady:common.enoughForHoldout,
      train:validationMetrics(split.train,minTrainSamples,horizons,friction),
      test:validationMetrics(split.test,minTestSamples,horizons,friction)
    },
    strategyGroups:validationGroups(split.train,split.test,r=>snapshotOf(r).strategy||'WAIT',minTrainSamples,minTestSamples,horizons,friction),
    scannerGroups:validationGroups(split.train,split.test,scannerCombinationKey,minTrainSamples,minTestSamples,horizons,friction),
    scannerDimensions:{
      openingRange:validationGroups(split.train,split.test,r=>scannerKey(r,'OPENING_RANGE_BREAK'),minTrainSamples,minTestSamples,horizons,friction),
      vwapContinuation:validationGroups(split.train,split.test,r=>scannerKey(r,'VWAP_CONTINUATION'),minTrainSamples,minTestSamples,horizons,friction),
      vwapPullback:validationGroups(split.train,split.test,r=>scannerKey(r,'VWAP_PULLBACK'),minTrainSamples,minTestSamples,horizons,friction),
      momentum:validationGroups(split.train,split.test,r=>scannerKey(r,'MULTI_TIMEFRAME_MOMENTUM'),minTrainSamples,minTestSamples,horizons,friction)
    }
  };
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
  const validation=buildChronologicalValidation(rows,{
    horizons,
    minTrainSamples:opts.minTrainSamples,
    minTestSamples:opts.minTestSamples,
    testFraction:opts.testFraction,
    friction:opts.friction
  });
  return {
    version:'EVIDENCE_INTELLIGENCE_V3',generatedAt:new Date().toISOString(),researchOnly:true,liveDecisionImpact:false,
    minSamples,measuredEpisodes:rows.length,
    methodology:{population:'MEASURED READY_TO_EXECUTE episode outcomes only',dedupe:'one measured outcome per snapshotId',horizonsMinutes:horizons,
      winDefinition:'horizon return > 0',qualification:'sample-count marker only; not proof of edge or permission to trade',
      friction:'V3 includes a configurable research friction stress model. Zero-cost defaults remain explicit until broker-specific costs are calibrated.',
      validation:'chronological holdout only: oldest observations train, newest observations test; no random shuffle and no live-decision impact',
      scanner:'Setup Scanner dimensions are observational research labels only; qualification does not permit live trading'},
    overall:metrics(rows,minSamples,horizons),dimensions,setupGroups,scannerGroups,validation
  };
}

module.exports={
  DEFAULT_HORIZONS,measuredEpisodes,metrics,scannerKey,scannerCombinationKey,
  normalizeFriction,frictionCostPct,applyFriction,chronologicalSplit,buildChronologicalValidation,
  buildEvidenceIntelligence
};
