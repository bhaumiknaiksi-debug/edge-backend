'use strict';
// Offline research simulation only. No broker, network, filesystem or live EDGE integration.
// Inputs must already contain EDGE-selected contract, a historical trigger and quote snapshots.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const round = x => Math.round(x * 100) / 100;
function simulate(rows, opts = {}) {
  const { capital = 10000, perTradeRisk = 250, dailyLoss = 500, roundTripCosts = 100, slippage = 0, maxQuoteAgeMs = 30000, maxGapMs = 120000 } = opts;
  if (![capital, perTradeRisk, dailyLoss, roundTripCosts, slippage, maxQuoteAgeMs, maxGapMs].every(finite) || capital <= 0 || perTradeRisk <= 0 || dailyLoss <= 0 || roundTripCosts < 0 || slippage < 0 || maxQuoteAgeMs < 0 || maxGapMs <= 0) throw Error('INVALID_OPTIONS');
  if (!Array.isArray(rows)) throw Error('INVALID_ROWS');
  let position = null, pnl = 0, locked = false, previous = -Infinity, unknown = false, session = null, used = new Set();
  const events = [];
  const skip = (r, reason) => events.push({ time:r.time, type:'SKIP', reason });
  for (const r of rows) {
    const t = Date.parse(r.time), qt = Date.parse(r.quoteAt);
    if (!finite(t) || t <= previous) throw Error('TIMESTAMPS_MUST_INCREASE');
    const currentSession = new Date(t + 19800000).toISOString().slice(0,10);
    if (session && session !== currentSession) throw Error('ONE_SESSION_ONLY');
    session = currentSession;
    if (previous !== -Infinity && t - previous > maxGapMs && position) { unknown = true; events.push({time:r.time,type:'UNKNOWN',reason:'OPEN_POSITION_DATA_GAP'}); }
    previous = t;
    const quoteValid = finite(qt) && qt <= t && t - qt <= maxQuoteAgeMs && finite(r.bid) && finite(r.ask) && r.bid > 0 && r.ask >= r.bid;
    if (position) {
      if (unknown) continue;
      if (r.contract !== position.contract || !quoteValid) { unknown = true; events.push({time:r.time,type:'UNKNOWN',reason:'MISSING_POSITION_QUOTE'}); continue; }
      if (r.bid <= position.stop || r.bid >= position.target || r.exit === true) {
        const exit = Math.max(0, r.bid - slippage), net = round((exit-position.entry)*position.quantity-roundTripCosts);
        pnl = round(pnl + net); locked = locked || pnl <= -dailyLoss;
        events.push({time:r.time,type:'CLOSE',contract:position.contract,quantity:position.quantity,entry:position.entry,exit,netPnl:net,reason:r.bid<=position.stop?'STOP':r.bid>=position.target?'TARGET':'EXPLICIT_EXIT'});
        position = null;
      }
      continue;
    }
    if (r.trigger !== true) continue;
    if (locked) { skip(r,'DAILY_LOSS_LOCK'); continue; }
    if (!r.episodeId || typeof r.episodeId !== 'string') {skip(r,'EPISODE_REQUIRED');continue;}
    if (used.has(r.episodeId)) {skip(r,'DUPLICATE_EPISODE');continue;}
    if (!['LONG_CALL','LONG_PUT'].includes(r.strategy) || typeof r.contract !== 'string' || !r.contract) {skip(r,'UNSUPPORTED_CONTRACT');continue;}
    if (!quoteValid) {skip(r,'STALE_OR_INVALID_QUOTE');continue;}
    if (!Number.isSafeInteger(r.lotSize) || r.lotSize <= 0 || !finite(r.stop) || !finite(r.target) || r.stop <= 0 || r.stop >= r.ask || r.target <= r.ask + slippage) {skip(r,'INVALID_PLAN');continue;}
    const entry = r.ask + slippage, plannedRisk = round((entry-r.stop+slippage)*r.lotSize+roundTripCosts);
    if (entry*r.lotSize + roundTripCosts > capital) {skip(r,'CAPITAL_LIMIT');continue;}
    if (plannedRisk > perTradeRisk || plannedRisk > dailyLoss-Math.max(0,-pnl)) {skip(r,'RISK_LIMIT');continue;}
    position = {contract:r.contract,quantity:r.lotSize,entry,stop:r.stop,target:r.target}; used.add(r.episodeId);
    events.push({time:r.time,type:'OPEN',contract:r.contract,quantity:r.lotSize,entry,plannedRisk});
  }
  return {mode:'OFFLINE_RESEARCH_ONLY',netPnl:unknown||position?null:pnl,realizedPnl:pnl,locked,openPosition:position,unknown,events,assumptions:{roundTripCosts,slippage,maxQuoteAgeMs,maxGapMs},warning:'Simulated quotes and stops do not guarantee fills or limit losses. One session only; no overnight or multi-leg modelling.'};
}
module.exports = { simulate };
