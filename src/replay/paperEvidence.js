'use strict';

// Reads captured EDGE facts only. No selection, promotion, broker, storage writes or live wiring.
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {buildTradePlans}=require('../trading/readOnlyTradePlanner');
const {simulate}=require('./paperExecution');
const plannerHash=createHash('sha256').update(readFileSync(require.resolve('../trading/readOnlyTradePlanner'))).digest('hex');
const stamp=value=>typeof value==='string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const day=time=>new Date(time+19800000).toISOString().slice(0,10);
const key=(instrument,expiry)=>JSON.stringify([instrument,expiry]);
const finite=x=>typeof x==='number' && Number.isFinite(x);
const inc=(counts,name)=>{counts[name]=(counts[name]||0)+1;};
function phaseOf(s) {
  const explicit=s.marketPhase??s.risk?.marketPhase;
  const gate=s.readinessView?.market?.gates?.market??s.signalTier?.gates?.market;
  if (explicit && !['OPEN','CLOSED','PRE_OPEN'].includes(explicit)) return 'UNKNOWN';
  if (explicit && typeof gate==='boolean' && (explicit==='OPEN')!==gate) return 'UNKNOWN';
  return explicit || (gate===true?'OPEN':gate===false?'CLOSED':'UNKNOWN');
}
function indexQuotes(quotes) {
  const index=new Map();
  for(const q of quotes) {
    const t=stamp(q.receivedAt);
    if(!q.instrumentKey || !/^\d{4}-\d{2}-\d{2}$/.test(q.expiry||'') || !Number.isFinite(t) ||
        !q.source || !finite(q.bid) || !finite(q.ask) || q.bid<=0 || q.ask<q.bid) throw Error('INVALID_QUOTE_SIDECAR');
    const k=key(q.instrumentKey,q.expiry), list=index.get(k)||[];
    list.push({...q,time:t});index.set(k,list);
  }
  for(const list of index.values()) {
    list.sort((a,b)=>a.time-b.time);
    for(let i=1;i<list.length;i++) if(list[i].time===list[i-1].time) throw Error('DUPLICATE_QUOTE_TIMESTAMP');
  }
  return index;
}
function quoteAt(list,time) {
  // As-of join. No later quote may affect an earlier entry or exit.
  let lo=0, hi=(list||[]).length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].time<=time)lo=mid+1;else hi=mid;}
  return lo ? list[lo-1] : null;
}
function replayEvidence(input,{tier='C',reconstructPlans=false,quotes=[],instruments=[],simulation={}}={}) {
  if(!['A','B','C'].includes(tier))throw Error('INVALID_TIER');
  const records=Array.isArray(input)?input:input?.entries;
  if(!Array.isArray(records) || !Array.isArray(quotes) || !Array.isArray(instruments))throw Error('INVALID_EVIDENCE_INPUT');
  for(const m of instruments) if(!m.instrumentKey || !/^\d{4}-\d{2}-\d{2}$/.test(m.expiry||'') || !m.source ||
    !Number.isSafeInteger(m.lotSize) || m.lotSize<=0 || !finite(stamp(m.validFrom)) || !finite(stamp(m.validThrough)) ||
    stamp(m.validThrough)<stamp(m.validFrom))throw Error('INVALID_INSTRUMENT_SIDECAR');
  const quoteIndex=indexQuotes(quotes), kinds={}, missing={}, sessions=new Map(), blockers=[];
  for(const r of records) inc(kinds,r?.recordType||'UNKNOWN');
  const polls=records.filter(r=>r?.recordType==='POLL_SNAPSHOT');
  if(polls.some(p=>!finite(stamp(p.timestamp))))throw Error('INVALID_POLL_TIMESTAMP');
  const sorted=[...polls].sort((a,b)=>stamp(a.timestamp)-stamp(b.timestamp));
  let previous=null;
  for(const s of sorted) {
    const now=stamp(s.timestamp), date=day(now);
    if(previous && stamp(previous.timestamp)===now)throw Error('DUPLICATE_POLL_TIMESTAMP');
    const rows=sessions.get(date)||[], reasons=[];
    const candidate=s.researchCandidatePlans?.plans?.[tier], leg=candidate?.legs?.buyLeg;
    const contract=leg?.instrumentKey && s.expiry ? key(leg.instrumentKey,s.expiry) : null;
    const timing=s.shadowTiming?.plans?.[tier];
    const phase=phaseOf(s);
    if(phase!=='OPEN') reasons.push('RECORDED_MARKET_NOT_OPEN');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s.expiry||'') || s.expiry<date)reasons.push('INVALID_OR_EXPIRED_CONTRACT');
    if(candidate?.available!==true || !leg || !contract)reasons.push('MISSING_CANDIDATE_IDENTITY');
    if(candidate && !['LONG_CALL','LONG_PUT'].includes(candidate.strategy))reasons.push('UNSUPPORTED_STRUCTURE');
    if(candidate?.legs && Object.keys(candidate.legs).some(k=>['sellLeg','ceShort','ceLong','peShort','peLong'].includes(k)))reasons.push('UNSUPPORTED_STRUCTURE');
    const matches=instruments.filter(m=>key(m.instrumentKey,m.expiry)===contract && stamp(m.validFrom)<=now && stamp(m.validThrough)>=now);
    if(matches.length!==1)reasons.push(matches.length?'AMBIGUOUS_LOT_METADATA':'MISSING_LOT_METADATA');
    const q=quoteAt(quoteIndex.get(contract),now);
    if(!q) reasons.push('MISSING_TIMESTAMPED_QUOTES');
    else if(now-q.time>(simulation.maxQuoteAgeMs??30000))reasons.push('STALE_TIMESTAMPED_QUOTE');
    let hypothesis=s.tradePlans?.tiers?.[tier] || null, planBasis=hypothesis?'FROZEN_RECORDED_PLAN':null;
    if(!hypothesis && reconstructPlans) {
      const recorded=s.ruleSpec?.components?.exitHypotheses?.files?.['trading/readOnlyTradePlanner.js'];
      if(recorded!==plannerHash)reasons.push('PLANNER_VERSION_NOT_MATCHED');
      else if(!finite(s.spot) || !finite(s.support?.strike) || !finite(s.resistance?.strike))reasons.push('MISSING_RECONSTRUCTION_INPUTS');
      else {
        hypothesis=buildTradePlans({timestamp:s.timestamp,spot:s.spot,support:s.support,resistance:s.resistance,
          decision:{researchCandidatePlans:s.researchCandidatePlans}}).tiers[tier];
        planBasis='RECONSTRUCTED_RESEARCH_PLAN';
      }
    }
    if(!hypothesis || hypothesis.status!=='MODEL_READY_SHADOW' || hypothesis.mode!=='SHADOW' || hypothesis.executable!==false || hypothesis.analysisAt!==s.timestamp ||
        hypothesis.tier!==tier || hypothesis.contract!==leg?.contractId || hypothesis.strategy!==candidate?.strategy ||
        !finite(hypothesis.stop?.premium) || !finite(hypothesis.targets?.[0]?.premium))reasons.push('MISSING_USABLE_EXIT_HYPOTHESIS');
    const priorTiming=previous?.shadowTiming?.plans?.[tier], priorLeg=previous?.researchCandidatePlans?.plans?.[tier]?.legs?.buyLeg;
    const continuity=previous && day(stamp(previous.timestamp))===date && now-stamp(previous.timestamp)<=(simulation.maxGapMs??90000) &&
      priorTiming?.episodeId===timing?.episodeId && priorLeg?.instrumentKey===leg?.instrumentKey && previous.expiry===s.expiry;
    const timingIdentity=timing?.strategy===candidate?.strategy && timing?.contracts?.length===1 && timing.contracts[0]===leg?.instrumentKey;
    const confirmed=s.shadowTiming?.version==='OPENING_RANGE_SHADOW_V1' && s.shadowTiming.researchOnly===true &&
      timing?.status==='CONFIRMED' && timing.shadowEntryReady===true && timing.reason==='COMPLETED_CANDLE_CROSSING' &&
      typeof timing.episodeId==='string' && timingIdentity && finite(stamp(timing.startedAt)) && stamp(timing.startedAt)<=now &&
      finite(stamp(timing.expiresAt)) && stamp(timing.expiresAt)>now && finite(stamp(timing.candleClosedAt)) && stamp(timing.candleClosedAt)<=now &&
      now-stamp(timing.candleClosedAt)<=300000;
    const crossed=confirmed && continuity && ['UNKNOWN','WAITING'].includes(priorTiming.status) && phaseOf(previous)==='OPEN';
    if(!crossed)reasons.push(confirmed?'NO_OBSERVED_TRIGGER_TRANSITION':'NO_RECORDED_SHADOW_TRIGGER');
    const marks=Object.fromEntries([...quoteIndex].flatMap(([k,list])=>{
      const found=quoteAt(list,now);
      return found && day(found.time)===date ? [[k,{bid:found.bid,ask:found.ask,quoteAt:found.receivedAt}]] : [];
    }));
    const unique=[...new Set(reasons)];
    for(const reason of unique)inc(missing,reason);
    blockers.push({sourceId:s.id??null,time:s.timestamp,reasons:unique,planBasis});
    rows.push({time:s.timestamp,marketPhase:phase,sourceId:s.id??null,contract,strategy:candidate?.strategy,
      episodeId:timing?.episodeId,lotSize:matches[0]?.lotSize,stop:hypothesis?.stop?.premium,target:hypothesis?.targets?.[0]?.premium,
      trigger:!unique.length,blockedReason:unique[0],quotes:marks});
    sessions.set(date,rows);previous=s;
  }
  const reports=[...sessions].map(([session,rows])=>{
    const result=simulate(rows,simulation), opens=result.events.filter(e=>e.type==='OPEN').length;
    return {session,observations:rows.length,firstObservedAt:rows[0].time,lastObservedAt:rows.at(-1).time,
      opens,closes:result.events.filter(e=>e.type==='CLOSE').length,...result,netPnl:opens?result.netPnl:null};
  });
  return {version:'PAPER_EVIDENCE_REPLAY_V1',mode:'OFFLINE_RESEARCH_ONLY',executionAllowed:false,liveDecisionImpact:false,
    tier,entryPolicy:'RECORDED_SHADOW_CROSS_RESEARCH_ONLY',records:records.length,pollSnapshots:polls.length,recordTypes:kinds,
    excludedOutcomeRecords:records.length-polls.length,quoteSidecarRecords:quotes.length,instrumentSidecarRecords:instruments.length,
    readyRows:blockers.filter(b=>!b.reasons.length).length,blockerCounts:missing,observations:blockers,sessions:reports,
    coverage:'INPUT_WINDOW_ONLY_NOT_CONTINUOUS_COLLECTION',
    limitations:['Outcome summaries and candle closes are never used as bid/ask quotes.',
      'Historical receipt times and lot metadata must be supplied with provenance; analysis timestamps are not substituted.',
      'Reconstructed plans require a matching recorded planner hash and remain unvalidated hypotheses.',
      'No real broker fills, partial fills, intrabar path or execution reliability is established.']};
}
module.exports={replayEvidence,plannerHash};
