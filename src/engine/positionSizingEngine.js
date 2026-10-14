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

  if (strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD') {
    const maxLossPoints=n(risk.maxLossPoints);
    if(maxLossPoints===null||maxLossPoints<=0) return null;
    return {points:maxLossPoints,rupees:maxLossPoints*lotSize};
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
  openRiskRupees = 0,
  budget
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

  if (budget !== undefined) return ledgerPosition({strategy,tradeLegs,risk,budget});

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


function ledgerPosition({strategy,tradeLegs,risk,budget}) {
  const blocked = reason => ({status:'BLOCKED',reason,recommendedLots:0,actualRiskRupees:0});
  if (!budget || budget.error || !budget.confirmed) return blocked('Confirm today’s trade log matches your broker before entry.');
  if (budget.locked || !(budget.availableRisk > 0)) return blocked('Daily loss allowance is exhausted or reserved by open trades.');
  if (!Number.isFinite(Date.parse(budget.checkedAt)) || Date.now()-Date.parse(budget.checkedAt)>60000) return blocked('Trade log is stale. Refresh before entry.');
  const lotSize=n(tradeLegs.lotSize), perLot=lotRisk(strategy,tradeLegs,risk);
  if(!lotSize||!perLot)return blocked('Risk per lot is unavailable.');
  const debitStrategies=['LONG_CALL','LONG_PUT','BULL_CALL_SPREAD','BEAR_PUT_SPREAD'];
  if(!debitStrategies.includes(strategy))return blocked('Broker margin for this credit strategy is unverified; capital fit cannot be established.');
  const buy=n(tradeLegs.buyLeg?.ask),sell=tradeLegs.sellLeg?n(tradeLegs.sellLeg.bid):0;
  if(!(buy>0)||sell===null||buy<=sell)return blocked('Executable debit quote is unavailable.');
  const debit=buy-sell;
  // A visible conservative estimate, not a broker fee quote or guaranteed loss cap.
  const costsPerLot=100;
  const quoteRisk = strategy.startsWith('LONG_') ? (buy-n(risk.stop?.value))*lotSize : debit*lotSize;
  const riskPerLot=round(Math.max(perLot.rupees,quoteRisk)+costsPerLot);
  const capitalPerLot=round(debit*lotSize+costsPerLot);
  const riskBudget=Math.min(1000,budget.availableRisk),capitalBudget=Math.min(10000,budget.availableCapital);
  const lots=Math.floor(Math.min(riskBudget/riskPerLot,capitalBudget/capitalPerLot));
  if(lots<1)return {...blocked('One lot exceeds remaining capital or planned loss allowance.'),riskPerLotRupees:riskPerLot,capitalPerLotRupees:capitalPerLot};
  return {status:'READY',model:'MANUAL_LEDGER_RISK',recommendedLots:lots,lotSize,actualRiskRupees:round(lots*riskPerLot),riskPerLotRupees:riskPerLot,availableRiskRupees:riskBudget,capitalRequiredRupees:round(lots*capitalPerLot),availableCapitalRupees:capitalBudget,estimatedCostsRupees:costsPerLot*lots,rule:'Planned stop risk plus ₹100 per lot cost/slippage reserve. Actual fills can exceed planned loss. Manual records must include all open positions.'};
}
module.exports = { buildPositionPlan };
