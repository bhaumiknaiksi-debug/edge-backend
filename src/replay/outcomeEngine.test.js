'use strict';

const assert = require('assert');
const { evaluateOutcome } = require('./outcomeEngine');

function base(overrides = {}) {
  return {
    id: 'unit-long',
    timestamp: '2026-04-01T10:00:00+05:30',
    strategy: 'LONG_CALL',
    tradeLegs: { lotSize: 65, buyLeg: { id: 'OPT', premium: 100 } },
    risk: {
      status: 'READY',
      stop: { value: 90 },
      target1: { value: 110 },
      target2: { value: 120 },
      maxHoldMinutes: 30
    },
    orchestration: { executionAllowed: true },
    position: { recommendedLots: 1 },
    ...overrides
  };
}

const target = evaluateOutcome({
  decision: base(),
  futureCandles: [
    { instrumentKey: 'OPT', timestamp: '2026-04-01T10:05:00+05:30', open: 100, high: 112, low: 99, close: 111 },
    { instrumentKey: 'OPT', timestamp: '2026-04-01T10:10:00+05:30', open: 111, high: 123, low: 110, close: 121 }
  ]
});
assert.strictEqual(target.status, 'TARGET2');
assert.strictEqual(target.target1Hit, true);
assert.strictEqual(target.pnlRupees, 975);

const stop = evaluateOutcome({
  decision: base({ id: 'unit-stop' }),
  futureCandles: [
    { instrumentKey: 'OPT', timestamp: '2026-04-01T10:05:00+05:30', open: 100, high: 105, low: 88, close: 92 }
  ]
});
assert.strictEqual(stop.status, 'STOP');
assert.strictEqual(stop.pnlRupees, -650);

const spread = {
  id: 'unit-spread',
  timestamp: '2026-04-01T10:00:00+05:30',
  strategy: 'BULL_PUT_SPREAD',
  tradeLegs: {
    lotSize: 65,
    sellLeg: { id: 'S', type: 'PE', strike: 23000 },
    buyLeg: { id: 'L', type: 'PE', strike: 22900 },
    netCredit: 25
  },
  risk: {
    status: 'READY',
    maxLossPoints: 75,
    stop: { value: 62.5 },
    target1: { value: 12.5 },
    target2: { value: 6.25 },
    maxHoldMinutes: 30
  },
  orchestration: { executionAllowed: true },
  position: { recommendedLots: 1 }
};

const spreadTarget = evaluateOutcome({
  decision: spread,
  futureCandles: [
    { instrumentKey: 'S', timestamp: '2026-04-01T10:05:00+05:30', open: 45, high: 48, low: 40, close: 42 },
    { instrumentKey: 'L', timestamp: '2026-04-01T10:05:00+05:30', open: 20, high: 21, low: 18, close: 19 },
    { instrumentKey: 'S', timestamp: '2026-04-01T10:10:00+05:30', open: 30, high: 32, low: 25, close: 27 },
    { instrumentKey: 'L', timestamp: '2026-04-01T10:10:00+05:30', open: 18, high: 19, low: 15, close: 16 }
  ]
});
assert.strictEqual(spreadTarget.status, 'TARGET2');
assert.strictEqual(spreadTarget.target1Hit, true);
assert.strictEqual(spreadTarget.pnlRupees, 975);

const ambiguous = evaluateOutcome({
  decision: base({ id: 'unit-ambiguous' }),
  futureCandles: [
    { instrumentKey: 'OPT', timestamp: '2026-04-01T10:05:00+05:30', open: 100, high: 121, low: 89, close: 100 }
  ]
});
assert.strictEqual(ambiguous.status, 'STOP');

console.log('EDGE outcome engine tests passed');
