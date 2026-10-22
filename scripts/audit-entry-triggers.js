'use strict';
// Diagnostic only: no server imports, network requests, orders, or state writes.
const assert = require('node:assert/strict');
const { buildEntryPlan } = require('../src/engine/entryEngine');
const strikes = Array.from({ length: 121 }, (_, i) => 20000 + i * 50);
function movingLevels(spot) {
  const atm = strikes.reduce((best, strike, i) => {
    const distance = Math.abs(strike - spot);
    return distance < best.distance ? { i, distance } : best;
  }, { i: 0, distance: Infinity }).i;
  return { support: strikes[Math.max(0, atm - 3)], resistance: strikes[Math.min(strikes.length - 1, atm + 3)] };
}
function evaluate(strategy, spot, levels, momentum = true) {
  const bullish = strategy === 'LONG_CALL' || strategy === 'BULL_CALL_SPREAD';
  const direction = bullish ? 1 : -1;
  return buildEntryPlan({
    strategy, spot, ...levels, marketPhase: 'OPEN', dte: 6,
    regime: { direction: bullish ? 'BULLISH' : 'BEARISH' },
    features: { trend30mPct: momentum ? direction * 0.25 : 0,
      sessionChangePct: momentum ? direction : 0,
      optionFlow: { aggregate: { label: 'MIXED_FLOW' } } },
    tradeLegs: { buyLeg: { bid: 100, ask: 101, premium: 100.5 },
      sellLeg: { bid: 50, ask: 51, premium: 50.5 }, netDebit: 50 }
  });
}
const results = [];
for (const strategy of ['LONG_CALL', 'BULL_CALL_SPREAD', 'LONG_PUT', 'BEAR_PUT_SPREAD']) {
  let samples = 0, movingReady = 0;
  for (let spot = 21000; spot <= 25000; spot += 5) {
    const plan = evaluate(strategy, spot, movingLevels(spot));
    assert.equal(plan.priceReady, true);
    assert.equal(plan.liquidityReady, true);
    assert.equal(plan.evidence.momentum, true);
    movingReady += Number(plan.triggerReady);
    samples++;
  }
  assert.equal(movingReady, 0, 'Current ATM-offset levels should reproduce starvation');
  // Control proves the trigger engine can fire when a level stays fixed.
  // This is NOT a recommendation to use these arbitrary anchors in production.
  const bullish = strategy === 'LONG_CALL' || strategy === 'BULL_CALL_SPREAD';
  const fixed = movingLevels(23000);
  const crossedSpot = bullish ? fixed.resistance + 5 : fixed.support - 5;
  assert.equal(evaluate(strategy, 23000, fixed).triggerReady, false);
  assert.equal(evaluate(strategy, crossedSpot, fixed).triggerReady, true);
  assert.equal(evaluate(strategy, crossedSpot, fixed, false).triggerReady, false);
  results.push({ strategy, samples, movingReady, fixedAnchorControl: 'PASS', momentumControl: 'PASS' });
}
console.table(results);
console.log('Confirmed current defect: 3,204 interior-chain evaluations cannot cross recentered ATM-offset levels.');
console.log('Diagnostic reproduces current behavior; it is not a passing specification for the eventual fix.');
