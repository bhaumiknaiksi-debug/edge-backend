'use strict';

/**
 * Setup qualification is intentionally separate from market regime.
 * A directional view is not automatically a trade.
 */
function qualifySetup({ regime, strategy, tradeLegs, marketPhase }) {
  const blockers = [];
  if (!regime || regime.direction === 'NEUTRAL') blockers.push('NO_DIRECTIONAL_EDGE');
  if (!strategy || strategy === 'WAIT') blockers.push('NO_STRATEGY');
  if (strategy !== 'WAIT' && !tradeLegs) blockers.push('INCOMPLETE_LEGS');
  if (marketPhase && marketPhase !== 'OPEN') blockers.push('MARKET_NOT_OPEN');
  if (regime && regime.evidenceCoverage < 50) blockers.push('LOW_DATA_COVERAGE');

  const qualified = blockers.length === 0;
  return {
    qualified,
    action: qualified ? 'WAIT_FOR_ENTRY' : 'NO_TRADE',
    blockers
  };
}

module.exports = { qualifySetup };
