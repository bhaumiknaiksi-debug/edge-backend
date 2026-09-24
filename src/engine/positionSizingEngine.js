'use strict';

/**
 * Position sizing engine.
 *
 * Risk-first sizing only. Regime confidence is deliberately not used to
 * increase size. Account settings are supplied by the caller so the engine
 * remains stateless and reusable.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(v.toFixed(dp));
}

function maxRiskForAccount(account) {
  const capital = n(account?.capital);
  const riskPct = n(account?.maxRiskPct);
  if (capital === null || riskPct === null || capital <= 0 || riskPct <= 0) return null;
  return capital * riskPct / 100;
}

function lotRisk(strategy, tradeLegs, risk) {
  const lotSize = n(tradeLegs?.lotSize);
  if (lotSize === null || lotSize <= 0 || !risk) return null;

  if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    const maxLossPoints = n(risk.maxLossPoints);
    if (maxLossPoints === null || maxLossPoints <= 0) return null;
    return {
      points: maxLossPoints,
      rupees: maxLossPoints * lotSize
    };
  }

  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    const entry = n(risk.entryPremium);
    const stop = n(risk.stop?.value);
    if (entry === null || stop === null || entry <= stop) return null;
    return {
      points: entry - stop,
      rupees: (entry - stop) * lotSize
    };
  }

  return null;
}

function buildPositionPlan({
  strategy,
  tradeLegs,
  risk,
  account = {},
  marketPhase = 'CLOSED',
  dailyLossRupees = 0,
  openRiskRupees = 0
}) {
  if (!strategy || strategy === 'WAIT' || !tradeLegs) {
    return { status: 'UNAVAILABLE', reason: 'No qualified trade structure.' };
  }

  if (!risk || risk.status !== 'READY') {
    return { status: 'UNAVAILABLE', reason: 'Risk plan is not ready.' };
  }

  if (marketPhase !== 'OPEN') {
    return { status: 'CONDITIONAL', reason: 'Sizing is defined but market is not OPEN.', marketPhase };
  }

  const maxRisk = maxRiskForAccount(account);
  const dailyLimit = n(account?.dailyLossLimitRupees);
  const dailyLoss = Math.max(0, n(dailyLossRupees) ?? 0);
  const openRisk = Math.max(0, n(openRiskRupees) ?? 0);

  if (maxRisk === null) {
    return {
      status: 'UNAVAILABLE',
      reason: 'Account capital and maxRiskPct are required.'
    };
  }

  const dailyRemaining = dailyLimit === null
    ? Infinity
    : Math.max(0, dailyLimit - dailyLoss);

  const totalRiskRemaining = Math.max(0, maxRisk - openRisk);
  const allowedRisk = Math.min(maxRisk, dailyRemaining, totalRiskRemaining);

  const perLot = lotRisk(strategy, tradeLegs, risk);
  if (!perLot || perLot.rupees <= 0) {
    return { status: 'UNAVAILABLE', reason: 'Could not determine risk per lot.' };
  }

  const lots = Math.floor(allowedRisk / perLot.rupees);

  if (lots < 1) {
    return {
      status: 'BLOCKED',
      reason: 'One lot exceeds the currently available risk budget.',
      maxRiskRupees: round(maxRisk),
      availableRiskRupees: round(allowedRisk),
      riskPerLotRupees: round(perLot.rupees),
      recommendedLots: 0,
      actualRiskRupees: 0
    };
  }

  const actualRisk = lots * perLot.rupees;
  const riskUtilisation = allowedRisk > 0 ? (actualRisk / allowedRisk) * 100 : 0;

  return {
    status: 'READY',
    model: 'RISK_FIRST',
    recommendedLots: lots,
    lotSize: n(tradeLegs.lotSize),
    maxRiskRupees: round(maxRisk),
    availableRiskRupees: round(allowedRisk),
    riskPerLotRupees: round(perLot.rupees),
    actualRiskRupees: round(actualRisk),
    riskUtilisationPct: round(riskUtilisation),
    dailyLossRupees: round(dailyLoss),
    dailyLossLimitRupees: dailyLimit === null ? null : round(dailyLimit),
    openRiskRupees: round(openRisk),
    caps: {
      accountRisk: round(maxRisk),
      dailyRemaining: dailyLimit === null ? null : round(dailyRemaining),
      openRiskRemaining: round(totalRiskRemaining)
    },
    rule: 'Size is determined by maximum loss per lot and available risk budget; regime confidence does not increase size.'
  };
}

module.exports = { buildPositionPlan };
