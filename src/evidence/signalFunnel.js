'use strict';

function primitiveGates(row) {
  const o = row?.orchestration || {};
  const g = o.gates || {};
  const e = row?.entry || {};
  return {
    market: g.market === true,
    regime: g.regime === true,
    strategy: g.strategy === true,
    setup: g.setup === true,
    trigger: e.triggerReady === true,
    price: e.priceReady === true,
    liquidity: e.liquidityReady === true,
    risk: g.risk === true,
    position: g.position === true
  };
}

const ORDER = ['market','regime','strategy','setup','trigger','price','liquidity','risk','position'];

function dayKey(ts) {
  if (!ts) return 'UNKNOWN';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(ts));
  } catch (_) {
    return String(ts).slice(0, 10);
  }
}

function buildSignalFunnel(rows = []) {
  const polls = (rows || []).filter(r => (r.recordType || 'POLL_SNAPSHOT') === 'POLL_SNAPSHOT');
  const stages = { observations: polls.length };
  let survivors = polls.slice();
  for (const gate of ORDER) {
    survivors = survivors.filter(r => primitiveGates(r)[gate]);
    stages[gate] = survivors.length;
  }
  stages.ready = polls.filter(r => r?.orchestrationStatus === 'READY_TO_EXECUTE' || r?.orchestration?.status === 'READY_TO_EXECUTE').length;

  const independentGatePass = {};
  for (const gate of ORDER) independentGatePass[gate] = polls.filter(r => primitiveGates(r)[gate]).length;

  const rejectionReasons = {};
  for (const row of polls) {
    const blockers = row?.orchestration?.blockers || [];
    for (const b of blockers) rejectionReasons[b] = (rejectionReasons[b] || 0) + 1;
    const gates = primitiveGates(row);
    if (!gates.trigger) rejectionReasons.TRIGGER_NOT_READY = (rejectionReasons.TRIGGER_NOT_READY || 0) + 1;
    if (!gates.price) rejectionReasons.PRICE_NOT_READY = (rejectionReasons.PRICE_NOT_READY || 0) + 1;
    if (!gates.liquidity) rejectionReasons.LIQUIDITY_NOT_READY = (rejectionReasons.LIQUIDITY_NOT_READY || 0) + 1;
  }

  const nearReady = [];
  for (const row of polls) {
    const gates = primitiveGates(row);
    const failed = ORDER.filter(k => !gates[k]);
    if (failed.length === 1) {
      nearReady.push({
        timestamp: row.timestamp,
        strategy: row.strategy || null,
        missingGate: failed[0],
        orchestrationStatus: row.orchestrationStatus || row?.orchestration?.status || null,
        signalTier: row?.signalTier?.tier || null
      });
    }
  }

  const tierCounts = { A:0, B:0, C:0, OBSERVING:0, UNAVAILABLE:0 };
  for (const row of polls) {
    const t = row?.signalTier?.tier;
    if (Object.prototype.hasOwnProperty.call(tierCounts, t)) tierCounts[t]++;
    else tierCounts.UNAVAILABLE++;
  }

  const byDay = {};
  for (const row of polls) {
    const d = dayKey(row.timestamp);
    if (!byDay[d]) byDay[d] = { date:d, observations:0, A:0, B:0, C:0, observing:0, ready:0 };
    const x = byDay[d];
    x.observations++;
    const t = row?.signalTier?.tier;
    if (t === 'A' || t === 'B' || t === 'C') x[t]++;
    else x.observing++;
    if (row.orchestrationStatus === 'READY_TO_EXECUTE' || row?.orchestration?.status === 'READY_TO_EXECUTE') x.ready++;
  }

  return {
    version: 'SIGNAL_FUNNEL_V1',
    researchOnly: true,
    liveDecisionImpact: false,
    methodology: 'Descriptive gate/rejection audit. Counts are observations, not independent trades.',
    stages,
    independentGatePass,
    tierCounts,
    nearReadyCount: nearReady.length,
    nearReady: nearReady.slice(-100),
    topRejections: Object.entries(rejectionReasons)
      .map(([reason,count]) => ({ reason, count }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 20),
    byDay: Object.values(byDay).sort((a,b) => a.date.localeCompare(b.date))
  };
}

module.exports = { buildSignalFunnel, primitiveGates };
