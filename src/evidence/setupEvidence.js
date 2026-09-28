'use strict';

const { bucketDte, bucketTime } = require('./evidenceEngine');

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=2){return Number(Number(v).toFixed(dp));}
function bucket(v,cuts,labels){
  const x=n(v); if(x===null)return'UNKNOWN';
  for(let i=0;i<cuts.length;i++) if(x<cuts[i]) return labels[i];
  return labels[labels.length-1];
}

function setupFeatureTags(snapshot={}){
  const s=snapshot.setupFeatures||{};
  const atr=n(s.atr?.value), spot=n(snapshot.spot);
  const atrPct=atr!==null&&spot?atr/spot*100:null;
  const vwapDistance=n(s.vwap?.distancePct);
  const vwapSlope=n(s.vwap?.slope);
  const relVol=n(s.volume?.relativeVolume ?? s.vwap?.relativeVolume);
  const orPos=s.openingRange?.position||'UNAVAILABLE';

  return {
    atrPct:atrPct===null?null:round(atrPct,3),
    atrBucket:bucket(atrPct,[0.08,0.14],['LOW','NORMAL','HIGH']),
    vwapDistancePct:vwapDistance,
    vwapSide:vwapDistance===null?'UNKNOWN':vwapDistance>0?'ABOVE':vwapDistance<0?'BELOW':'AT',
    vwapSlope,
    vwapSlopeDirection:vwapSlope===null?'UNKNOWN':vwapSlope>0.005?'RISING':vwapSlope<-0.005?'FALLING':'FLAT',
    relativeVolume:relVol,
    relativeVolumeBucket:bucket(relVol,[0.8,1.2],['LOW','NORMAL','HIGH']),
    openingRangePosition:orPos
  };
}

function setupEvidenceKey(snapshot={}){
  const t=setupFeatureTags(snapshot);
  return [
    snapshot.regime?.direction||snapshot.bias||'UNKNOWN',
    snapshot.volatility?.richness||snapshot.ivRegime||'UNKNOWN',
    bucketDte(snapshot.dte),
    bucketTime(snapshot.timestamp),
    snapshot.strategy||snapshot.decision?.strategy||'WAIT',
    'OR:'+t.openingRangePosition,
    'VWAP:'+t.vwapSide+'_'+t.vwapSlopeDirection,
    'RVOL:'+t.relativeVolumeBucket,
    'ATR:'+t.atrBucket
  ].join('|');
}

function summarizeSetupEvidence(records=[],minSamples=20){
  const groups={};
  for(const r of records){
    if(r.outcome?.status!=='MEASURED')continue;
    const snap=r.snapshot||r;
    const k=r.setupEvidenceKey||setupEvidenceKey(snap);
    (groups[k]??=[]).push(r.outcome);
  }
  const out={};
  for(const [k,rows] of Object.entries(groups)){
    const h60=rows.map(x=>x.horizonsPct?.60).filter(Number.isFinite);
    const mfe=rows.map(x=>x.mfePct).filter(Number.isFinite);
    const mae=rows.map(x=>x.maePct).filter(Number.isFinite);
    const avg=a=>a.length?round(a.reduce((x,y)=>x+y,0)/a.length):null;
    out[k]={
      samples:rows.length,
      qualified:rows.length>=minSamples,
      descriptiveOnly:true,
      winRate60m:h60.length?round(h60.filter(x=>x>0).length/h60.length*100):null,
      avgReturn60mPct:avg(h60),
      avgMfePct:avg(mfe),
      avgMaePct:avg(mae)
    };
  }
  return out;
}

module.exports={setupFeatureTags,setupEvidenceKey,summarizeSetupEvidence};
