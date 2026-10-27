'use strict';

// Offline sampled-quote experiment. There are no broker or server dependencies.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const round = x => Math.round(x * 100) / 100;
const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const sessionOf = time => new Date(time + 19800000).toISOString().slice(0,10);
const inSession = time => {
  const date = new Date(time + 19800000), minute = date.getUTCHours()*60 + date.getUTCMinutes();
  return minute >= 555 && minute < 930;
};

function simulate(rows, opts = {}) {
  const {capital=10000, perTradeRisk=250, dailyLoss=500, roundTripCosts=100,
    slippage=0, maxQuoteAgeMs=30000, maxGapMs=90000} = opts;
  if (![capital,perTradeRisk,dailyLoss,roundTripCosts,slippage,maxQuoteAgeMs,maxGapMs].every(finite) ||
      capital<=0 || perTradeRisk<=0 || dailyLoss<=0 || roundTripCosts<0 || slippage<0 || maxQuoteAgeMs<0 || maxGapMs<=0)
    throw Error('INVALID_OPTIONS');
  if (!Array.isArray(rows)) throw Error('INVALID_ROWS');
  let position=null, pnl=0, locked=false, previous=-Infinity, unknown=false, session=null;
  const used=new Set(), events=[];
  const emit = (r,type,details) => events.push({time:r.time,type,...details});
  const skip = (r,reason) => emit(r,'SKIP',{reason,sourceId:r.sourceId??null});
  const quoteFor = (r,contract,time) => {
    const q=r.quotes?.[contract] || (r.contract===contract ? r : null), qt=timestamp(q?.quoteAt);
    return q && finite(qt) && qt<=time && time-qt<=maxQuoteAgeMs && finite(q.bid) && finite(q.ask) &&
      q.bid>0 && q.ask>=q.bid ? q : null;
  };
  const uncertain = (r,reason) => {unknown=true;emit(r,'UNKNOWN',{reason,contract:position.contract});};
  for (const r of rows) {
    const t=timestamp(r?.time);
    if (!finite(t) || t<=previous) throw Error('TIMESTAMPS_MUST_INCREASE');
    const date=sessionOf(t);
    if (session && session!==date) throw Error('ONE_SESSION_ONLY');
    session=date;
    if (position && !unknown && previous!==-Infinity && t-previous>maxGapMs) uncertain(r,'OPEN_POSITION_DATA_GAP');
    previous=t;
    if (unknown) continue; // Later prices cannot repair an unobserved stop/target path.
    if (position) {
      const q=quoteFor(r,position.contract,t);
      if (!q || !inSession(t) || r.marketPhase!=='OPEN') {uncertain(r,'MISSING_OR_UNUSABLE_POSITION_QUOTE');continue;}
      const exit=Math.max(0,q.bid-slippage);
      const net=round((exit-position.entry)*position.quantity-roundTripCosts);
      const lossHit=pnl+net<=-dailyLoss;
      if (q.bid<=position.stop || lossHit || exit>=position.target || r.exit===true) {
        pnl=round(pnl+net);locked=locked || lossHit;
        emit(r,'CLOSE',{contract:position.contract,episodeId:position.episodeId,quantity:position.quantity,
          entry:position.entry,exit,netPnl:net,reason:q.bid<=position.stop?'STOP':lossHit?'DAILY_LOSS':exit>=position.target?'TARGET':'EXPLICIT_EXIT'});
        position=null;
      }
      continue; // No closing and opening again from the same observation.
    }
    if (r.trigger!==true) {if(r.blockedReason)skip(r,r.blockedReason);continue;}
    if (locked) {skip(r,'DAILY_LOSS_LOCK');continue;}
    if (r.marketPhase!=='OPEN' || !inSession(t)) {skip(r,'MARKET_NOT_OPEN');continue;}
    if (!r.episodeId || typeof r.episodeId!=='string') {skip(r,'EPISODE_REQUIRED');continue;}
    const identity=JSON.stringify([r.contract,r.episodeId]);
    if (used.has(identity)) {skip(r,'DUPLICATE_EPISODE');continue;}
    if (!['LONG_CALL','LONG_PUT'].includes(r.strategy) || typeof r.contract!=='string' || !r.contract) {skip(r,'UNSUPPORTED_CONTRACT');continue;}
    const q=quoteFor(r,r.contract,t);
    if (!q) {skip(r,'STALE_OR_INVALID_QUOTE');continue;}
    if (!Number.isSafeInteger(r.lotSize) || r.lotSize<=0 || !finite(r.stop) || !finite(r.target) ||
        r.stop<=0 || r.stop>=q.ask || r.target<=q.ask+slippage) {skip(r,'INVALID_PLAN');continue;}
    const entry=q.ask+slippage;
    const plannedRisk=round((entry-Math.max(0,r.stop-slippage))*r.lotSize+roundTripCosts);
    const cost=round(entry*r.lotSize+roundTripCosts);
    // Losses reduce the starting capital ceiling; profits never expand it.
    if (!finite(cost) || cost>Math.max(0,capital+Math.min(0,pnl))) {skip(r,'CAPITAL_LIMIT');continue;}
    if (!finite(plannedRisk) || plannedRisk>perTradeRisk || plannedRisk>dailyLoss-Math.max(0,-pnl)) {skip(r,'RISK_LIMIT');continue;}
    position={contract:r.contract,episodeId:r.episodeId,quantity:r.lotSize,entry,stop:r.stop,target:r.target};
    used.add(identity);
    emit(r,'OPEN',{...position,plannedRisk,sourceId:r.sourceId??null});
  }
  return {mode:'OFFLINE_RESEARCH_ONLY',executionAllowed:false,liveDecisionImpact:false,
    netPnl:unknown || position || !rows.length ? null : pnl,realizedPnl:pnl,locked,openPosition:position,unknown,events,
    assumptions:{capital,perTradeRisk,dailyLoss,roundTripCosts,slippage,maxQuoteAgeMs,maxGapMs},
    coverage:'INPUT_WINDOW_ONLY_NOT_A_FULL_SESSION_PROOF',
    warning:'Sampled quotes are not fills. Stops and loss thresholds are not guarantees. No depth, partial-fill, intrabar or broker-failure modelling.'};
}
module.exports={simulate};
