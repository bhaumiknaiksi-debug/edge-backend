'use strict';

function round(v, dp = 4) {
  return Number(v.toFixed(dp));
}

function sum(rows, field) {
  return rows.reduce((a, r) => a + (Number(r[field]) || 0), 0);
}

function maxDrawdown(values) {
  let equity = 0, peak = 0, maxDd = 0;
  for (const v of values) {
    equity += Number(v) || 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function groupStats(rows) {
  const trades = rows.filter(r => !['NO_DATA', 'NOT_EXECUTED'].includes(r.status));
  const wins = trades.filter(r => (r.pnlRupees || 0) > 0);
  const losses = trades.filter(r => (r.pnlRupees || 0) < 0);
  const grossProfit = sum(wins, 'pnlRupees');
  const grossLoss = Math.abs(sum(losses, 'pnlRupees'));
  const avgR = trades.length ? sum(trades, 'rMultiple') / trades.length : null;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.filter(r => (r.pnlRupees || 0) === 0).length,
    winRatePct: trades.length ? round(wins.length / trades.length * 100, 2) : null,
    grossProfitRupees: round(grossProfit, 2),
    grossLossRupees: round(grossLoss, 2),
    netPnlRupees: round(sum(trades, 'pnlRupees'), 2),
    averageR: avgR === null ? null : round(avgR),
    expectancyR: avgR === null ? null : round(avgR),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    maxDrawdownRupees: round(maxDrawdown(trades.map(r => r.pnlRupees)), 2)
  };
}

function runBacktest({ decisions, outcomesByDecisionId, candleProvider, defaults = {} }) {
  if (!Array.isArray(decisions)) throw new Error('decisions must be an array');

  const { evaluateOutcome } = require('./outcomeEngine');
  const results = decisions.map(decision => {
    const candles = outcomesByDecisionId?.[decision.id] ??
      (typeof candleProvider === 'function' ? candleProvider(decision) : null);
    return {
      id: decision.id || null,
      strategy: decision.strategy || 'WAIT',
      ...evaluateOutcome({
        decision,
        futureCandles: candles,
        lotSize: defaults.lotSize,
        costsPerLot: defaults.costsPerLot,
        lots: defaults.lots,
        fillModel: defaults.fillModel
      })
    };
  });

  const executed = results.filter(r => !['NO_DATA', 'NOT_EXECUTED'].includes(r.status));
  const byStrategy = {};
  for (const r of executed) (byStrategy[r.strategy] ||= []).push(r);

  const strategyStats = {};
  for (const [strategy, rows] of Object.entries(byStrategy)) {
    strategyStats[strategy] = groupStats(rows);
  }

  return {
    metadata: {
      decisions: decisions.length,
      evaluated: executed.length,
      excludedNoData: results.filter(r => r.status === 'NO_DATA').length,
      notExecuted: results.filter(r => r.status === 'NOT_EXECUTED').length
    },
    overall: groupStats(executed),
    exits: {
      TARGET2: executed.filter(r => r.status === 'TARGET2').length,
      STOP: executed.filter(r => r.status === 'STOP').length,
      TIME_EXIT: executed.filter(r => r.status === 'TIME_EXIT').length
    },
    byStrategy: strategyStats,
    results
  };
}

module.exports = { runBacktest, groupStats, maxDrawdown };
