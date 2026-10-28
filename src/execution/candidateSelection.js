'use strict';
// Pure, sandbox-only choice of WHICH backend candidate the executor may trade.
// It never calls a broker, never mutates the decision, and never authorizes anything by itself:
// the executor still applies its own quote, spread, risk, capital and daily-loss gates afterwards.

const MODES=['AUTHORITATIVE_A_ONLY','OPENING_RANGE_SHADOW_V1','CLAUDE_DECIDES_V1'];
const DEFAULT_MODE='AUTHORITATIVE_A_ONLY';
const SHADOW_VERSION='OPENING_RANGE_SHADOW_V1';
const RISK_MODEL='ANCHOR_INVALIDATION_V1';
const TARGET_R=1.5; // reward:risk used for the shadow-mode target; a stated sandbox assumption, not a forecast
const SINGLE_LONG=['LONG_CALL','LONG_PUT'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);

// Original behaviour, unchanged: only the authoritative Tier A plan, with the backend's own stop and target.
function authoritative(result){
  const d=result?.decision,leg=d?.tradeLegs?.buyLeg;
  if(d?.orchestration?.status!=='READY_TO_EXECUTE'||d.orchestration.executionAllowed!==true||
    d.signalTier?.tier!=='A'||d.signalTier.researchOnly!==false||d.signalTier.executionAllowed!==true||
    d.risk?.status!=='READY'||d.position?.status!=='READY')return {reason:'BACKEND_NOT_READY'};
  if(!SINGLE_LONG.includes(d.strategy)||!leg?.instrumentKey||
    ['sellLeg','ceShort','ceLong','peShort','peLong'].some(k=>d.tradeLegs[k]))return {reason:'SINGLE_LONG_ONLY'};
  return {tier:'A',source:'AUTHORITATIVE_A',strategy:d.strategy,leg,ruleVersion:null,riskModel:null,anchor:null,
    exitPlan:({down})=>({stop:down(d.risk.stop?.value),target:down(d.risk.target1?.value)})};
}

// Opt-in: a candidate of ANY tier (A preferred, then B, then C) whose own frozen opening-range level has been
// crossed by a completed candle (OPENING_RANGE_SHADOW_V1 status CONFIRMED and shadowEntryReady). The stop is the
// same frozen level: if price closes back through it, the setup that justified the entry is gone.
function shadow(result){
  const d=result?.decision,plans=d?.researchCandidatePlans?.plans,timing=d?.shadowTiming,spot=Number(result?.spot);
  if(!plans||timing?.version!==SHADOW_VERSION)return {reason:'SHADOW_TIMING_UNAVAILABLE'};
  let reason='NO_CONFIRMED_SHADOW_CANDIDATE';
  for(const tier of ['A','B','C']){
    const plan=plans[tier],st=timing.plans?.[tier],leg=plan?.legs?.buyLeg;
    if(!plan?.available||!SINGLE_LONG.includes(plan.strategy)||plan.legs.sellLeg||!leg?.instrumentKey)continue;
    if(st?.status!=='CONFIRMED'||st.shadowEntryReady!==true||st.strategy!==plan.strategy)continue;
    if(!Array.isArray(st.contracts)||!st.contracts.includes(leg.instrumentKey))continue;
    const bullish=plan.strategy==='LONG_CALL',direction=String(d.regime?.direction||'');
    if(bullish?direction.includes('BEAR'):direction.includes('BULL')){reason='REGIME_OPPOSES_CANDIDATE';continue;}
    const level=bullish?st.anchor?.high:st.anchor?.low,delta=Math.abs(Number(plan.legs.legDelta??leg.delta));
    if(!finite(level)||!finite(spot)||!(delta>0&&delta<=1)){reason='ANCHOR_OR_DELTA_UNAVAILABLE';continue;}
    const distance=bullish?spot-level:level-spot; // underlying points beyond the frozen level
    if(!(distance>0)){reason='ANCHOR_LOST';continue;}
    return {tier,source:'SHADOW_OPENING_RANGE',strategy:plan.strategy,leg,ruleVersion:SHADOW_VERSION,riskModel:RISK_MODEL,
      anchor:{level,high:st.anchor.high,low:st.anchor.low,spot,distance,delta,episodeId:st.episodeId||null},
      exitPlan:({price,bid,ask,tick,down})=>{
        // Premium stop = entry minus the delta-estimated move back to the level, never tighter than twice the spread.
        const minimum=2*(ask-bid)+tick,stop=down(price-Math.max(delta*distance,minimum));
        return {stop,target:down(price+TARGET_R*(price-stop))};
      }};
  }
  return {reason};
}

