'use strict';
const { buildEntryPlan } = require('./entryEngine');
// OPENING_RANGE_SHADOW_V3 — research timing rule, off unless EDGE_SHADOW_TIMING_V3_ENABLED=true.
//
// Same trading idea as V2 (a completed 5-minute NIFTY close crossing the frozen 09:15–09:30 range), with the
// state handling rebuilt so a genuine breakout is not lost to bookkeeping:
//  1. Breakouts are tracked at MARKET level, per direction, whatever the regime or candidate cards say.
//  2. A breakout stays CONFIRMED until a settled close goes back through its level (no 30-minute timer).
//     Entry eligibility is separate: only within ENTRY_FRESHNESS_MS of the crossing candle's close.
//  3. A candle is judged only after SETTLE_MS past its close. Every later read is revalidated against the first
//     settled value; a conflict is recorded, never silently accepted, and blocks new entries until a later candle
//     has settled and been read consistently. A breakout built on a revised candle can never be traded.
//  4. Fetch failures and incomplete responses keep the history but block new entries (fail closed): every
//     expected 5-minute candle from 09:15 up to the latest one that should have settled must be present in the
//     CURRENT provider response. Earlier reads never stand in for a candle the provider stopped returning.
// Late regime alignment is allowed only inside the freshness window, with price still beyond the level,
// not chased (CHASE_FRACTION of the range width), and every existing trigger/price/liquidity gate passing.
const VERSION = 'OPENING_RANGE_SHADOW_V3';
const FIVE = 300000;
const SETTLE_MS = 60000;
const ENTRY_FRESHNESS_MS = 10 * 60000;
const CHASE_FRACTION = 0.5;
const EPS = 0.005;
const RULE = { settleMs:SETTLE_MS, entryFreshnessMs:ENTRY_FRESHNESS_MS, chaseFraction:CHASE_FRACTION, coverage:'CONTINUOUS_TO_LATEST_SETTLED' };
const session = t => new Date(t + 19800000).toISOString().slice(0, 10);
const iso = t => new Date(t).toISOString();
const family = d => String(d || '').includes('BULL') ? 'UP' : String(d || '').includes('BEAR') ? 'DOWN' : 'NEUTRAL';
const beyond = (dir, close, level) => dir === 'UP' ? close > level : close < level;

function freshState(day) {
  return { session:day, anchor:null, anchorConflict:false, settled:new Map(), reads:new Map(), revised:new Set(),
    conflicts:[], trustAfter:null, breakouts:new Map() };
}
// Start time of the newest candle that must have settled by `now`, or null before the first one.
function expectedLatest(day, now) {
  const open = Date.parse(day + 'T09:15:00+05:30'), k = Math.floor((now - SETTLE_MS - FIVE - open) / FIVE);
  return k < 0 ? null : open + k * FIVE;
}
// True only when the current response holds every candle from 09:15 through the expected latest settled one.
function covered(source, day, now) {
  const last = expectedLatest(day, now);
  if (last === null) return false;
  const have = new Set((source?.candles || []).map(c => c.time));
  for (let t = Date.parse(day + 'T09:15:00+05:30'); t <= last; t += FIVE) if (!have.has(t)) return false;
  return true;
}

// Rebuild the breakout list from the settled candle sequence. Deterministic: same candles -> same breakouts.
function derive(st) {
  const times = [...st.settled.keys()].sort((a,b) => a - b);
  const end = Date.parse(st.session + 'T09:30:00+05:30');
  const out = [];
  for (const dir of ['UP','DOWN']) {
    const level = dir === 'UP' ? st.anchor.high : st.anchor.low;
    let active = null;
    for (const t of times) {
      if (t < end) continue;
      const close = st.settled.get(t), prev = st.settled.has(t - FIVE) ? st.settled.get(t - FIVE) : null;
      if (active) {
        if (!beyond(dir, close, level)) { active.invalidatedAt = t + FIVE; active.invalidationCandle = t; active = null; }
        continue;
      }
      // A crossing needs the immediately preceding candle: a gap can hide where price actually was.
      if (prev !== null && !beyond(dir, prev, level) && beyond(dir, close, level)) {
        active = { id:st.session + ':' + dir + ':' + iso(t), direction:dir, level, crossingCandle:t, crossedAt:t + FIVE,
          revisedInput: st.revised.has(t) || st.revised.has(t - FIVE), invalidatedAt:null };
        out.push(active);
      }
    }
  }
  return out;
}

