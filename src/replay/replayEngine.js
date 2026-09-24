'use strict';

const { buildEntryPlan } = require('../engine/entryEngine');
const { buildRiskPlan } = require('../engine/riskEngine');
const { buildManagementPlan } = require('../engine/managementEngine');
const { buildPositionPlan } = require('../engine/positionSizingEngine');
const { buildDecisionOrchestration } = require('../engine/decisionOrchestrator');

/**
 * Deterministic replay harness.
 *
 * Input is a normalized decision snapshot captured from historical/live data.
 * It deliberately does not invent missing market data and does not fetch
 * external prices. This makes replay results reproducible.
 */
function replaySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid replay snapshot');
  }

  const marketPhase = snapshot.marketPhase || 'OPEN';
  const strategy = snapshot.strategy || 'WAIT';
  const regime = snapshot.regime || { direction: 'NEUTRAL' };
  const tradeLegs = snapshot.tradeLegs || null;

  const setup = snapshot.setup || {
    qualified: strategy !== 'WAIT' && !!tradeLegs && marketPhase === 'OPEN',
    blockers: []
  };

  const entry = snapshot.entry || buildEntryPlan({
    strategy,
    spot: snapshot.spot,
    support: snapshot.support,
    resistance: snapshot.resistance,
    ceWall: snapshot.ceWall,
    peWall: snapshot.peWall,
    expectedMove: snapshot.expectedMove,
    tradeLegs,
    regime,
    features: snapshot.features || {},
    marketPhase,
    dte: snapshot.dte
  });

  const risk = snapshot.risk || buildRiskPlan({
    strategy,
    tradeLegs,
    spot: snapshot.spot,
    support: snapshot.support,
    resistance: snapshot.resistance,
    peWall: snapshot.peWall,
    ceWall: snapshot.ceWall,
    expectedMove: snapshot.expectedMove,
    marketPhase,
    dte: snapshot.dte
  });

  const management = snapshot.management || buildManagementPlan({
    strategy,
    risk,
    entry,
    regime,
    spot: snapshot.spot
  });

  const account = snapshot.account || {};
  const position = snapshot.position || buildPositionPlan({
    strategy,
    tradeLegs,
    risk,
    account,
    marketPhase,
    dailyLossRupees: snapshot.dailyLossRupees || 0,
    openRiskRupees: snapshot.openRiskRupees || 0
  });

  const orchestration = snapshot.orchestration || buildDecisionOrchestration({
    strategy,
    setup,
    entry,
    risk,
    management,
    position,
    marketPhase,
    regime
  });

  return {
    id: snapshot.id || null,
    timestamp: snapshot.timestamp || null,
    status: orchestration.status,
    executionAllowed: orchestration.executionAllowed,
    strategy,
    entryStatus: entry.status,
    riskStatus: risk.status,
    positionStatus: position.status,
    blockers: orchestration.blockers,
    gates: orchestration.gates
  };
}

function runReplay(snapshots) {
  if (!Array.isArray(snapshots)) throw new Error('Replay input must be an array');

  const results = snapshots.map(replaySnapshot);
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    count: results.length,
    executionAllowedCount: results.filter(r => r.executionAllowed).length,
    counts,
    results
  };
}

module.exports = { replaySnapshot, runReplay };
