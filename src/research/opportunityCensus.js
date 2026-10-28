'use strict';
const {buildEntryPlan}=require('../engine/entryEngine');
const {buildRiskPlan}=require('../engine/riskEngine');
const {buildPositionPlan}=require('../engine/positionSizingEngine');
const {qualifySetup}=require('../engine/setupEngine');
const {candidateLegs}=require('../trading/tradeSnapshots');
const clone=x=>JSON.parse(JSON.stringify(x));
function buildObservation(analysis,{lotSize,budget,observedAt=Date.now()}={}){
 const d=analysis?.decision;if(!d||analysis.market?.phase!=='OPEN')return null;
 const candidates=[];
 for(const tier of ['A','B','C']){
  const plan=d.researchCandidatePlans?.plans?.[tier];if(!plan?.available||!candidateLegs(plan).length)continue;
  const legs={...clone(plan.legs),lotSize:plan.legs?.lotSize||lotSize};
  if(plan.executableNetDebit!=null)legs.netDebit=plan.executableNetDebit;
  const directional=['LONG_CALL','LONG_PUT'].includes(plan.strategy);
  if(tier!=='A'&&directional&&legs.legDelta==null)legs.legDelta=legs.buyLeg?.delta;
  const deltaAvailable=typeof legs.legDelta==='number'&&Number.isFinite(legs.legDelta)&&Math.abs(legs.legDelta)>0&&Math.abs(legs.legDelta)<=1;
  const input={strategy:plan.strategy,tradeLegs:legs,spot:analysis.spot,support:analysis.support?.strike,resistance:analysis.resistance?.strike,
   ceWall:analysis.structure?.ceWall,peWall:analysis.structure?.peWall,expectedMove:analysis.expectedMove,regime:d.regime,
   features:analysis.market.features,marketPhase:analysis.market.phase,dte:analysis.dte};
  const setup=qualifySetup(input),entry=tier==='A'?d.entry:buildEntryPlan(input),risk=tier==='A'?d.risk:directional&&!deltaAvailable?{status:'UNAVAILABLE',reason:'Recorded option delta is unavailable.'}:buildRiskPlan(input);
  const position=tier==='A'?d.position:buildPositionPlan({...input,risk,budget});
  const gates={market:true,regime:!!d.regime?.direction&&(plan.strategy==='IRON_CONDOR'||d.regime.direction!=='NEUTRAL'),strategy:plan.strategy!=='WAIT',
   setup:setup.qualified,trigger:entry?.triggerReady===true,price:entry?.priceReady===true,liquidity:entry?.liquidityReady===true,
   risk:risk?.status==='READY',position:position?.status==='READY'};
  candidates.push({tier,strategy:plan.strategy,expiry:analysis.expiry,legs,lotSize:legs.lotSize,gateScope:'CANDIDATE_REPLAY_OF_CURRENT_RULES',gates,
   blockers:[...setup.blockers,...Object.entries(gates).filter(([,v])=>!v).map(([k])=>k.toUpperCase())],
   positionReason:position?.reason||null,riskReason:risk?.reason||null,executionAllowed:tier==='A'&&d.orchestration?.executionAllowed===true});
 }
 return {id:analysis.timestamp+'|OPPORTUNITY',recordType:'OPPORTUNITY_OBSERVATION',timestamp:analysis.timestamp,observedAt:new Date(observedAt).toISOString(),
  version:'OPPORTUNITY_CENSUS_V1',marketPhase:analysis.market.phase,expiry:analysis.expiry,signalTier:clone(d.signalTier||{}),
  ruleSpec:{version:d.ruleSpec?.version||null,implementationHash:d.ruleSpec?.implementationHash||null},candidates,
  liveDecisionImpact:false,authorizationChanged:false};
}
module.exports={buildObservation};
