'use strict';

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=2){return Number(Number(v).toFixed(dp));}

function buildGammaConcentration(strikes=[],spot=null){
  const s=n(spot);
  if(s===null||s<=0)return{version:'GAMMA_CONCENTRATION_V1',researchOnly:true,liveDecisionImpact:false,available:false,reason:'SPOT_UNAVAILABLE'};
  const rows=(strikes||[]).map(r=>{
    const strike=n(r.strike),ceGamma=n(r.ceGamma),peGamma=n(r.peGamma),ceOI=n(r.ceOI)||0,peOI=n(r.peOI)||0;
    const ce=ceGamma===null?null:Math.abs(ceGamma)*ceOI*s*s*0.01;
    const pe=peGamma===null?null:Math.abs(peGamma)*peOI*s*s*0.01;
    return{strike,ceGammaConcentration:ce,peGammaConcentration:pe,total:(ce||0)+(pe||0)};
  }).filter(r=>r.strike!==null&&(r.ceGammaConcentration!==null||r.peGammaConcentration!==null));
  if(!rows.length)return{version:'GAMMA_CONCENTRATION_V1',researchOnly:true,liveDecisionImpact:false,available:false,reason:'GAMMA_UNAVAILABLE'};
  const total=rows.reduce((a,r)=>a+r.total,0);
  const callWall=rows.filter(r=>r.strike>=s&&r.ceGammaConcentration!==null).sort((a,b)=>b.ceGammaConcentration-a.ceGammaConcentration)[0]||null;
  const putWall=rows.filter(r=>r.strike<=s&&r.peGammaConcentration!==null).sort((a,b)=>b.peGammaConcentration-a.peGammaConcentration)[0]||null;
  const ranked=rows.slice().sort((a,b)=>b.total-a.total).slice(0,8).map(r=>({
    strike:r.strike,
    callSharePct:total?round((r.ceGammaConcentration||0)/total*100):0,
    putSharePct:total?round((r.peGammaConcentration||0)/total*100):0,
    totalSharePct:total?round(r.total/total*100):0
  }));
  return{
    version:'GAMMA_CONCENTRATION_V1',researchOnly:true,liveDecisionImpact:false,available:true,
    methodology:'Unsigned gamma × open-interest concentration proxy. It maps where gamma is concentrated; it does NOT infer dealer long/short gamma or a zero-gamma flip.',
    callWall:callWall?{strike:callWall.strike,sharePct:total?round(callWall.ceGammaConcentration/total*100):0}:null,
    putWall:putWall?{strike:putWall.strike,sharePct:total?round(putWall.peGammaConcentration/total*100):0}:null,
    topStrikes:ranked,
    totalConcentration:round(total,0)
  };
}
module.exports={buildGammaConcentration};
