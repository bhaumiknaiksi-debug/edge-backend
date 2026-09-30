'use strict';

const { bucketDte, bucketTime } = require('./evidenceEngine');
const { setupFeatureTags, setupEvidenceKey } = require('./setupEvidence');
const { getProfile, calibratedRoundTripCost } = require('./tradingFriction');

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
  const profileName=opts.profileName||opts.profile||null;
  const calibratedProfile=getProfile(profileName);
  const roundTripBpsOnGrossPremium=Math.max(0,n(opts.roundTripBpsOnGrossPremium)??0);
  const flatRupeesPerLegRoundTrip=Math.max(0,n(opts.flatRupeesPerLegRoundTrip)??0);
  const slippageBps=Math.max(0,n(opts.slippageBps)??0);
  const lotSize=Math.max(1,n(opts.lotSize)??65);
  const stressConfigured=roundTripBpsOnGrossPremium>0||flatRupeesPerLegRoundTrip>0||slippageBps>0;
  return {
    configured:!!calibratedProfile||stressConfigured,
    mode:calibratedProfile?'CALIBRATED_PROFILE':stressConfigured?'STRESS':'NONE',
    profileName:calibratedProfile?.name||null,
    calibratedProfile:calibratedProfile?{
      name:calibratedProfile.name,
      broker:calibratedProfile.broker,
      segment:calibratedProfile.segment,
      effectiveFrom:calibratedProfile.effectiveFrom,
      calibratedAsOf:calibratedProfile.calibratedAsOf,
      brokeragePerExecutedOrderRupees:calibratedProfile.brokeragePerExecutedOrderRupees,
      sttSellPct:calibratedProfile.sttSellPct,
      exchangeTransactionPct:calibratedProfile.exchangeTransactionPct,
      sebiPerCroreRupees:calibratedProfile.sebiPerCroreRupees,
      stampDutyBuyPct:calibratedProfile.stampDutyBuyPct,
      gstPct:calibratedProfile.gstPct,
      ipftPerCroreRupees:calibratedProfile.ipftPerCroreRupees,
      assumptions:calibratedProfile.assumptions
    }:null,
    roundTripBpsOnGrossPremium,
    flatRupeesPerLegRoundTrip,
    slippageBps,
    lotSize,
    basis:calibratedProfile
      ?'calibrated broker/statutory option charges applied to leg-level entry and horizon exit marks'
      :'research stress model; friction bps and slippage bps apply to gross option premium across executable legs, flat rupees are per leg round trip'
  };
}
function frictionCostPct(row,friction={},horizon=null){
  const model=normalizeFriction(friction);
  if(model.mode==='CALIBRATED_PROFILE'){
    if(horizon===null||horizon===undefined)return null;
    const exact=calibratedRoundTripCost(row,horizon,model.profileName,{slippageBps:model.slippageBps});
    return exact.available?exact.costPct:null;
  }
  if(model.mode==='NONE')return 0;
  const entry=n(row?.outcome?.entryValue);
  if(entry===null||entry<=0)return null;
  const legs=executableLegs(row).length;
  if(!legs)return null;
  const gross=grossPremiumPoints(row);
  const bpsPoints=gross*(model.roundTripBpsOnGrossPremium/10000);
  // Without leg-level horizon marks, treat slippageBps as an explicit round-trip
  // premium-turnover stress rather than silently ignoring it.
  const slippagePoints=gross*(model.slippageBps/10000);
  const flatPoints=(model.flatRupeesPerLegRoundTrip*legs)/model.lotSize;
  return round((bpsPoints+slippagePoints+flatPoints)/entry*100,4);
}
function applyFriction(rows=[],friction={}){
  const model=normalizeFriction(friction);
  return rows.map(row=>{
    const outcome=row.outcome||{};
    const horizonsPct={},costsByHorizon={};
    for(const [h,v] of Object.entries(outcome.horizonsPct||{})){
      const x=n(v),cost=frictionCostPct(row,model,h);
      costsByHorizon[h]=cost;
      horizonsPct[h]=x===null?null:(cost===null?null:round(x-cost,4));
    }
    let mfe=outcome.mfePct,mae=outcome.maePct;
    if(model.mode==='STRESS'){
      const cost=frictionCostPct(row,model);
      const m=n(outcome.mfePct),a=n(outcome.maePct);
      mfe=m===null?outcome.mfePct:(cost===null?null:round(m-cost,4));
      mae=a===null?outcome.maePct:(cost===null?null:round(a-cost,4));
    } else if(model.mode==='CALIBRATED_PROFILE'){
      // Exact excursion costs require the exit-leg marks at the best/worst minute.
      // Keep them unavailable rather than subtracting a fabricated constant.
      mfe=null; mae=null;
    }
    return {...row,outcome:{...outcome,
      frictionMode:model.mode,
      frictionCostsPctByHorizon:costsByHorizon,
      grossHorizonsPct:outcome.horizonsPct||{},
      horizonsPct,
      mfePct:mfe,
      maePct:mae
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

function uniqueBySnapshot(rows=[]){
  const m=new Map();
  for(const row of rows){const k=row.snapshotId||row.id;if(k)m.set(k,row);}
  return [...m.values()];
}
function walkForwardFolds(rows=[],opts={}){
  const sorted=[...rows].sort((a,b)=>snapshotTimestamp(a)-snapshotTimestamp(b));
  const minTrainSamples=Math.max(1,n(opts.minTrainSamples)??20);
  const minTestSamples=Math.max(1,n(opts.minTestSamples)??5);
  const testWindowSize=Math.max(minTestSamples,n(opts.testWindowSize)??10);
  // Replication claims require disjoint forward test blocks. Clamp custom steps
  // so a snapshot can never confirm more than one fold.
  const requestedStepSize=Math.max(1,n(opts.stepSize)??testWindowSize);
  const stepSize=Math.max(testWindowSize,requestedStepSize);
  const maxFolds=Math.max(1,n(opts.maxFolds)??12);
  const folds=[];
  for(let testStart=minTrainSamples;testStart<sorted.length;testStart+=stepSize){
    const train=sorted.slice(0,testStart);
    const test=sorted.slice(testStart,Math.min(sorted.length,testStart+testWindowSize));
    if(test.length<minTestSamples)break;
    folds.push({
      index:folds.length+1,
      train,
      test,
      trainStart:snapshotOf(train[0])?.timestamp||null,
      trainEnd:snapshotOf(train[train.length-1])?.timestamp||null,
      testStart:snapshotOf(test[0])?.timestamp||null,
      testEnd:snapshotOf(test[test.length-1])?.timestamp||null
    });
  }
  return{minTrainSamples,minTestSamples,testWindowSize,stepSize,maxFolds,folds:folds.slice(-maxFolds)};
}
function populationStdDev(xs){
  if(!xs.length)return null;
  const mean=xs.reduce((a,b)=>a+b,0)/xs.length;
  return round(Math.sqrt(xs.reduce((sum,x)=>sum+((x-mean)**2),0)/xs.length));
}
function walkForwardStability(foldResults=[],horizons=DEFAULT_HORIZONS){
  const totalFolds=foldResults.length;
  const totalTestSamples=foldResults.reduce((sum,f)=>sum+Number(f.testSamples||0),0);
  const eligible=foldResults.filter(f=>f.eligible!==false&&f.test);
  const summarize=mode=>Object.fromEntries(horizons.map(h=>{
    const valid=eligible.map(f=>({
      samples:Number(f.test?.[mode]?.horizons?.[h]?.measured||0),
      value:n(f.test?.[mode]?.horizons?.[h]?.avgReturnPct)
    })).filter(x=>x.samples>0&&x.value!==null);
    const values=valid.map(x=>x.value);
    const measuredSamples=valid.reduce((sum,x)=>sum+x.samples,0);
    return [h,{
      validFolds:valid.length,
      positiveFolds:values.filter(v=>v>0).length,
      medianFoldReturnPct:median(values),
      worstFoldReturnPct:values.length?round(Math.min(...values)):null,
      dispersionStdDevPct:populationStdDev(values),
      eligibleMeasuredTestSamples:measuredSamples,
      eligibleSampleCoveragePct:totalTestSamples?round(measuredSamples/totalTestSamples*100):null
    }];
  }));
  return{
    definition:'Fold return is each eligible forward-test block average return. Dispersion is population standard deviation across valid fold-average returns. Eligible-sample coverage is measured horizon samples from eligible folds divided by all forward-test samples for this scope; fold coverage separately reports eligibility across folds.',
    totalFolds,
    eligibleFolds:eligible.length,
    foldCoveragePct:totalFolds?round(eligible.length/totalFolds*100):null,
    gross:summarize('gross'),
    frictionAdjusted:summarize('frictionAdjusted')
  };
}
function walkForwardGroupSummary(folds,keyFn,minTrainGroup,minTestGroup,horizons,friction){
  const keys=new Set();
  for(const fold of folds){
    Object.keys(groupRows(fold.train,keyFn)).forEach(k=>keys.add(k));
    Object.keys(groupRows(fold.test,keyFn)).forEach(k=>keys.add(k));
  }
  const out={};
  for(const key of keys){
    let eligibleFolds=0;
    const collected=[];
    const foldResults=[];
    for(const fold of folds){
      const tr=groupRows(fold.train,keyFn)[key]||[];
      const te=groupRows(fold.test,keyFn)[key]||[];
      const eligible=tr.length>=minTrainGroup&&te.length>=minTestGroup;
      if(eligible){eligibleFolds++;collected.push(...te);}
      foldResults.push({fold:fold.index,eligible,trainSamples:tr.length,testSamples:te.length,
        test:eligible?validationMetrics(te,minTestGroup,horizons,friction):null});
    }
    const unique=uniqueBySnapshot(collected);
    out[key]={
      totalFolds:folds.length,
      eligibleFolds,
      replicatedAcrossFolds:eligibleFolds>=2,
      aggregateTest:validationMetrics(unique,minTestGroup,horizons,friction),
      stability:walkForwardStability(foldResults,horizons),
      folds:foldResults
    };
  }
  return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1].aggregateTest.gross.samples-a[1].aggregateTest.gross.samples||a[0].localeCompare(b[0])));
}
function buildWalkForwardValidation(rows=[],opts={}){
  const horizons=Array.isArray(opts.horizons)&&opts.horizons.length?opts.horizons:DEFAULT_HORIZONS;
  const friction=normalizeFriction(opts.friction||{});
  const wf=walkForwardFolds(rows,opts);
  const minTrainGroup=Math.max(1,n(opts.minTrainGroupSamples)??Math.min(10,wf.minTrainSamples));
  const minTestGroup=Math.max(1,n(opts.minTestGroupSamples)??Math.min(3,wf.minTestSamples));
  const allTest=uniqueBySnapshot(wf.folds.flatMap(f=>f.test));
  const renderedFolds=wf.folds.map(f=>({
    index:f.index,eligible:true,
    trainStart:f.trainStart,trainEnd:f.trainEnd,testStart:f.testStart,testEnd:f.testEnd,
    trainEpisodes:f.train.length,testEpisodes:f.test.length,testSamples:f.test.length,
    train:validationMetrics(f.train,wf.minTrainSamples,horizons,friction),
    test:validationMetrics(f.test,wf.minTestSamples,horizons,friction)
  }));
  return{
    version:'WALK_FORWARD_V1',
    researchOnly:true,
    liveDecisionImpact:false,
    foldCount:wf.folds.length,
    minTrainSamples:wf.minTrainSamples,
    minTestSamples:wf.minTestSamples,
    testWindowSize:wf.testWindowSize,
    stepSize:wf.stepSize,
    maxFolds:wf.maxFolds,
    minTrainGroupSamples:minTrainGroup,
    minTestGroupSamples:minTestGroup,
    enoughForWalkForward:wf.folds.length>=2,
    frictionModel:friction,
    methodology:'Expanding chronological training window with non-random forward test blocks. Aggregate test metrics dedupe snapshotId. Two or more folds is only a replication sample gate, not proof of edge or permission to trade.',
    folds:renderedFolds.map(({eligible,testSamples,...f})=>f),
    aggregateTest:validationMetrics(allTest,wf.minTestSamples,horizons,friction),
    stability:walkForwardStability(renderedFolds,horizons),
    strategyGroups:walkForwardGroupSummary(wf.folds,r=>snapshotOf(r).strategy||'WAIT',minTrainGroup,minTestGroup,horizons,friction),
    scannerGroups:walkForwardGroupSummary(wf.folds,scannerCombinationKey,minTrainGroup,minTestGroup,horizons,friction)
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
  const walkForward=buildWalkForwardValidation(rows,{
    horizons,
    minTrainSamples:opts.walkForwardMinTrainSamples??opts.minTrainSamples,
    minTestSamples:opts.walkForwardMinTestSamples,
    testWindowSize:opts.walkForwardTestWindowSize,
    stepSize:opts.walkForwardStepSize,
    maxFolds:opts.walkForwardMaxFolds,
    minTrainGroupSamples:opts.walkForwardMinTrainGroupSamples,
    minTestGroupSamples:opts.walkForwardMinTestGroupSamples,
    friction:opts.friction
  });
  return {
    version:'EVIDENCE_INTELLIGENCE_V4',generatedAt:new Date().toISOString(),researchOnly:true,liveDecisionImpact:false,
    minSamples,measuredEpisodes:rows.length,
    methodology:{population:'MEASURED READY_TO_EXECUTE episode outcomes only',dedupe:'one measured outcome per snapshotId',horizonsMinutes:horizons,
      winDefinition:'horizon return > 0',qualification:'sample-count marker only; not proof of edge or permission to trade',
      friction:'V4 uses current Upstox standard brokerage plus NSE/SEBI/statutory option charges from leg-level entry/exit marks. Exit execution slippage is a separate configurable stress input and defaults to zero until observed.',
      validation:'chronological holdout plus expanding-window walk-forward validation; no random shuffle and no live-decision impact',
      scanner:'Setup Scanner dimensions are observational research labels only; qualification does not permit live trading'},
    overall:metrics(rows,minSamples,horizons),dimensions,setupGroups,scannerGroups,validation,walkForward
  };
}

module.exports={
  DEFAULT_HORIZONS,measuredEpisodes,metrics,scannerKey,scannerCombinationKey,
  normalizeFriction,frictionCostPct,applyFriction,chronologicalSplit,buildChronologicalValidation,
  walkForwardFolds,walkForwardStability,buildWalkForwardValidation,buildEvidenceIntelligence
};
