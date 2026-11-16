'use strict';
// Opt-in paper experiment. No claim of strategy profitability or live authorization.
const {proposalsFor}=require('../research/edgeBrain');
const {VERSION,FAMILIES}=require('../research/impulseReaper');
const MODE='AUTOPILOT_PAPER_V1', MAX_AGE=15000, MAX_ASK_DRIFT=1;
const num=x=>typeof x==='number'&&Number.isFinite(x);
const stamp=x=>typeof x==='string'?Date.parse(x):NaN;
const day=x=>new Date(x+19800000).toISOString().slice(0,10);
const deny=reason=>({reason});
function selectAutopilot(result,now){
 const batch=result?.autopilotBatch;
 if(!num(now)||!batch||batch.configured!==true||!Array.isArray(batch.events))return deny('AUTOPILOT_DISABLED_OR_UNAVAILABLE');
 const at=stamp(result.timestamp),published=stamp(batch.publishedAt);
 if(!num(at)||!num(published)||at>now||published>now||now-at>MAX_AGE||now-published>MAX_AGE||result.market?.phase!=='OPEN')return deny('AUTOPILOT_STALE');
 const base=result.decision?.ruleSpec?.implementationHash;
 if(typeof base!=='string'||!base||base==='UNKNOWN')return deny('AUTOPILOT_RULE_UNKNOWN');
 const events=batch.events.filter(e=>e?.strategyVersion===VERSION&&FAMILIES.includes(e.family)&&
  e.sourceRuleVersion===base+'|'+VERSION&&e.session===day(now)&&
  typeof e.eventId==='string'&&/^[a-f0-9]{64}$/.test(e.eventId)&&
  ['UP','DOWN'].includes(e.direction)&&e.confirmation==='TWO_MATCHING_CAUSAL_WINDOWS_60S_APART'&&
  num(stamp(e.confirmedAt))&&stamp(e.confirmedAt)<=published&&now-stamp(e.confirmedAt)<=MAX_AGE&&
  num(stamp(e.candleClosedAt))&&stamp(e.candleClosedAt)<=stamp(e.confirmedAt)&&
  stamp(e.confirmedAt)-stamp(e.candleClosedAt)<=240000&&
  num(stamp(e.firstSeenAt))&&stamp(e.firstSeenAt)>=stamp(e.candleClosedAt)+30000&&stamp(e.confirmedAt)-stamp(e.firstSeenAt)>=60000&&
  num(e.level)&&num(e.evidence?.medianRange)&&e.evidence.medianRange>0);
 if(!events.length)return deny('AUTOPILOT_NO_CONFIRMED_EVENT');
 if(new Set(events.map(e=>e.eventId)).size!==events.length)return deny('AUTOPILOT_DUPLICATE_EVENT');
 if(new Set(events.map(e=>e.direction)).size>1)return deny('AUTOPILOT_DIRECTION_CONFLICT');
 const spot=result.spot;
 if(!num(spot))return deny('AUTOPILOT_SPOT_UNAVAILABLE');
 const ranked=[];
 for(const e of events){
  const distance=e.direction==='UP'?spot-e.level:e.level-spot;
  if(!(distance>0&&distance<=2*e.evidence.medianRange))continue;
  const p=proposalsFor(e),q=p.quote;
  if(!q||q.expiry!==result.expiry)continue;
  const plan=result.decision?.researchCandidatePlans?.plans?.[q.tier],leg=plan?.legs?.buyLeg;
  if(!plan?.available||plan.strategy!==q.strategy||plan.legs.sellLeg||leg?.instrumentKey!==q.instrumentKey||
   leg.contractId!==q.contractId||leg.type!==q.type||leg.strike!==q.strike||Number(plan.legs.lotSize)!==q.lotSize)continue;
  ranked.push({e,q,leg,distance});
 }
 if(!ranked.length)return deny('AUTOPILOT_NO_MATCHING_FRESH_CARD');
 ranked.sort((a,b)=>a.q.spread-b.q.spread||a.q.outlay-b.q.outlay||a.e.eventId.localeCompare(b.e.eventId));
 const {e,q,leg,distance}=ranked[0];
 return {tier:q.tier,source:'AUTOPILOT_PAPER',strategy:q.strategy,leg,ruleVersion:MODE+'|'+e.sourceRuleVersion,
  riskModel:'FIXED_8_8_30M_PAPER_BASELINE',identity:e.eventId,breakoutId:e.eventId,entryDeadline:stamp(e.confirmedAt)+MAX_AGE,
  expectedLotSize:q.lotSize,maxAsk:q.ask+MAX_ASK_DRIFT,
  anchor:{level:e.level,spot,distance,eventId:e.eventId,family:e.family,confirmedAt:e.confirmedAt,recordedAsk:q.ask},
  exitPlan:({price,down})=>({stop:down(price-8),target:down(price+8)})};
}
module.exports={MODE,selectAutopilot};
