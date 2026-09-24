'use strict';

/**
 * Risk engine.
 *
 * Converts an already-selected option structure into a deterministic,
 * quote/structure-aware risk plan. It does not size positions and it does
 * not predict prices. Missing market inputs remain unavailable.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(v.toFixed(dp));
}

function positive(v) {
  return v !== null && v > 0;
}

function creditStructure(tradeLegs) {
  if (!tradeLegs) return null;

  if (tradeLegs.sellLeg && tradeLegs.buyLeg) {
    const short = n(tradeLegs.sellLeg.strike);
    const long = n(tradeLegs.buyLeg.strike);
    const credit = n(tradeLegs.netCredit);
    if (short === null || long === null || credit === null) return null;
    const width = Math.abs(long - short);
    if (!positive(width) || !positive(credit)) return null;
    return {
      credit,
      width,
      maxLoss: Math.max(0, width - credit),
      direction: tradeLegs.sellLeg.type === 'CE' ? 'BEARISH' : 'BULLISH',
      shortStrike: short,
      longStrike: long,
      breakeven: n(tradeLegs.breakeven)
    };
  }

  if (tradeLegs.ceShort && tradeLegs.ceLong && tradeLegs.peShort && tradeLegs.peLong) {
    const credit = n(tradeLegs.netCredit);
    const ceWidth = n(tradeLegs.ceLong.strike) - n(tradeLegs.ceShort.strike);
    const peWidth = n(tradeLegs.peShort.strike) - n(tradeLegs.peLong.strike);
    if (!positive(credit) || !positive(ceWidth) || !positive(peWidth)) return null;
    return {
      credit,
      width: Math.max(ceWidth, peWidth),
      maxLoss: Math.max(ceWidth, peWidth) - credit,
      direction: 'RANGE',
      ceShort: n(tradeLegs.ceShort.strike),
      ceLong: n(tradeLegs.ceLong.strike),
      peShort: n(tradeLegs.peShort.strike),
      peLong: n(tradeLegs.peLong.strike),
      breakevenLow: n(tradeLegs.breakevenLow),
      breakevenHigh: n(tradeLegs.breakevenHigh)
    };
  }

  return null;
}

function creditRisk(strategy, tradeLegs) {
  const s = creditStructure(tradeLegs);
  if (!s) return null;

  // Risk control is expressed in current spread debit. The stop is at
  // 50% of defined maximum loss beyond the entry credit, while targets
  // capture 50% and 75% of the collected credit. These are management
  // rules, not forecasts.
  const stopDebit = Math.min(s.width, s.credit + s.maxLoss * 0.50);
  const target1Debit = Math.max(0, s.credit * 0.50);
  const target2Debit = Math.max(0, s.credit * 0.25);

  const riskPoints = Math.max(0, stopDebit - 0);
  const reward1 = Math.max(0, s.credit - target1Debit);
  const reward2 = Math.max(0, s.credit - target2Debit);

  const plan = {
    model: 'DEFINED_RISK_CREDIT',
    entryCredit: round(s.credit),
    maxLossPoints: round(s.maxLoss),
    stop: {
      type: 'SPREAD_DEBIT',
      value: round(stopDebit),
      rule: 'Exit if the spread debit reaches the defined-risk management stop.'
    },
    target1: {
      type: 'SPREAD_DEBIT',
      value: round(target1Debit),
      profitPoints: round(reward1),
      rule: 'Take partial profit after 50% of entry credit has been captured.'
    },
    target2: {
      type: 'SPREAD_DEBIT',
      value: round(target2Debit),
      profitPoints: round(reward2),
      rule: 'Exit remaining risk after 75% of entry credit has been captured.'
    },
    rrTarget1: riskPoints > 0 ? round(reward1 / riskPoints) : null,
    rrTarget2: riskPoints > 0 ? round(reward2 / riskPoints) : null,
    breakeven: strategy === 'IRON_CONDOR'
      ? { low: s.breakevenLow, high: s.breakevenHigh }
      : { value: s.breakeven },
    structure: strategy === 'IRON_CONDOR'
      ? { ceShort: s.ceShort, ceLong: s.ceLong, peShort: s.peShort, peLong: s.peLong }
      : { shortStrike: s.shortStrike, longStrike: s.longStrike }
  };

  return plan;
}

function directionalRisk(strategy, tradeLegs, context) {
  const entry = n(tradeLegs?.buyLeg?.premium);
  const delta = Math.abs(n(tradeLegs?.legDelta));
  const spot = n(context?.spot);
  if (!positive(entry) || delta === null || spot === null) return null;

  const support = n(context?.support);
  const resistance = n(context?.resistance);
  const emLow = n(context?.expectedMove?.low);
  const emHigh = n(context?.expectedMove?.high);
  const peWall = n(context?.peWall);
  const ceWall = n(context?.ceWall);

  const invalidation = strategy === 'LONG_CALL'
    ? [support, peWall].filter(v => v !== null && v < spot).sort((a, b) => b - a)[0]
    : [resistance, ceWall].filter(v => v !== null && v > spot).sort((a, b) => a - b)[0];

  const target1 = strategy === 'LONG_CALL'
    ? [emHigh, ceWall].filter(v => v !== null && v > spot).sort((a, b) => a - b)[0]
    : [emLow, peWall].filter(v => v !== null && v < spot).sort((a, b) => b - a)[0];

  const target2 = strategy === 'LONG_CALL'
    ? [emHigh, ceWall].filter(v => v !== null && v > spot).sort((a, b) => b - a)[0]
    : [emLow, peWall].filter(v => v !== null && v < spot).sort((a, b) => a - b)[0];

  if (invalidation === undefined || target1 === undefined || target2 === undefined) return null;

  const stopPremium = Math.max(0.05, entry - delta * Math.abs(spot - invalidation));
  const target1Premium = entry + delta * Math.abs(target1 - spot);
  const target2Premium = Math.max(target1Premium, entry + delta * Math.abs(target2 - spot));
  const riskPoints = Math.max(0, entry - stopPremium);

  return {
    model: 'STRUCTURE_DELTA',
    entryPremium: round(entry),
    stop: {
      type: 'PREMIUM',
      value: round(stopPremium),
      rule: 'Exit if option premium reaches the structure-derived stop or the underlying invalidation is breached.',
      underlying: invalidation
    },
    target1: {
      type: 'PREMIUM',
      value: round(target1Premium),
      underlying: target1,
      rule: 'Take partial profit at the first structural objective.'
    },
    target2: {
      type: 'PREMIUM',
      value: round(target2Premium),
      underlying: target2,
      rule: 'Exit remaining position at the second structural objective.'
    },
    rrTarget1: riskPoints > 0 ? round((target1Premium - entry) / riskPoints) : null,
    rrTarget2: riskPoints > 0 ? round((target2Premium - entry) / riskPoints) : null
  };
}

function buildRiskPlan({ strategy, tradeLegs, spot, support, resistance, peWall, ceWall, expectedMove, marketPhase, dte }) {
  if (!strategy || strategy === 'WAIT' || !tradeLegs) {
    return {
      status: 'UNAVAILABLE',
      reason: 'No qualified trade structure.'
    };
  }

  if (marketPhase !== 'OPEN') {
    return {
      status: 'CONDITIONAL',
      reason: 'Risk plan is defined but market is not OPEN; no live execution should occur.',
      marketPhase
    };
  }

  if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    const plan = creditRisk(strategy, tradeLegs);
    if (!plan) return { status: 'UNAVAILABLE', reason: 'Insufficient quote/structure data for credit risk.' };
    return {
      status: 'READY',
      ...plan,
      maxHoldMinutes: strategy === 'IRON_CONDOR' ? 150 : (dte <= 0 ? 60 : 120)
    };
  }

  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    const plan = directionalRisk(strategy, tradeLegs, {
      spot, support, resistance, peWall, ceWall, expectedMove
    });
    if (!plan) return { status: 'UNAVAILABLE', reason: 'Insufficient structural data for directional risk.' };
    return {
      status: 'READY',
      ...plan,
      maxHoldMinutes: dte <= 0 ? 60 : 90
    };
  }

  return { status: 'UNAVAILABLE', reason: 'Strategy has no risk model.' };
}

module.exports = { buildRiskPlan };
