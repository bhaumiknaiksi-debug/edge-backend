'use strict';
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const digest=x=>createHash('sha256').update(x).digest('hex');
// Source fingerprints identify the actual implemented rules, not proposed PDF rules.
// Read once at startup. Historical records without this stamp remain unversioned.
const groups={
  selection:['engine/marketFeatureEngine.js','engine/regimeEngine.js','engine/strategyEngine.js','engine/candidatePlanEngine.js','server.js'],
  readiness:['engine/setupEngine.js','engine/signalTier.js','engine/shadowTiming.js','engine/decisionOrchestrator.js'],
  chart:['engine/chartIntelligence.js','engine/cprEngine.js','engine/setupObservability.js','data/marketContext.js'],
  entry:['engine/entryEngine.js'],
  eligibility:['engine/riskEngine.js','engine/positionSizingEngine.js','trading/ledger.js'],
  shadowTiming:['engine/shadowTiming.js'],
  shadowEvents:['evidence/shadowEvents.js'],
  exitHypotheses:['trading/readOnlyTradePlanner.js','engine/managementEngine.js','engine/riskEngine.js']
};
const components=Object.fromEntries(Object.entries(groups).map(([name,files])=>[name,{
  files:Object.fromEntries(files.map(file=>[file,digest(readFileSync(path.join(__dirname,'..',file)))]))
}]));
const spec={version:'SIGNAL_RULE_SPEC_V1',implementationHash:digest(JSON.stringify(components)),components,
  paperExitSimulator:'NOT_IMPLEMENTED',confidenceCalibration:'NOT_VALIDATED'};
function buildRuleSpec(){return JSON.parse(JSON.stringify(spec));}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function gateState(value){
  if(!value)return null;
  const copy=JSON.parse(JSON.stringify(value));
  for(const key of ['missing','failedGates','blockers'])if(Array.isArray(copy[key]))copy[key].sort();
  return copy;
}
function identities(legs){
  if(!legs)return null;
  return Object.fromEntries(['buyLeg','sellLeg','ceShort','ceLong','peShort','peLong'].filter(k=>legs[k]).map(k=>[k,{
    instrumentKey:legs[k].instrumentKey??null,contractId:legs[k].contractId??null,strike:legs[k].strike??null,type:legs[k].type??null
  }]));
}
function signalFingerprint(snapshot){
  const tier=snapshot.signalTier;
  return digest(JSON.stringify(canonical({
    version:'SIGNAL_TRANSITIONS_V2',ruleSpec:snapshot.ruleSpec??null,
    strategy:snapshot.strategy,orchestrationStatus:snapshot.orchestrationStatus,entryStatus:snapshot.entryStatus,
    entry:{trigger:snapshot.entry?.triggerReady,price:snapshot.entry?.priceReady,liquidity:snapshot.entry?.liquidityReady},
    signalTier:tier&&{version:tier.version,tier:tier.tier,label:tier.label,chartAgreement:tier.chartAgreement,
      gates:tier.gates,failedGates:gateState(tier).failedGates,executionAllowed:tier.executionAllowed,entryPassCount:tier.entryPassCount},
    chartVerdict:snapshot.chartIntelligence?.verdict??null,
    readiness:snapshot.readinessView&&{version:snapshot.readinessView.version,
      market:gateState(snapshot.readinessView.market),eligibility:gateState(snapshot.readinessView.eligibility)},
    shadowTiming:snapshot.shadowTiming??null,
    contracts:identities(snapshot.tradeLegs),
    candidates:Object.fromEntries(Object.entries(snapshot.researchCandidatePlans?.plans||{}).map(([key,p])=>[key,{
      available:p.available,strategy:p.strategy,executionAllowed:p.executionAllowed,contracts:identities(p.legs)
    }]))
  })));
}
module.exports={buildRuleSpec,signalFingerprint};
