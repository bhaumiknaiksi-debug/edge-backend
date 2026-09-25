'use strict';

/**
 * Phase 8 — Decision Orchestrator.
 *
 * One authoritative gate for the complete execution pipeline:
 * regime -> strategy -> setup -> entry -> risk -> management -> position.
 *
 * It does not create a signal. It only reconciles the outputs already
 * produced by the individual engines and prevents a partial pipeline from
 * being presented as executable.
 */

function buildDecisionOrchestration({
  strategy,
  setup,
  entry,
  risk,
  management,
  position,
  marketPhase,
  regime
}) {
  const blockers = [];

  const rangeStrategy = strategy === 'IRON_CONDOR' || strategy === 'IRON_BUTTERFLY';
  if (!regime || !regime.direction || (!rangeStrategy && regime.direction === 'NEUTRAL')) {
    blockers.push('NO_REGIME_EDGE');
  }

  if (!setup?.qualified) {
    blockers.push(...(setup?.blockers || ['SETUP_NOT_QUALIFIED']));
  }

  if (!strategy || strategy === 'WAIT') {
    blockers.push('NO_STRATEGY');
  }

  if (!entry || entry.status === 'NO_ENTRY') {
    blockers.push('ENTRY_UNAVAILABLE');
  } else if (entry.status === 'WAIT_FOR_PRICE') {
    blockers.push('ENTRY_PRICE_NOT_ACCEPTABLE');
  } else if (entry.status !== 'READY_TO_ENTER') {
    blockers.push('ENTRY_TRIGGER_NOT_CONFIRMED');
  }

  if (!risk || risk.status !== 'READY') {
    blockers.push('RISK_NOT_READY');
  }

  if (!position || position.status !== 'READY') {
    blockers.push(position?.status === 'BLOCKED'
      ? 'POSITION_SIZE_BLOCKED'
      : 'POSITION_SIZE_UNAVAILABLE');
  }

  if (marketPhase !== 'OPEN') {
    blockers.push('MARKET_NOT_OPEN');
  }

  const uniqueBlockers = [...new Set(blockers)];

  let status = 'NO_TRADE';
  if (uniqueBlockers.length === 0) {
    status = 'READY_TO_EXECUTE';
  } else if (
    setup?.qualified &&
    entry?.status === 'WAIT_FOR_TRIGGER' &&
    risk?.status === 'READY' &&
    position?.status === 'READY' &&
    marketPhase === 'OPEN'
  ) {
    status = 'WAIT_FOR_TRIGGER';
  } else if (
    setup?.qualified &&
    entry?.status === 'WAIT_FOR_PRICE' &&
    risk?.status === 'READY' &&
    position?.status === 'READY' &&
    marketPhase === 'OPEN'
  ) {
    status = 'WAIT_FOR_PRICE';
  } else if (
    setup?.qualified &&
    position?.status === 'BLOCKED'
  ) {
    status = 'POSITION_BLOCKED';
  } else if (marketPhase !== 'OPEN') {
    status = 'MARKET_CLOSED';
  }

  const executionAllowed = status === 'READY_TO_EXECUTE';

  return {
    status,
    executionAllowed,
    blockers: uniqueBlockers,
    gates: {
      regime: !!regime && (rangeStrategy || regime.direction !== 'NEUTRAL'),
      strategy: !!strategy && strategy !== 'WAIT',
      setup: !!setup?.qualified,
      entry: entry?.status === 'READY_TO_ENTER',
      risk: risk?.status === 'READY',
      management: management?.status === 'READY',
      position: position?.status === 'READY',
      market: marketPhase === 'OPEN'
    },
    summary: executionAllowed
      ? 'All decision gates are satisfied.'
      : 'One or more decision gates are not satisfied; no execution should occur.'
  };
}

module.exports = { buildDecisionOrchestration };
