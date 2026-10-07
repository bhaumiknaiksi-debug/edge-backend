'use strict';

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=2){return Number(Number(v).toFixed(dp));}
function summarize(rows){
  const vals=(rows||[]).map(r=>n(r?.outcome?.horizonsPct?.[60])).filter(Number.isFinite);
  const mfe=(rows||[]).map(r=>n(r?.outcome?.mfePct)).filter(Number.isFinite);
  const mae=(rows||[]).map(r=>n(r?.outcome?.maePct)).filter(Number.isFinite);
  const avg=a=>a.length?round(a.reduce((x,y)=>x+y,0)/a.length):null;
  return{samples:(rows||[]).length,measured60m:vals.length,winRate60mPct:vals.length?round(vals.filter(x=>x>0).length/vals.length*100):null,avgReturn60mPct:avg(vals),avgMfePct:avg(mfe),avgMaePct:avg(mae)};
}
function group(records,keyFn){
  const m={};
  for(const r of records){const k=keyFn(r);if(!k)continue;(m[k]??=[]).push(r);}
  return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,summarize(v)]));
}
function buildPriceActionResearch(rows=[]){
  const measured=(rows||[]).filter(r=>r.recordType==='RESEARCH_CANDIDATE_OUTCOME'&&r.outcome?.status==='MEASURED');
  const snap=r=>r.snapshot||{};
  return{
    version:'PRICE_ACTION_RESEARCH_V1',researchOnly:true,liveDecisionImpact:false,
    methodology:'Measured B/C research-candidate outcomes only. Observational groups are descriptive, correlated, and are not proof of an edge or permission to trade.',
    totalMeasured:measured.length,
    byTier:group(measured,r=>r.tier),
    byChartVerdict:group(measured,r=>snap(r)?.chartIntelligence?.verdict||null),
    byCprWidth:group(measured,r=>snap(r)?.chartIntelligence?.cpr?.daily?.widthClass||null),
    byTrendStrength:group(measured,r=>snap(r)?.chartIntelligence?.technicals?.trendStrength||null),
    byPrimaryLevelEvent:group(measured,r=>snap(r)?.chartIntelligence?.levelEvents?.[0]?.type||'NO_RECENT_LEVEL_EVENT'),
    byOptionAlignment:group(measured,r=>{
      const t=r.tier;return snap(r)?.optionExecutionIntelligence?.tiers?.[t]?.thesisAlignment||null;
    })
  };
}
module.exports={buildPriceActionResearch,summarize};