function merge(st, derived, now) {
  const seen = new Set();
  for (const d of derived) {
    seen.add(d.id);
    const known = st.breakouts.get(d.id);
    const b = known || { id:d.id, direction:d.direction, level:d.level, crossingCandle:d.crossingCandle, crossedAt:d.crossedAt, detectedAt:now };
    if (b.status === 'INVALIDATED' && b.reason === 'CROSSING_CANDLE_REVISED') { st.breakouts.set(d.id, b); continue; } // permanent
    if (d.revisedInput) { b.status = 'INVALIDATED'; b.reason = 'CROSSING_CANDLE_REVISED'; b.invalidatedAt = b.invalidatedAt || now; }
    else if (d.invalidatedAt) { b.status = 'INVALIDATED'; b.reason = 'CLOSE_BACK_THROUGH_ANCHOR'; b.invalidatedAt = d.invalidatedAt; }
    else { b.status = 'CONFIRMED'; b.reason = 'COMPLETED_CANDLE_CROSSING'; }
    st.breakouts.set(d.id, b);
  }
  // A breakout that no longer exists in the (revised) data was never real: keep it, marked, never tradable.
  for (const b of st.breakouts.values()) if (!seen.has(b.id) && b.reason !== 'CROSSING_CANDLE_REVISED') {
    b.status = 'INVALIDATED'; b.reason = 'CROSSING_CANDLE_REVISED'; b.invalidatedAt = now;
  }
}

function ingest(st, source, now) {
  const anchor = { high:source.high, low:source.low, completedAt:source.completedAt };
  if (!st.anchor) st.anchor = anchor;
  else if (anchor.high !== st.anchor.high || anchor.low !== st.anchor.low || anchor.completedAt !== st.anchor.completedAt) {
    if (!st.anchorConflict) st.conflicts.push({ kind:'ANCHOR_REVISED', detectedAt:iso(now), recorded:st.anchor, observed:anchor });
    st.anchorConflict = true; // the frozen range is never replaced; the session fails closed
  }
  let conflict = false;
  for (const c of source.candles || []) {
    if (c.time + FIVE + SETTLE_MS > now) continue; // not settled yet
    if (st.settled.has(c.time)) {
      const recorded = st.settled.get(c.time);
      if (Math.abs(recorded - c.close) > EPS) {
        conflict = true;
        st.conflicts.push({ kind:'CANDLE_REVISED', candle:iso(c.time), recorded, observed:c.close, detectedAt:iso(now) });
        st.revised.add(c.time); st.settled.set(c.time, c.close); st.reads.set(c.time, 1);
      } else st.reads.set(c.time, (st.reads.get(c.time) || 0) + 1);
    } else { st.settled.set(c.time, c.close); st.reads.set(c.time, 1); }
  }
  if (st.conflicts.length > 50) st.conflicts.splice(0, st.conflicts.length - 50);
  // Trust returns only after a candle that STARTED after the conflict has settled and been read twice, unchanged.
  if (conflict) st.trustAfter = Math.floor(now / FIVE) * FIVE + FIVE;
}

function dataStatus(st, source, input, now) {
  if (input?.marketPhase !== 'OPEN') return 'MARKET_CLOSED';
  if (!source?.available || source.session !== session(now) || !Array.isArray(source.candles)) return 'DATA_UNAVAILABLE';
  if (st.anchorConflict) return 'ANCHOR_REVISED';
  if (!covered(source, st.session, now)) return 'INCOMPLETE_CANDLES';
  if (st.trustAfter !== null) {
    const ok = [...st.settled.keys()].some(t => t >= st.trustAfter && (st.reads.get(t) || 0) >= 2 && !st.revised.has(t));
    if (!ok) return 'DATA_CONFLICT_UNRESOLVED';
    st.trustAfter = null;
  }
  return 'OK';
}