// Opt-in: Claude's latest BUY decision (made at a 5-minute candle close) for one of EDGE's own single-leg cards.
// The stop is Claude's stated index invalidation level, converted with the card's delta exactly like the anchor model.
function claude(result){
  const d=result?.decision,c=result?.claudeDecision,spot=Number(result?.spot);
  if(!c)return {reason:'NO_MODEL_DECISION'};
  if(c.action==='SKIP')return {reason:'MODEL_SKIPPED'};
  if(c.action!=='BUY')return {reason:'NO_MODEL_BUY'};
  const age=Date.parse(result?.timestamp)-Date.parse(c.decidedAt);
  if(!(age>=-60000&&age<=90000))return {reason:'MODEL_DECISION_STALE'};
  const plan=d?.researchCandidatePlans?.plans?.[c.tier],leg=plan?.legs?.buyLeg;
  if(!plan?.available||!SINGLE_LONG.includes(plan.strategy)||plan.legs.sellLeg||!leg?.instrumentKey)return {reason:'MODEL_CANDIDATE_UNAVAILABLE'};
  if(c.instrumentKey&&c.instrumentKey!==leg.instrumentKey)return {reason:'MODEL_CANDIDATE_CHANGED'};
  const bullish=plan.strategy==='LONG_CALL',level=Number(c.stopUnderlying),delta=Math.abs(Number(plan.legs.legDelta??leg.delta));
  if(!finite(spot)||!(delta>0&&delta<=1))return {reason:'ANCHOR_OR_DELTA_UNAVAILABLE'};
  const distance=bullish?spot-level:level-spot;
  if(!finite(level)||!(distance>0)||distance>spot*0.01)return {reason:'MODEL_STOP_INVALID'};
  return {tier:c.tier,source:'CLAUDE_DECIDES',strategy:plan.strategy,leg,ruleVersion:'CLAUDE_DECIDES_V1',riskModel:'MODEL_INVALIDATION_V1',
    identity:c.bucket||c.decidedAt,
    anchor:{level,spot,distance,delta,model:c.model||null,confidence:c.confidence,reason:c.reason,decidedAt:c.decidedAt},
    exitPlan:({price,bid,ask,tick,down})=>{
      const minimum=2*(ask-bid)+tick,stop=down(price-Math.max(delta*distance,minimum));
      return {stop,target:down(price+TARGET_R*(price-stop))};
    }};
}

function selectCandidate(policy,result){
  const mode=policy?.entryMode||DEFAULT_MODE;
  return mode==='OPENING_RANGE_SHADOW_V1'?shadow(result):mode==='CLAUDE_DECIDES_V1'?claude(result):authoritative(result);
}

// Days-to-expiry bucket for results, counted in weekdays (NSE holidays are not modelled).
function expiryBucket(expiry,today){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(expiry||'')||!/^\d{4}-\d{2}-\d{2}$/.test(today||''))return 'UNKNOWN';
  if(expiry===today)return 'EXPIRY_DAY';
  if(expiry<today)return 'UNKNOWN';
  let days=0;
  for(let t=Date.parse(today+'T00:00:00Z')+86400000;t<=Date.parse(expiry+'T00:00:00Z');t+=86400000){const w=new Date(t).getUTCDay();if(w!==0&&w!==6)days++;}
  return days===1?'DAY_BEFORE_EXPIRY':'OTHER_DAYS';
}
module.exports={selectCandidate,expiryBucket,MODES,DEFAULT_MODE,SHADOW_VERSION,RISK_MODEL,TARGET_R};
