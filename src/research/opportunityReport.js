'use strict';
// Reporting only. Never imports a selector, authorizes execution, or mutates the ledger.
const {createHash}=require('node:crypto');
const {contractFromKite,candidateLegs}=require('../trading/tradeSnapshots');
const {summarizeBroker}=require('../trading/kiteTradebook');
const {buildQuickExitReport,PRIMARY:QUICK_PRIMARY}=require('./quickExit');
const VERSION='OPPORTUNITY_REPORT_V1', GAP_MS=90000, HORIZON=60;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ms=x=>typeof x==='string'?Date.parse(x):NaN;
const day=x=>Number.isFinite(x)?new Date(x+19800000).toISOString().slice(0,10):null;
const round=x=>Number.isFinite(x)?Math.round(x*100)/100:null;
const number=x=>typeof x==='number'&&Number.isFinite(x);
const rule=x=>x?.implementationHash||'UNVERSIONED';
const names=['market','regime','strategy','setup','trigger','price','liquidity','risk','position'];
function gatesOf(row){
 const g=row?.signalTier?.gates||{},o=row?.orchestration?.gates||{},e=row?.entry||{};
 return Object.fromEntries(names.map(k=>[k,typeof g[k]==='boolean'?g[k]:['trigger','price','liquidity'].includes(k)&&typeof e[k+'Ready']==='boolean'?e[k+'Ready']:typeof o[k]==='boolean'?o[k]:null]));
}
function identity(plan,expiry){return hash([expiry,plan?.strategy,candidateLegs(plan).map(l=>[l.name,l.side,l.instrumentKey,l.strike,l.type])]);}
function normalizeObservations(records=[],snapshots=[]){
 const polls=new Map();
 for(const r of records){
  if(!['POLL_SNAPSHOT','OPPORTUNITY_OBSERVATION'].includes(r.recordType)||!Number.isFinite(ms(r.timestamp)))continue;
  const modern=r.recordType==='OPPORTUNITY_OBSERVATION';
  const candidates=modern?r.candidates||[]:Object.entries(r.researchCandidatePlans?.plans||{}).filter(([,p])=>p?.available===true).map(([tier,p])=>({
   tier,strategy:p.strategy,legs:p.legs,expiry:r.expiry,lotSize:p.legs?.lotSize||r.tradeLegs?.lotSize||null,
   gateScope:tier==='A'?'AUTHORITATIVE_PLAN':'UNAVAILABLE_FOR_CANDIDATE',gates:tier==='A'?gatesOf(r):null,
   blockers:tier==='A'?r.orchestration?.blockers||[]:[],executionAllowed:tier==='A'&&r.orchestrationStatus==='READY_TO_EXECUTE'
  }));
  const obs={id:r.id,at:r.timestamp,knownAt:r.observedAt||r.timestamp,source:modern?'CENSUS':'POLL',ruleVersion:rule(r.ruleSpec),
   signalTier:r.signalTier?.tier||r.signalTier||'UNKNOWN',candidates:candidates.filter(c=>['A','B','C'].includes(c.tier)).map(c=>({...c,legs:c.legs||{},expiry:c.expiry||r.expiry,key:identity({strategy:c.strategy,legs:c.legs},c.expiry||r.expiry)})),
   candidateCoverageKnown:modern?Array.isArray(r.candidates):!!r.researchCandidatePlans?.plans,
   authoritativeGates:gatesOf(r),marketPhase:r.marketPhase||(gatesOf(r).market===true?'OPEN':gatesOf(r).market===false?'NOT_OPEN':'UNKNOWN')};
  const existing=polls.get(r.timestamp);if(!existing||modern)polls.set(r.timestamp,obs);
 }
 const observations=[...polls.values()];
 for(const s of snapshots){const p=s.payload||s;if(!Number.isFinite(ms(p.analysisAt)))continue;
  observations.push({id:s.id||hash(p),at:p.analysisAt,knownAt:p.capturedAt,source:'SAVED_SNAPSHOT',ruleVersion:rule(p.ruleSpec),signalTier:p.actualSignalTier||'UNKNOWN',
   candidates:[{tier:p.tier,strategy:p.strategy,legs:p.selectedCandidate?.legs||{},expiry:p.expiry,lotSize:p.selectedCandidate?.legs?.lotSize||null,
    gateScope:'UNAVAILABLE_FOR_CANDIDATE',gates:null,blockers:[],executionAllowed:p.authorization?.executionAllowed===true,key:identity(p.selectedCandidate,p.expiry)}],authoritativeContext:p.authorization||null});
 }
 return observations.map(o=>({...o,atMs:ms(o.at),knownAtMs:ms(o.knownAt),session:day(ms(o.at))})).sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
}
function rejection(candidate){
 const failed=names.filter(k=>candidate.gates?.[k]===false).map(k=>k.toUpperCase());
 if(candidate.tier!=='A')failed.unshift('RESEARCH_ONLY');
 return [...new Set(failed)];
}
function matchContract(candidate,contract){return candidate.expiry===contract.expiry&&candidateLegs(candidate).some(l=>l.strike===contract.strike&&l.type===contract.type);}
function matchCoverage({at,symbol,contract,observations}){
 const t=ms(at),date=day(t);contract ||=contractFromKite(symbol);
 if(!Number.isFinite(t)||!contract||contract.exact!==true)return {status:'UNRESOLVED_CONTRACT_OR_TIME',primaryMiss:'CONTRACT_IDENTITY_UNRESOLVED',history:[]};
 const priority={SAVED_SNAPSHOT:0,POLL:1,CENSUS:2},byTime=new Map();
 for(const o of observations.filter(o=>o.session===date&&o.atMs<=t&&Number.isFinite(o.knownAtMs)&&o.knownAtMs<=t)){
  const previous=byTime.get(o.at);
  if(!previous||priority[o.source]>priority[previous.source])byTime.set(o.at,o);
  else if(o.source==='SAVED_SNAPSHOT'&&previous.source==='SAVED_SNAPSHOT'){
   const observationIds=[...(previous.observationIds||[previous.id]),o.id];
   const candidates=[...new Map([...previous.candidates,...o.candidates].map(c=>[[c.tier,c.key,c.executionAllowed].join('|'),c])).values()];
   byTime.set(o.at,{...previous,id:hash(observationIds),observationIds,candidates});
  }
 }
 // A saved selected card supplements a complete same-time poll; it cannot replace its authorization.
 const before=[...byTime.values()].sort((a,b)=>a.atMs-b.atMs);
 const history=[];let previous=null;
 for(const o of before){const candidates=o.candidates.filter(c=>matchContract(c,contract));if(!candidates.length)continue;
  const value={at:o.at,source:o.source,observationId:o.id,observationIds:o.observationIds||[o.id],signalTier:o.signalTier,ruleVersion:o.ruleVersion,candidates:candidates.map(c=>({tier:c.tier,strategy:c.strategy,matchKind:candidateLegs(c).length===1?'SINGLE_LEG_STRUCTURE':'CONTRACT_LEG_ONLY',gateScope:c.gateScope,rejectedBy:rejection(c),blockers:c.blockers||[],executionAllowed:c.executionAllowed===true}))};
  const fingerprint=hash({...value,at:null,observationId:null,observationIds:null,source:null});if(fingerprint!==previous)history.push(value);previous=fingerprint;
 }
 const recent=before.filter(o=>t-o.atMs<=GAP_MS);
 const latest=recent.at(-1);
 const matching=latest?.candidates.some(c=>matchContract(c,contract))?latest:null;
 if(matching){const candidates=matching.candidates.filter(c=>matchContract(c,contract)),direct=candidates.filter(c=>candidateLegs(c).length===1),ready=direct.some(c=>c.tier==='A'&&c.executionAllowed===true);
  const rejectedBy=[...new Set(direct.flatMap(rejection))];
  return {status:ready?'FLAGGED_AND_READY':rejectedBy.length?'FLAGGED_BUT_REJECTED':'FLAGGED_GATE_DETAIL_UNKNOWN',
   primaryMiss:ready?null:!direct.length?'STRUCTURE_ATTRIBUTION_UNRESOLVED':rejectedBy[0]||'GATE_DETAIL_UNAVAILABLE',rejectedBy:ready?[]:rejectedBy,observedAt:matching.at,ageSeconds:round((t-matching.atMs)/1000),
   candidateTiers:[...new Set(candidates.map(c=>c.tier))],signalTier:matching.signalTier,ruleVersion:matching.ruleVersion,
   directCandidateTiers:direct.map(c=>c.tier),relatedPlanGates:candidates.filter(c=>candidateLegs(c).length!==1).map(c=>({tier:c.tier,strategy:c.strategy,rejectedBy:rejection(c),scope:'CONTRACT_LEG_ONLY_NOT_THIS_SINGLE_LEG_TRADE'})),
   gateScope:candidates.map(c=>({tier:c.tier,scope:c.gateScope})),authoritativeGateContext:matching.authoritativeGates||matching.authoritativeContext||null,history};
 }
 const postSnapshot=observations.some(o=>o.source==='SAVED_SNAPSHOT'&&o.atMs<=t&&o.knownAtMs>t&&o.candidates.some(c=>matchContract(c,contract)));
 const knownAbsence=latest?.source!=='SAVED_SNAPSHOT'&&latest?.candidateCoverageKnown===true,missingMetadata=!!latest&&!knownAbsence;
 return {status:knownAbsence?'NOT_FLAGGED_AT_OBSERVED_POLL':missingMetadata?'UNKNOWN_CANDIDATE_RECORD':postSnapshot?'POST_TRADE_SNAPSHOT_ONLY':'UNKNOWN_RECORDING_GAP',
  primaryMiss:knownAbsence?'CONTRACT_NOT_FLAGGED':missingMetadata?'CANDIDATE_RECORD_UNAVAILABLE':postSnapshot?'CAPTURED_AFTER_TRADE':'RECORDING_GAP',observedAt:latest?.at||null,history};
}
function candidateEpisodes(observations,{axis='CANDIDATE_CARD'}={}){
 const episodes=[],active=new Map();let previous=null;
 for(const o of observations.filter(o=>o.source!=='SAVED_SNAPSHOT')){
  const current=new Set();
  for(const c of o.candidates){
   if(axis==='READINESS_TIER'&&(c.tier!=='A'||!['A','B','C'].includes(o.signalTier)))continue;
   const tier=axis==='READINESS_TIER'?o.signalTier:c.tier;
   const key=[axis,day(ms(o.at)),o.ruleVersion,tier,c.key,o.marketPhase].join('|');current.add(key);
   let ep=active.get(key);
   if(!ep||!previous||ms(o.at)-ms(previous.at)>GAP_MS){
    ep={id:hash([VERSION,key,o.at]),axis,cardTier:c.tier,firstObservationId:o.id,at:o.at,lastAt:o.at,ruleVersion:o.ruleVersion,tier,signalTier:o.signalTier,marketPhase:o.marketPhase,
     candidate:c,observations:0,startsAfterGap:!!previous&&ms(o.at)-ms(previous.at)>GAP_MS};episodes.push(ep);active.set(key,ep);
   }
   ep.lastAt=o.at;ep.observations++;
  }
  for(const key of active.keys())if(!current.has(key))active.delete(key);
  previous=o;
 }
 return episodes;
}
function indexOutcomes(records,now=Date.now()){
 const byEpisode=new Map(),bySnapshot=new Map();
 const append=(map,key,row)=>{if(!key)return;const list=map.get(key)||[];list.push(row);map.set(key,list);};
 function add(r,through=now){
  if(!['OUTCOME','RESEARCH_CANDIDATE_OUTCOME','OPPORTUNITY_OUTCOME'].includes(r.recordType)||!(ms(r.timestamp)<=through))return;
  append(byEpisode,r.episodeId,r);
  const tier=r.recordType==='OUTCOME'?'A':r.recordType==='RESEARCH_CANDIDATE_OUTCOME'?r.tier:r.cardTier;
  if(r.snapshotId&&tier)append(bySnapshot,r.snapshotId+'|'+tier,r);
 }
 for(const row of records)add(row);
 return {byEpisode,bySnapshot,add};
}
function outcomeFor(ep,records,now=Date.now()){
 if(ep.marketPhase==='NOT_OPEN'||ep.marketPhase==='CLOSED'||ep.marketPhase==='PRE_OPEN')return {status:'UNMEASURED',reason:'MARKET_NOT_OPEN'};
 if(ms(ep.at)+HORIZON*60000>now)return {status:'UNMEASURED',reason:'PENDING_HORIZON'};
 const index=Array.isArray(records)?indexOutcomes(records,now):records;
 const linked=[...new Set([...(index.byEpisode.get(ep.id)||[]),...(index.bySnapshot.get(ep.firstObservationId+'|'+ep.cardTier)||[])])];
 const measured=linked.filter(r=>r.outcome?.status==='MEASURED').sort((a,b)=>ms(a.timestamp)-ms(b.timestamp));
 if(!measured.length)return {status:'UNMEASURED',reason:linked.at(-1)?.outcome?.reason||'OUTCOME_NOT_RECORDED'};
 let unavailable;
 for(const record of measured){const result=validateOutcome(ep,record);if(result.status==='MEASURED')return result;unavailable ||=result;}
 return unavailable;
}
function validateOutcome(ep,measured){
 const out=measured.outcome,mark=out.horizonLegMarks?.[HORIZON],target=ms(ep.at)+HORIZON*60000;
 if(!mark||!Number.isFinite(ms(mark.timestamp))||ms(mark.timestamp)<target||ms(mark.timestamp)>target+120000)return {status:'UNMEASURED',reason:'EXACT_HORIZON_MARK_UNAVAILABLE'};
 const legs=candidateLegs(ep.candidate),entries=out.entryLegMarks||{};let grossPoints=0;
 for(const leg of legs){const entry=entries[leg.name],exit=mark.marks?.[leg.name];
  if(entry?.contractId!==leg.contractId||entry.side!==leg.side||!number(entry.price)||entry.price<=0||!number(exit)||exit<0)return {status:'UNMEASURED',reason:'LEG_MARK_IDENTITY_OR_PRICE_UNAVAILABLE'};
  // Historical LTP-based entries are not treated as executable ask/bid observations.
  const quoted=ep.candidate.legs[leg.name]?.[leg.side==='BUY'?'ask':'bid'];
  if(!number(quoted)||quoted<=0||Math.abs(entry.price-quoted)>.011)return {status:'UNMEASURED',reason:'EXECUTABLE_ENTRY_QUOTE_UNAVAILABLE'};
  grossPoints+=(leg.side==='BUY'?1:-1)*(exit-entry.price);
 }
 if(!legs.length)return {status:'UNMEASURED',reason:'CONTRACT_LEGS_UNAVAILABLE'};
 const lot=ep.candidate.lotSize,quantity=Number.isSafeInteger(lot)&&lot>0?lot:null;
 const gross=quantity===null?null:round(grossPoints*quantity),reserve=100*legs.length;
 return {status:'MEASURED',sourceId:measured.id,grossPoints:round(grossPoints),quantity,grossRupees:gross,
  estimatedNetRupees:gross===null?null:round(gross-reserve),costReserveRupees:reserve,exitAt:mark.timestamp,
  basis:'FIXED_60M_CANDLE_MARK_MINUS_RS100_PER_LEG_ONE_LOT',actualTradePnl:false};
}
function stats(rows){
 const measured=rows.filter(r=>r.result.status==='MEASURED'),net=measured.map(r=>r.result.estimatedNetRupees).filter(number),reasons={};
 for(const r of rows)if(r.result.status!=='MEASURED')reasons[r.result.reason]=(reasons[r.result.reason]||0)+1;
 return {flagged:rows.length,measured:measured.length,unmeasured:rows.length-measured.length,monetaryMeasured:net.length,
  outsideMarket:rows.filter(r=>['NOT_OPEN','CLOSED','PRE_OPEN'].includes(r.marketPhase)).length,
  wins:net.filter(x=>x>0).length,losses:net.filter(x=>x<0).length,flat:net.filter(x=>x===0).length,
  estimatedMeanNetRupees:net.length?round(net.reduce((a,b)=>a+b,0)/net.length):null,
  estimatedTotalNetRupees:net.length?round(net.reduce((a,b)=>a+b,0)):null,
  expectancyStatus:!rows.length?'NO_SAMPLES':net.length<rows.length?'MEASURED_SUBSET_ONLY':'ALL_RECORDED_EPISODES_MODELED',promotionEligible:false,
  meanGrossPoints:measured.length?round(measured.reduce((a,r)=>a+r.result.grossPoints,0)/measured.length):null,
  observedDays:new Set(rows.map(r=>day(ms(r.at)))).size,missingReasons:reasons};
}
function buildOpportunityReport({records=[],ledger={},snapshots=[],now=Date.now(),source={}}={}){
 const observations=normalizeObservations(records,snapshots).filter(o=>o.atMs<=now),episodes=candidateEpisodes(observations),byDay=new Map(),fillsByContract=new Map();
 for(const o of observations){const list=byDay.get(o.session)||[];list.push(o);byDay.set(o.session,list);}
 const fillRows=(ledger.brokerFills||[]).map((f,index)=>({fill:f,index,contract:contractFromKite(f.symbol),timeMs:ms(f.time+'+05:30')}));
 for(const row of fillRows)if(row.contract?.exact){const c=row.contract,key=[c.expiry,c.strike,c.type].join('|'),list=fillsByContract.get(key)||[];list.push(row);fillsByContract.set(key,list);}
 const fills=fillRows.map(({fill:f,contract,timeMs})=>({key:f.key,orderId:f.orderId,symbol:f.symbol,side:f.side,quantity:f.quantity,price:f.price,time:f.time,
  coverage:matchCoverage({symbol:f.symbol,contract,at:f.time+'+05:30',observations:byDay.get(day(timeMs))||[]})}));
 const snapshotRows=snapshots.map(s=>{const p=s.payload||s;return {id:s.id,at:p.analysisAt,capturedAt:p.capturedAt,tier:p.tier,
  actualSignalTier:p.actualSignalTier||'UNKNOWN',ruleVersion:rule(p.ruleSpec),strategy:p.strategy,expiry:p.expiry,
  selectedLegs:p.selectedLegs||candidateLegs(p.selectedCandidate),authorization:p.authorization||null,
  importedFillKeys:[...new Map(candidateLegs(p.selectedCandidate).flatMap(l=>fillsByContract.get([p.expiry,l.strike,l.type].join('|'))||[]).filter(r=>Math.abs(r.timeMs-ms(p.capturedAt))<=20*60000).map(r=>[r.fill.key,r])).values()].sort((a,b)=>a.index-b.index).map(r=>r.fill.key),
  pnlAttribution:'NOT_INFERRED_FROM_A_CLICK'};});
 const outcomeIndex=indexOutcomes(records,now),quickByEpisode=new Map();
 for(const r of records)if(r.recordType==='OPPORTUNITY_QUICK_EXIT'&&r.episodeId&&ms(r.timestamp)<=now){const list=quickByEpisode.get(r.episodeId)||[];list.push(r);quickByEpisode.set(r.episodeId,list);}
 const quickFor=ep=>{const list=(quickByEpisode.get(ep.id)||[]).sort((a,b)=>ms(a.timestamp)-ms(b.timestamp));
  const hit=list.filter(r=>r.outcome?.status==='MEASURED').at(-1);return hit?hit.outcome:{status:'UNMEASURED',reason:list.at(-1)?.outcome?.reason||'NOT_YET_MEASURED'};};
 const results=episodes.map(e=>({...e,result:outcomeFor(e,outcomeIndex,now)})),readinessResults=candidateEpisodes(observations,{axis:'READINESS_TIER'}).map(e=>({...e,result:outcomeFor(e,outcomeIndex,now)})),groups={};
 for(const e of [...results,...readinessResults]){const key=e.axis+'|'+e.ruleVersion+'|'+e.tier;(groups[key]||={axis:e.axis,ruleVersion:e.ruleVersion,tier:e.tier,rows:[]}).rows.push(e);}
 const missCounts={};for(const f of fills.filter(f=>f.side==='BUY'))for(const gate of new Set(f.coverage.rejectedBy?.length?f.coverage.rejectedBy:f.coverage.primaryMiss?[f.coverage.primaryMiss]:[])){
  const group=missCounts[gate]||={fills:0,orders:new Set(),versions:new Set(),fillKeys:[]};group.fills++;group.orders.add([f.time?.slice(0,10),f.symbol,f.orderId||f.key].join('|'));group.versions.add(f.coverage.ruleVersion||'UNKNOWN');group.fillKeys.push(f.key);
 }
 const gateChanges=Object.entries(missCounts).map(([gate,g])=>({gate,missedEntryFills:g.fills,missedEntryOrders:g.orders.size,sourceRuleVersions:[...g.versions],fillKeys:g.fillKeys,
  blockingConditions:[...([...g.versions].some(v=>['UNKNOWN','UNVERSIONED'].includes(v))?['HISTORICAL_RULE_VERSION_REQUIRED']:[]),'COMPLETE_CANDIDATE_EXPECTANCY_REQUIRED','GATE_SPECIFIC_REPLAY_REQUIRED'],
  status:['RECORDING_GAP','CAPTURED_AFTER_TRADE','CONTRACT_IDENTITY_UNRESOLVED','STRUCTURE_ATTRIBUTION_UNRESOLVED','CANDIDATE_RECORD_UNAVAILABLE'].includes(gate)?'REPAIR_COVERAGE_FIRST':'EVIDENCE_REVIEW_REQUIRED',
  gateChangeAuthorized:false,ruleVersion:null})).sort((a,b)=>b.missedEntryOrders-a.missedEntryOrders||b.missedEntryFills-a.missedEntryFills||a.gate.localeCompare(b.gate));
 return {version:VERSION,generatedAt:new Date(now).toISOString(),liveDecisionImpact:false,gateChangesApplied:[],liveTradingInScope:false,
  source:{...source,firstObservationAt:observations[0]?.at||null,lastObservationAt:observations.at(-1)?.at||null,observations:observations.length},
  methodology:{measurementRuleVersion:'OPPORTUNITY_FIXED_60M_V1',gateChangePolicyVersion:'COVERAGE_AND_EXPECTANCY_REQUIRED_V1',coverageLookbackSeconds:GAP_MS/1000,matching:'EXACT_EXPIRY_STRIKE_TYPE; NO_FUTURE_OBSERVATIONS',
   tierAxes:'Candidate A/B/C cards are different structures; actualSignalTier is the authoritative readiness tier. They are not interchangeable.',
   episodes:'First flag of a contract/strategy/tier/rule-version/session; restart after disappearance or observation gap >90s. Repeated polls do not add samples.',
   expectancy:'All flagged episodes remain in the denominator, including losses and unavailable results. Fixed 60-minute candle marks are not fills or stop/target returns. Rs100/leg is a cost scenario, not measured charges.',
   promotion:'Descriptive results only. No automatic gate loosening, statistical confidence claim, or promotion. Gate-specific replay and validation are required.',
   limits:['No data is not proof of a rejection.','Only saved observations can establish historical tiers.','Imported long-trade gross P&L is separate from candidate model returns.','Overlapping candidates and tiers are correlated; do not sum them as independent opportunities.','Gate priority counts unique buy orders; sell-entry and multi-leg grouping require separate attribution.']},
  totals:{importedFills:fills.length,savedSnapshots:snapshotRows.length,candidateEpisodes:results.length,coverage:fills.reduce((a,f)=>(a[f.coverage.status]=(a[f.coverage.status]||0)+1,a),{})},
  fills,snapshots:snapshotRows,broker:summarizeBroker(ledger,{limit:5000}),
  byCandidateTier:['A','B','C'].map(tier=>({tier,...stats(results.filter(e=>e.tier===tier))})),
  bySignalTier:['A','B','C'].map(tier=>({tier,...stats(readinessResults.filter(e=>e.tier===tier)),scope:'AUTHORITATIVE_STRUCTURE_ON_EACH_READINESS_TIER_EPISODE'})),
  byRuleVersion:Object.values(groups).map(g=>({axis:g.axis,ruleVersion:g.ruleVersion,tier:g.tier,...stats(g.rows)})),
  readinessEpisodes:readinessResults.map(({candidate,...e})=>({...e,strategy:candidate.strategy,legs:candidateLegs(candidate)})),
  candidateEpisodes:results.map(({candidate,...e})=>{const q=quickFor(e),p=q.results?.[QUICK_PRIMARY];return {...e,strategy:candidate.strategy,expiry:candidate.expiry,legs:candidateLegs(candidate),rejectedBy:rejection(candidate),gateScope:candidate.gateScope,
   quickExit:p?{rule:QUICK_PRIMARY,exit:p.exit,minutes:p.minutes,estimatedNetRupees:p.estimatedNetRupees}:{status:q.status,reason:q.reason||p?.reason||null}};}),
  quickExit:buildQuickExitReport(results.filter(e=>e.marketPhase==='OPEN'&&['LONG_CALL','LONG_PUT'].includes(e.candidate.strategy)&&!e.candidate.legs?.sellLeg).map(e=>{const q=quickFor(e);
   return {tier:e.tier,strategy:e.candidate.strategy,expiry:e.candidate.expiry,session:day(ms(e.at)),at:e.at,status:q.status,reason:q.reason,results:q.results};})),
  gateChangeQueue:gateChanges,reportFingerprint:hash([VERSION,records.map(r=>r.id),fills.map(f=>f.key),snapshots.map(s=>s.id)])};
}
module.exports={VERSION,GAP_MS,HORIZON,normalizeObservations,candidateEpisodes,indexOutcomes,outcomeFor,validateOutcome,buildOpportunityReport,matchCoverage,identity,stats};
