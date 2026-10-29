'use strict';
const { randomUUID } = require('node:crypto');
const { buildEntryPlan } = require('./entryEngine');
// V2: an episode follows the session and direction, not the exact contract, so a breakout stays confirmed while the
// ATM strike rolls with price; an expired or invalidated episode restarts on the next candle and a fresh crossing
// confirms again. V1 restarted (and lost the crossing) on every strike change.
const VERSION = 'OPENING_RANGE_SHADOW_V2';
const TERMINAL = new Set(['EXPIRED','INVALIDATED']);
const FIVE = 300000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const session = t => new Date(t + 19800000).toISOString().slice(0, 10);

// Raw provider candles are timestamped at the START of each five-minute bar.
// No fallback to partial opening ranges or synthetic ATM strike levels.
function buildTimingSource(raw, now = Date.now()) {
  const day = session(now);
  const start = Date.parse(day + 'T09:15:00+05:30');
  const end = start + 3 * FIVE;
  const rows = (Array.isArray(raw) ? raw : []).map(r => Array.isArray(r) ? {
    time: Date.parse(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
    valid: r.slice(1, 5).length === 4 && r.slice(1, 5).every(v => v !== null && v !== '' && Number.isFinite(Number(v)))
  } : {}).filter(r => r.valid && finite(r.time) && r.time >= start && r.time < start + 75 * FIVE &&
    (r.time - start) % FIVE === 0 && r.time + FIVE <= now && r.low > 0 &&
    r.high >= Math.max(r.open, r.close, r.low) && r.low <= Math.min(r.open, r.close))
    .sort((a,b) => a.time - b.time);
  if (new Set(rows.map(r => r.time)).size !== rows.length) return { available:false, reason:'DUPLICATE_CANDLES' };
  const opening = rows.filter(r => r.time < end);
  if (now < end || opening.length !== 3) return { available:false, reason:'COMPLETE_OPENING_RANGE_REQUIRED' };
  const high = Math.max(...opening.map(r => r.high)), low = Math.min(...opening.map(r => r.low));
  if (high <= low) return { available:false, reason:'INVALID_OPENING_RANGE' };
  return { available:true, session:day, source:'NIFTY_INDEX_5M_OPENING_RANGE',
    high, low, completedAt:new Date(end).toISOString(),
    latest: rows.at(-1), previous: rows.at(-2) || null };
}

function buildReadinessView({ setup, entry, regime, strategy, marketPhase, chartAgreement, risk, position }) {
  const gates = { market:marketPhase === 'OPEN', strategy:!!strategy && strategy !== 'WAIT',
    direction:['BULL','BEAR'].some(x => String(regime?.direction).includes(x)),
    setup:setup?.qualified === true, chart:chartAgreement === 'AGREES',
    trigger:entry?.triggerReady === true, price:entry?.priceReady === true, liquidity:entry?.liquidityReady === true };
  const missing = Object.keys(gates).filter(k => !gates[k]);
  return { version:'READINESS_VIEW_V1', researchOnly:true, executionAllowed:false,
    market:{ status:missing.length ? 'INCOMPLETE' : 'CONFIRMED', gates, missing },
    eligibility:{ riskStatus:risk?.status || 'UNKNOWN', positionStatus:position?.status || 'UNKNOWN',
      positionReason:position?.reason || null, eligible:risk?.status === 'READY' && position?.status === 'READY' } };
}

function createShadowTiming() {
  // One active episode per displayed tier. Restart deliberately loses continuity;
  // persisted evidence retains the old episode and the new one starts UNKNOWN.
  const states = new Map();
  return function evaluate({ enabled=false, now=Date.now(), source, candidates, input }) {
    if (!enabled) { states.clear(); return null; }
    const output = { version:VERSION, researchOnly:true, liveDecisionImpact:false, executionAllowed:false, plans:{} };
    for (const tier of ['A','B','C']) {
      const plan = candidates?.plans?.[tier];
      const bullish = ['LONG_CALL','BULL_CALL_SPREAD'].includes(plan?.strategy);
      const supported = bullish || ['LONG_PUT','BEAR_PUT_SPREAD'].includes(plan?.strategy);
      const result = { executionAllowed:false, status:'UNKNOWN', reason:null };
      output.plans[tier] = result;
      if (!plan?.available || !supported) { states.delete(tier); result.reason='UNSUPPORTED_OR_UNAVAILABLE_STRUCTURE'; continue; }
      const legs = plan.legs;
      const ids = [legs?.buyLeg, legs?.sellLeg].filter(Boolean).map(l => l.instrumentKey || l.contractId);
      const spread = plan.strategy.endsWith('SPREAD');
      if (ids.some(id => !id) || ids.length !== (spread ? 2 : 1)) { states.delete(tier); result.reason='CONTRACT_IDENTITY_REQUIRED'; continue; }
      if (input.marketPhase !== 'OPEN' || !source?.available || source.session !== session(now) ||
          !source.latest || now - (source.latest.time + FIVE) > 2 * FIVE || source.latest.time + FIVE > now) {
        states.delete(tier); result.reason=input.marketPhase !== 'OPEN' ? 'MARKET_CLOSED' : 'MISSING_OR_STALE_CANDLES'; continue;
      }
      const key = JSON.stringify([source.session, bullish ? 'UP' : 'DOWN']);
      const episode = (lastTime, lastClose, reason) => ({ key, episodeId:randomUUID(), startedAt:new Date(now).toISOString(),
        expiresAt:Math.min(now + 30 * 60000, Date.parse(source.session + 'T15:30:00+05:30')),
        high:source.high, low:source.low, completedAt:source.completedAt, lastTime, lastClose, status:'UNKNOWN', reason });
      let state = states.get(tier);
      const revisedFor = st => !!st && (source.high !== st.high || source.low !== st.low || source.completedAt !== st.completedAt);
      if (state && state.key === key && TERMINAL.has(state.status) && source.latest.time !== state.lastTime) {
        // Restart on the next candle. The last observed close carries over when it is continuous and trustworthy,
        // so a crossing on this very candle counts as a fresh one.
        const trusted = !revisedFor(state) && !state.untrustedClose && state.reason !== 'OBSERVED_CANDLE_REVISED';
        state = trusted ? episode(state.lastTime, state.lastClose, 'RESTARTED_AFTER_' + state.reason)
          : episode(source.latest.time, source.latest.close, 'NEW_EPISODE_WAIT_FOR_NEXT_CANDLE');
        states.set(tier, state);
      }
      if (!state || state.key !== key) {
        state = episode(source.latest.time, source.latest.close, 'NEW_EPISODE_WAIT_FOR_NEXT_CANDLE');
        states.set(tier, state);
      } else if (!TERMINAL.has(state.status) && now >= state.expiresAt) {
        state.status='EXPIRED'; state.reason='EPISODE_TIME_LIMIT';
        if (source.latest.time !== state.lastTime) { // keep the last close so a restart can judge the next crossing
          state.untrustedClose = !(source.latest.time === state.lastTime + FIVE && source.previous?.time === state.lastTime && source.previous.close === state.lastClose);
          state.lastTime=source.latest.time; state.lastClose=source.latest.close;
        }
      } else if (TERMINAL.has(state.status)) {
        // waiting for the next candle to restart
      } else if (revisedFor(state)) {
        state.status='INVALIDATED'; state.reason='ANCHOR_SOURCE_REVISED';
      } else if (source.latest.time < state.lastTime) {
        result.reason='OUT_OF_ORDER_CANDLES'; continue;
      } else if (source.latest.time === state.lastTime && source.latest.close !== state.lastClose) {
        state.status='INVALIDATED'; state.reason='OBSERVED_CANDLE_REVISED';
      } else if (!['EXPIRED','INVALIDATED'].includes(state.status) && source.latest.time !== state.lastTime) {
        const continuous = source.latest.time === state.lastTime + FIVE && source.previous?.time === state.lastTime && source.previous.close === state.lastClose;
        const level = bullish ? state.high : state.low;
        const crossed = bullish ? state.lastClose <= level && source.latest.close > level : state.lastClose >= level && source.latest.close < level;
        const beyond = bullish ? source.latest.close > level : source.latest.close < level;
        if (!continuous) { state.status='UNKNOWN'; state.reason='OBSERVATION_GAP'; }
        else if (state.status === 'CONFIRMED' && !beyond) { state.status='INVALIDATED'; state.reason='CLOSE_BACK_THROUGH_ANCHOR'; }
        else if (crossed) { state.status='CONFIRMED'; state.reason='COMPLETED_CANDLE_CROSSING'; }
        else if (state.status !== 'CONFIRMED') { state.status='WAITING'; state.reason=beyond ? 'ALREADY_BEYOND_ANCHOR_NO_NEW_CROSSING' : 'WAIT_FOR_CROSSING'; }
        state.lastTime=source.latest.time; state.lastClose=source.latest.close;
      }
      const tradeLegs = { ...legs, netDebit:legs.netDebit ?? plan.indicativeNetDebit };
      const baseline = buildEntryPlan({ ...input, strategy:plan.strategy, tradeLegs });
      const anchored = buildEntryPlan({ ...input, strategy:plan.strategy, tradeLegs,
        spot:source.latest.close, support:state.low, resistance:state.high });
      const ready = state.status === 'CONFIRMED' && anchored.triggerReady && baseline.priceReady && baseline.liquidityReady;
      Object.assign(result, { episodeId:state.episodeId, startedAt:state.startedAt,
        expiresAt:new Date(state.expiresAt).toISOString(), status:state.status, reason:state.reason,
        strategy:plan.strategy, contracts:ids, anchor:{ source:source.source, high:state.high, low:state.low, completedAt:state.completedAt },
        candleClosedAt:new Date(source.latest.time + FIVE).toISOString(), baselineTriggerReady:baseline.triggerReady,
        shadowTriggerReady:state.status === 'CONFIRMED' && anchored.triggerReady,
        priceReady:baseline.priceReady, liquidityReady:baseline.liquidityReady,
        shadowEntryReady:ready, differs:ready !== (baseline.triggerReady && baseline.priceReady && baseline.liquidityReady) });
    }
    return output;
  };
}
module.exports = { buildTimingSource, createShadowTiming, buildReadinessView };
