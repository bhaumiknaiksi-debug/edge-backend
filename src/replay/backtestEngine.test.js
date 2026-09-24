'use strict';

const assert = require('assert');
const { runBacktest } = require('./backtestEngine');

const decisions = [
  {
    id: 'a',
    timestamp: '2026-04-01T10:00:00+05:30',
    strategy: 'LONG_CALL',
    tradeLegs: { lotSize: 65, buyLeg: { id: 'A', premium: 100 } },
    risk: { stop: { value: 90 }, target1: { value: 110 }, target2: { value: 120 }, maxHoldMinutes: 30 },
    orchestration: { executionAllowed: true },
    position: { recommendedLots: 1 }
  },
  {
    id: 'b',
    timestamp: '2026-04-01T11:00:00+05:30',
    strategy: 'LONG_PUT',
    tradeLegs: { lotSize: 65, buyLeg: { id: 'B', premium: 100 } },
    risk: { stop: { value: 90 }, target1: { value: 110 }, target2: { value: 120 }, maxHoldMinutes: 30 },
    orchestration: { executionAllowed: true },
    position: { recommendedLots: 1 }
  }
];

const report = runBacktest({
  decisions,
  outcomesByDecisionId: {
    a: [{ instrumentKey: 'A', timestamp: '2026-04-01T10:05:00+05:30', open: 100, high: 121, low: 99, close: 120 }],
    b: [{ instrumentKey: 'B', timestamp: '2026-04-01T11:05:00+05:30', open: 100, high: 105, low: 88, close: 90 }]
  }
});

assert.strictEqual(report.metadata.evaluated, 2);
assert.strictEqual(report.overall.trades, 2);
assert.strictEqual(report.exits.TARGET2, 1);
assert.strictEqual(report.exits.STOP, 1);
assert.strictEqual(report.overall.netPnlRupees, 325);

console.log('EDGE backtest engine tests passed');
