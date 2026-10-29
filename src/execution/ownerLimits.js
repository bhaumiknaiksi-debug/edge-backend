'use strict';
// The owner's limits, read straight from the saved sandbox policy, independent of whether the sandbox worker runs.
// No valid, fresh limits means no approvals: there is no fallback to wider numbers.
const { createHash } = require('node:crypto');
const ok = (x, max) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max;

function limitsFromPolicy(p) {
  if (!p || !ok(p.capital, 1000000) || !ok(p.dailyLoss, 100000) || !ok(p.perTradeRisk, 100000)) return null;
  const costReserve = typeof p.costReserve === 'number' && Number.isFinite(p.costReserve) && p.costReserve >= 0 ? p.costReserve : null;
  if (costReserve === null) return null;
  const limits = { capital: p.capital, daily: p.dailyLoss, perTrade: Math.min(p.perTradeRisk, p.dailyLoss), costReserve, source: 'SANDBOX_POLICY' };
  limits.version = createHash('sha256').update(JSON.stringify([limits.capital, limits.daily, limits.perTrade, limits.costReserve])).digest('hex').slice(0, 16);
  return limits;
}

// read: async () => sandbox state (with .policy). onChange fires when the version changes after the first load.
function createOwnerLimits({ read, now = Date.now, maxAgeMs = 60000, onChange = () => {} } = {}) {
  let current = null, loadedAt = 0, error = 'OWNER_LIMITS_NOT_LOADED';
  function accept(policy) {
    const next = limitsFromPolicy(policy);
    if (!next) { const had = !!current; current = null; error = 'OWNER_LIMITS_INVALID'; if (had) onChange(null); return null; }
    const previous = current; current = next; loadedAt = now(); error = null;
    if (previous && previous.version !== next.version) onChange(next);
    return next;
  }
  async function refresh() {
    try { return accept((await read())?.policy); }
    catch (_) { error = 'OWNER_LIMITS_UNAVAILABLE'; return null; }
  }
  // Fresh limits or null. A stale copy is never used to approve anything.
  function get() { return current && now() - loadedAt <= maxAgeMs ? current : null; }
  return { refresh, set: accept, get, status: () => ({ loaded: !!current, fresh: !!get(), loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null, error, version: current?.version || null }) };
}
module.exports = { createOwnerLimits, limitsFromPolicy };