function createShadowTimingV3() {
  let st = null;
  return function evaluate({ enabled=false, now=Date.now(), source, candidates, input={} }) {
    if (!enabled) { st = null; return null; }
    const day = session(now);
    if (!st || st.session !== day) st = freshState(day);
    if (input.marketPhase === 'OPEN' && source?.available && source.session === day && Array.isArray(source.candles)) {
      ingest(st, source, now);
      if (st.anchor && !st.anchorConflict) merge(st, derive(st), now);
    }
    const status = dataStatus(st, source, input, now);
    const trusted = status === 'OK';
    // The close entries are judged on is the expected latest settled candle, and only when this response covered it.
    const latestTime = trusted ? expectedLatest(day, now) : null;
    const latestClose = latestTime === null ? null : st.settled.get(latestTime);
    const breakouts = [...st.breakouts.values()].sort((a,b) => a.crossedAt - b.crossedAt);
    const output = { version:VERSION, researchOnly:true, liveDecisionImpact:false, executionAllowed:false, rule:RULE,
      market:{ dataStatus:status, anchor:st.anchor ? { source:'NIFTY_INDEX_5M_OPENING_RANGE', ...st.anchor } : null,
        conflicts:st.conflicts.length,
        breakouts:breakouts.map(b => ({ id:b.id, direction:b.direction, level:b.level, status:b.status, reason:b.reason,
          crossedAt:iso(b.crossedAt), invalidatedAt:b.invalidatedAt ? iso(b.invalidatedAt) : null })) },
      plans:{} };
    for (const tier of ['A','B','C']) {
      const plan = candidates?.plans?.[tier];
      const result = { executionAllowed:false, status:'UNKNOWN', reason:null, dataStatus:status };
      output.plans[tier] = result;
      const bullish = ['LONG_CALL','BULL_CALL_SPREAD'].includes(plan?.strategy);
      const supported = bullish || ['LONG_PUT','BEAR_PUT_SPREAD'].includes(plan?.strategy);
      if (!plan?.available || !supported) { result.reason = 'UNSUPPORTED_OR_UNAVAILABLE_STRUCTURE'; continue; }
      const legs = plan.legs;
      const ids = [legs?.buyLeg, legs?.sellLeg].filter(Boolean).map(l => l.instrumentKey || l.contractId);
      if (ids.some(id => !id) || ids.length !== (plan.strategy.endsWith('SPREAD') ? 2 : 1)) { result.reason = 'CONTRACT_IDENTITY_REQUIRED'; continue; }
      Object.assign(result, { strategy:plan.strategy, contracts:ids });
      if (!st.anchor) { result.reason = status === 'OK' ? 'COMPLETE_OPENING_RANGE_REQUIRED' : status; continue; }
      const dir = bullish ? 'UP' : 'DOWN';
      const b = breakouts.filter(x => x.direction === dir).at(-1);
      result.anchor = { source:'NIFTY_INDEX_5M_OPENING_RANGE', ...st.anchor };
      if (!b) { result.status = 'WAITING'; result.reason = 'WAIT_FOR_CROSSING'; result.entryBlocker = 'NO_BREAKOUT'; result.shadowEntryReady = false; continue; }
      const fresh = now - b.crossedAt <= ENTRY_FRESHNESS_MS;
      const spot = Number(input.spot);
      const width = st.anchor.high - st.anchor.low;
      const distance = Number.isFinite(spot) ? (dir === 'UP' ? spot - b.level : b.level - spot) : null;
      const aligned = family(input.regime?.direction) === dir;
      const tradeLegs = { ...legs, netDebit:legs.netDebit ?? plan.indicativeNetDebit };
      const baseline = buildEntryPlan({ ...input, strategy:plan.strategy, tradeLegs });
      const anchored = latestClose === null || latestClose === undefined ? { triggerReady:false } :
        buildEntryPlan({ ...input, strategy:plan.strategy, tradeLegs, spot:latestClose, support:st.anchor.low, resistance:st.anchor.high });
      const confirmed = b.status === 'CONFIRMED';
      const blocker = !confirmed ? 'BREAKOUT_NOT_CONFIRMED' : !trusted ? status : !fresh ? 'ENTRY_WINDOW_ELAPSED' :
        !aligned ? 'REGIME_NOT_ALIGNED' : !(distance > 0) || !beyond(dir, latestClose, b.level) ? 'PRICE_BACK_INSIDE_RANGE' :
        distance > CHASE_FRACTION * width ? 'CHASE_LIMIT' : !anchored.triggerReady ? 'TRIGGER_NOT_READY' :
        !baseline.priceReady ? 'PRICE_NOT_READY' : !baseline.liquidityReady ? 'LIQUIDITY_NOT_READY' : null;
      Object.assign(result, { status:b.status, reason:b.reason, episodeId:b.id, breakoutId:b.id,
        crossedAt:iso(b.crossedAt), entryWindowEndsAt:iso(b.crossedAt + ENTRY_FRESHNESS_MS), entryFresh:fresh,
        regimeAligned:aligned, chaseLimitPoints:Math.round(CHASE_FRACTION * width * 100) / 100,
        candleClosedAt:latestTime === null ? null : iso(latestTime + FIVE),
        baselineTriggerReady:baseline.triggerReady, shadowTriggerReady:confirmed && anchored.triggerReady === true,
        priceReady:baseline.priceReady, liquidityReady:baseline.liquidityReady,
        entryBlocker:blocker, shadowEntryReady:blocker === null });
    }
    return output;
  };
}
// Feature flag: V3 replaces V2 only when BOTH variables are exactly 'true'. Anything else keeps V2.
const v3Enabled = env => env?.EDGE_SHADOW_TIMING_ENABLED === 'true' && env?.EDGE_SHADOW_TIMING_V3_ENABLED === 'true';
module.exports = { createShadowTimingV3, v3Enabled, VERSION, SETTLE_MS, ENTRY_FRESHNESS_MS, CHASE_FRACTION };
