'use strict';
// The owner's limits, read straight from the saved sandbox policy, independent of whether the sandbox worker runs.
// No valid, fresh limits means no approvals: there is no fallback to wider numbers.
//
// Every approval is stamped with the limits it was computed under (token). It may be published or served only while
// those exact limits are still the current, fresh ones (valid / servable). This is the safety net: even if some path
// forgets to invalidate a cached result, a READY computed under other or expired limits is never served.
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

// read: async () => sandbox state (with .policy). onChange(limits|null) fires whenever usable limits change or are lost.
function createOwnerLimits({ read, now = Date.now, maxAgeMs = 60000, onChange = () => {} } = {}) {
  let current = null, loadedAt = 0, error = 'OWNER_LIMITS_NOT_LOADED';
  let generation = 0; // bumps whenever the usable limits change or are lost; tokens from an older generation are void
  let writes = 0;     // bumps on every direct set(); a refresh that started before a set() is discarded
  function install(next, why) {
    const previous = current;
    if (!next) {
      current = null; error = why;
      if (previous) { generation++; onChange(null); }
      return null;
    }
    current = next; loadedAt = now(); error = null;
    if (!previous || previous.version !== next.version) { generation++; if (previous) onChange(next); }
    return next;
  }
  // A saved policy, from the route that just committed it. Always wins over any read already in flight.
  function set(policy) { writes++; return install(limitsFromPolicy(policy), 'OWNER_LIMITS_INVALID'); }
  async function refresh() {
    const startedAt = writes;
    let state;
    try { state = await read(); }
    catch (_) {
      if (startedAt !== writes) return get(); // a newer saved policy already superseded this read
      return install(null, 'OWNER_LIMITS_UNAVAILABLE'); // a failed read never leaves old limits approving
    }
    if (startedAt !== writes) return get(); // stale read: the owner saved new limits meanwhile
    return install(limitsFromPolicy(state?.policy), 'OWNER_LIMITS_INVALID');
  }
  // Fresh limits or null. A stale copy is never used to approve anything.
  function get() { return current && now() - loadedAt <= maxAgeMs ? current : null; }
  // Stamp for an analysis: the limits it computes under.
  function token() { const l = get(); return l ? { version: l.version, generation } : null; }
  // Are the limits behind this stamp still the current, fresh ones?
  function valid(t) { const l = get(); return !!t && !!l && t.version === l.version && t.generation === generation; }
  // May this result be published or served? Anything that is not READY_TO_EXECUTE needs no limits.
  function servable(result) {
    if (result?.decision?.orchestration?.status !== 'READY_TO_EXECUTE') return true;
    return valid(result.decision.limitsToken);
  }
  // The result as any outlet may use it: unchanged unless it is a READY whose limits stamp is no longer valid,
  // in which case there is no current approval at all.
  function approvedOnly(result) { return result && servable(result) ? result : null; }
  return { refresh, set, get, token, valid, servable, approvedOnly,
    status: () => ({ loaded: !!current, fresh: !!get(), loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null, error, version: current?.version || null, generation }) };
}
module.exports = { createOwnerLimits, limitsFromPolicy };
