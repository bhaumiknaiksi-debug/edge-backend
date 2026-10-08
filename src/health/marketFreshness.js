'use strict';

// HTTP freshness guard for EDGE dashboard consumers.
// This never changes strategy generation, trade orchestration, or risk gates.
const MAX_LIVE_DATA_AGE_MS = 120000;

function isLiveDataFresh(lastFetchMs, nowMs = Date.now()) {
  const last = Number(lastFetchMs);
  if (!Number.isFinite(last) || last <= 0) return false;
  const age = nowMs - last;
  return Number.isFinite(age) && age >= -20000 && age <= MAX_LIVE_DATA_AGE_MS;
}

function dashboardAvailability(phase, lastResult, lastFetchMs, nowMs = Date.now()) {
  if (!lastResult) return { ok: false, reason: 'NO_DATA_YET' };
  if (phase === 'OPEN' && lastResult?.market?.phase !== 'OPEN') {
    return { ok: false, reason: 'NON_LIVE_MARKET_SNAPSHOT' };
  }
  if (phase === 'OPEN' && !isLiveDataFresh(lastFetchMs, nowMs)) {
    return { ok: false, reason: 'STALE_MARKET_DATA' };
  }
  return { ok: true };
}

module.exports = { MAX_LIVE_DATA_AGE_MS, isLiveDataFresh, dashboardAvailability };
