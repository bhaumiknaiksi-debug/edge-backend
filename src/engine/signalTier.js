'use strict';

/**
 * Research-only signal journey.
 *
 * Tier A mirrors the existing authoritative READY_TO_EXECUTE gate exactly.
 * Tiers B/C expose near-ready/developing states for observation and outcome
 * research only. They MUST NOT authorize execution or alter live logic.
 */

function directionFamily(direction) {
  const d = String(direction || '');
  if (d.includes('BULL')) return 'BULLISH';
  if (d.includes('BEAR')) return 'BEARISH';
  if (d === 'NEUTRAL') return 'NEUTRAL';
  return 'UNAVAILABLE';
}

function chartAgreement(regime, chart) {
  const r = directionFamily(regime?.direction);
  const c = chart?.verdict || 'UNAVAILABLE';
  if (r === 'UNAVAILABLE' || c === 'UNAVAILABLE' || c === 'NEUTRAL' || c === 'CONFLICTED') return 'UNRESOLVED';
  if (r === 'NEUTRAL') return 'UNRESOLVED';
  return r === c ? 'AGREES' : 'CONTRADICTS';
}

function buildSignalTier({ orchestration, setup, entry, risk, position, strategy, regime, marketPhase, chartIntelligence }) {
  const authoritativeReady = orchestration?.status === 'READY_TO_EXECUTE';
  const rangeStrategy = strategy === 'IRON_CONDOR' || strategy === 'IRON_BUTTERFLY';
  const regimeReady = !!regime?.direction && (rangeStrategy || regime.direction !== 'NEUTRAL');
  const strategyReady = !!strategy && strategy !== 'WAIT';
  const setupReady = setup?.qualified === true;
  const riskReady = risk?.status === 'READY';
  const positionReady = position?.status === 'READY';
  const marketReady = marketPhase === 'OPEN';
  const triggerReady = entry?.triggerReady === true;
  const priceReady = entry?.priceReady === true;
  const liquidityReady = entry?.liquidityReady === true;
  const agreement = chartAgreement(regime, chartIntelligence);
  const entryPassCount = [triggerReady, priceReady, liquidityReady].filter(Boolean).length;
  const coreReady = regimeReady && strategyReady && setupReady && riskReady && positionReady && marketReady;

  let tier = 'OBSERVING';
  let label = 'OBSERVING';
  let explanation = 'No research-tier signal yet.';

  if (authoritativeReady) {
    tier = 'A';
    label = 'EXECUTION_READY';
    explanation = 'Existing authoritative execution gate is fully satisfied.';
  } else if (coreReady && entryPassCount >= 2 && agreement === 'AGREES') {
    tier = 'B';
    label = 'STRONG_CANDIDATE';
    explanation = 'Core gates pass, chart structure agrees, and at least two of trigger/price/liquidity are ready.';
  } else if (marketReady && regimeReady && strategyReady && (setupReady || agreement === 'AGREES')) {
    tier = 'C';
    label = 'DEVELOPING';
    explanation = 'Directional/strategy structure exists, but execution readiness is incomplete.';
  }

  const failed = [];
  if (!regimeReady) failed.push('REGIME');
  if (!strategyReady) failed.push('STRATEGY');
  if (!setupReady) failed.push('SETUP');
  if (!triggerReady) failed.push('TRIGGER');
  if (!priceReady) failed.push('PRICE');
  if (!liquidityReady) failed.push('LIQUIDITY');
  if (!riskReady) failed.push('RISK');
  if (!positionReady) failed.push('POSITION');
  if (!marketReady) failed.push('MARKET');

  return {
    version: 'SIGNAL_TIER_V1',
    tier,
    label,
    researchOnly: tier !== 'A',
    liveDecisionImpact: false,
    executionAllowed: authoritativeReady,
    notProbability: true,
    explanation,
    chartAgreement: agreement,
    entryPassCount,
    failedGates: failed,
    gates: {
      regime: regimeReady,
      strategy: strategyReady,
      setup: setupReady,
      trigger: triggerReady,
      price: priceReady,
      liquidity: liquidityReady,
      risk: riskReady,
      position: positionReady,
      market: marketReady
    }
  };
}

module.exports = { buildSignalTier, chartAgreement, directionFamily };
