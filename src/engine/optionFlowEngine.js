'use strict';

/**
 * Probable option-flow classifier.
 *
 * This is an inference layer, not a claim about the identity or intent of
 * individual market participants. It combines OI change with premium change
 * and underlying direction. Upstox supplies current OI, previous OI and the
 * previous-session option close in the option-chain response.
 */

const MIN_OI_CHANGE_PCT = 1.0;
const MIN_PREMIUM_CHANGE_PCT = 2.0;
const MIN_PREMIUM_CHANGE_POINTS = 0.05;

function signBucket(value, thresholdPct = 0) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < thresholdPct) return 0;
  return value > 0 ? 1 : -1;
}

function classifyOptionFlow(option, type, underlyingChangePct = null) {
  if (!option) return { type, state: 'UNAVAILABLE', confidence: 0, available: false };

  const oi = Number(option.oi);
  const prevOI = Number(option.prevOI);
  const ltp = Number(option.ltp);
  const close = Number(option.closePrice);

  if (![oi, prevOI, ltp, close].every(Number.isFinite) || prevOI <= 0 || close <= 0) {
    return {
      type,
      state: 'UNAVAILABLE',
      confidence: 0,
      available: false,
      reason: 'Missing current/previous OI or premium baseline'
    };
  }

  const oiChange = oi - prevOI;
  const oiChangePct = (oiChange / prevOI) * 100;
  const premiumChange = ltp - close;
  const premiumChangePct = (premiumChange / close) * 100;

  const oiDir = signBucket(oiChange, MIN_OI_CHANGE_PCT);
  const premiumDir = Math.abs(premiumChange) >= MIN_PREMIUM_CHANGE_POINTS
    ? signBucket(premiumChange, MIN_PREMIUM_CHANGE_PCT)
    : 0;

  const optionName = type === 'CE' ? 'CALL' : 'PUT';
  let state = 'MIXED';
  if (oiDir > 0 && premiumDir < 0) state = optionName + '_WRITING';
  else if (oiDir > 0 && premiumDir > 0) state = optionName + '_BUYING';
  else if (oiDir < 0 && premiumDir > 0) state = optionName + '_SHORT_COVERING';
  else if (oiDir < 0 && premiumDir < 0) state = optionName + '_LONG_UNWINDING';

  const underlyingDir = signBucket(Number(underlyingChangePct), 0.10);
  const mechanicallyAligned =
    (type === 'CE' && underlyingDir > 0 && premiumDir > 0) ||
    (type === 'CE' && underlyingDir < 0 && premiumDir < 0) ||
    (type === 'PE' && underlyingDir < 0 && premiumDir > 0) ||
    (type === 'PE' && underlyingDir > 0 && premiumDir < 0);

  let confidence = 35;
  if (oiDir !== 0) confidence += 20;
  if (premiumDir !== 0) confidence += 20;
  if (mechanicallyAligned) confidence += 15;
  if (Math.abs(oiChangePct) >= 5) confidence += 5;
  if (Math.abs(premiumChangePct) >= 5) confidence += 5;
  confidence = Math.max(0, Math.min(100, confidence));

  return {
    type,
    state,
    confidence,
    available: state !== 'MIXED',
    oi,
    prevOI,
    oiChange,
    oiChangePct: Number(oiChangePct.toFixed(2)),
    premium: ltp,
    previousClose: close,
    premiumChange: Number(premiumChange.toFixed(2)),
    premiumChangePct: Number(premiumChangePct.toFixed(2)),
    underlyingChangePct: Number.isFinite(Number(underlyingChangePct))
      ? Number(Number(underlyingChangePct).toFixed(2))
      : null,
    evidence: {
      oiDirection: oiDir > 0 ? 'UP' : oiDir < 0 ? 'DOWN' : 'FLAT',
      premiumDirection: premiumDir > 0 ? 'UP' : premiumDir < 0 ? 'DOWN' : 'FLAT',
      underlyingAlignment: mechanicallyAligned ? 'ALIGNED' : 'NOT_ALIGNED_OR_UNAVAILABLE'
    }
  };
}

const FLOW_DIRECTION_SCORE = {
  PUT_WRITING: 1,
  CALL_BUYING: 1,
  CALL_SHORT_COVERING: 1,
  PUT_LONG_UNWINDING: 1,
  CALL_WRITING: -1,
  PUT_BUYING: -1,
  PUT_SHORT_COVERING: -1,
  CALL_LONG_UNWINDING: -1
};

function aggregateFlow(rows) {
  let bullishWeight = 0;
  let bearishWeight = 0;
  const counts = {};

  for (const row of rows) {
    if (!row || !row.available || !FLOW_DIRECTION_SCORE[row.state]) continue;
    const weight = Math.min(25, Math.max(1, Math.abs(Number(row.oiChange) || 0)));
    if (FLOW_DIRECTION_SCORE[row.state] > 0) bullishWeight += weight;
    else bearishWeight += weight;
    counts[row.state] = (counts[row.state] || 0) + 1;
  }

  const total = bullishWeight + bearishWeight;
  const score = total ? Math.round(((bullishWeight - bearishWeight) / total) * 25) : 0;

  return {
    score,
    label: score >= 10 ? 'BULLISH_FLOW' : score <= -10 ? 'BEARISH_FLOW' : 'MIXED_FLOW',
    bullishWeight: Number(bullishWeight.toFixed(1)),
    bearishWeight: Number(bearishWeight.toFixed(1)),
    classifiedContracts: Object.values(counts).reduce((n, x) => n + x, 0),
    counts
  };
}

function classifyOptionChainFlow(strikes, underlyingChangePct = null) {
  const rows = [];
  for (const strike of strikes || []) {
    rows.push({
      strike: strike.strike,
      call: classifyOptionFlow({
        oi: strike.ceOI,
        prevOI: strike.cePrevOI,
        ltp: strike.ceLTP,
        closePrice: strike.ceClosePrice
      }, 'CE', underlyingChangePct),
      put: classifyOptionFlow({
        oi: strike.peOI,
        prevOI: strike.pePrevOI,
        ltp: strike.peLTP,
        closePrice: strike.peClosePrice
      }, 'PE', underlyingChangePct)
    });
  }

  const flat = rows.flatMap(r => [r.call, r.put]);
  const aggregate = aggregateFlow(flat);

  return {
    methodology: 'INFERRED_FROM_OI_AND_PREMIUM',
    baseline: 'PREVIOUS_SESSION_CLOSE',
    underlyingChangePct: Number.isFinite(Number(underlyingChangePct))
      ? Number(Number(underlyingChangePct).toFixed(2))
      : null,
    aggregate,
    strikes: rows
  };
}

module.exports = { classifyOptionFlow, classifyOptionChainFlow };
