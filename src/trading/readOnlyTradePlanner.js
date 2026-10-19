'use strict';

/**
 * EDGE observational trade planner v1.
 * Reads an existing analysis and its untouched A/B/C candidate contracts.
 * NEVER grants an entry, promotes a tier, places an order, or changes risk.
 * IV/delta-only projections are educational approximations, not executable quotes.
 */
const VERSION='TRADE_PLANNER_SHADOW_V1';
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const money=v=>v===null||!Number.isFinite(v)?null:Math.round(v*100)/100;
function legsOf(plan){
  return ['buyLeg','sellLeg','ceShort','ceLong','peShort','peLong'].flatMap(name=>{
    const leg=plan?.legs?.[name];
    if(!leg||!['CE','PE'].includes(leg.type)||num(leg.strike)===null)return [];
    return [{name,side:['sellLeg','ceShort','peShort'].includes(name)?'SELL':'BUY',
      contractId:leg.contractId||null,strike:num(leg.strike),type:leg.type,
      bid:num(leg.bid),ask:num(leg.ask),ltp:num(leg.premium),delta:num(leg.delta)}];
  });
}
function makePlan(analysis,tier){
  const timestamp=analysis?.timestamp||null,plan=analysis?.decision?.researchCandidatePlans?.plans?.[tier];
  const out={version:VERSION,analysisAt:timestamp,tier,mode:'SHADOW',liveDecisionImpact:false,
    authorizationChanged:false,executable:false,status:'INSUFFICIENT_DATA',
    strategy:plan?.strategy||null,entry:null,stop:null,targets:[],invalidatesAt:null,
    thesisInvalidation:null,timeHorizonMinutes:20,reasons:[],caveats:[
      'Research-only. Never overrides the existing A/B/C gate.',
      'Option premium projections omit gamma, theta, vega and execution slippage.',
      '20-minute horizon is an unvalidated research hypothesis, not a timed exit order.'
    ]};
  if(!plan||plan.available!==true){out.reasons.push('NO_BACKEND_CANDIDATE');return out;}
  const spot=num(analysis.spot),support=num(analysis.support?.strike),resistance=num(analysis.resistance?.strike);
  const legs=legsOf(plan);
  if(spot===null||spot<=0||!legs.length){out.reasons.push('MISSING_SPOT_OR_CONTRACT');return out;}
  // V1 handles long calls/puts only; spreads require a verified multi-leg exit-price
  // model and cannot be assigned a fictitious single-leg premium target.
  if(!['LONG_CALL','LONG_PUT'].includes(plan.strategy)||legs.length!==1||legs[0].side!=='BUY'){
    out.reasons.push('MULTI_LEG_MODEL_PENDING');return out;
  }
  const leg=legs[0],direction=plan.strategy==='LONG_CALL'?1:-1;
  // Authoritative A has legDelta at the tradeLegs root, while B/C put it on each leg.
  const ask=leg.ask,bid=leg.bid,delta=leg.delta??num(plan.legs?.legDelta);
  out.contract=leg.contractId;
  out.thesisInvalidation=direction===1?support:resistance;
  if(direction===1&&!(support<spot&&resistance>spot) || direction===-1&&!(resistance>spot&&support<spot)){
    out.reasons.push('MARKET_LEVELS_DO_NOT_BRACKET_SPOT');return out;
  }
  // Do not call stale LTP an executable entry. Require positive bid and ask.
  if(ask===null||bid===null||bid<=0||ask<bid||ask<=0){
    out.reasons.push('NO_EXECUTABLE_TWO_SIDED_QUOTE');return out;
  }
  if((ask-bid)/ask>0.025){out.reasons.push('SPREAD_TOO_WIDE_FOR_MODEL');return out;}
  if(delta===null||!(delta>0&&delta<=1)){out.reasons.push('OPTION_DELTA_UNAVAILABLE');return out;}
  const upside=Math.abs((direction===1?resistance:support)-spot);
  const downside=Math.abs(spot-out.thesisInvalidation);
  const targetPremium=money(ask+delta*upside);
  const stopPremium=money(Math.max(0.05,bid-delta*downside));
  const netRisk=ask-stopPremium,netReward=targetPremium-ask;
  if(!(netRisk>0&&netReward>0)){out.reasons.push('NO_POSITIVE_MODELED_RISK_REWARD');return out;}
  const rr=netReward/netRisk;
  out.entry={kind:'QUOTE_OBSERVATION',bid:money(bid),ask:money(ask),maxIndicativePremium:money(ask),
    condition:'Wait for an independently verified underlying chart trigger; entry not confirmed by this planner'};
  out.stop={premium:stopPremium,underlyingLevel:out.thesisInvalidation,method:'DELTA_APPROXIMATION',
    note:'Technical invalidation is primary. Premium stop is an unvalidated approximation.'};
  out.targets=[{premium:targetPremium,underlyingLevel:direction===1?resistance:support,
    method:'STRUCTURAL_LEVEL_DELTA_APPROXIMATION',estimatedRewardPoints:money(netReward)}];
  out.riskReward=money(rr);out.estimatedPremiumRisk=money(netRisk);
  out.status='MODEL_READY_SHADOW';
  out.reasons.push('ENTRY_TRIGGER_NOT_VERIFIED','TARGET_AND_STOP_ARE_HYPOTHESES');
  return out;
}
function buildTradePlans(analysis){
  return {version:VERSION,analysisAt:analysis?.timestamp||null,mode:'SHADOW',
    liveDecisionImpact:false,authorizationChanged:false,
    tiers:Object.fromEntries(['A','B','C'].map(t=>[t,makePlan(analysis,t)]))};
}
module.exports={VERSION,makePlan,buildTradePlans,legsOf};
