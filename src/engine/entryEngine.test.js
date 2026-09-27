'use strict';

const assert = require('assert');
const { buildEntryPlan } = require('./entryEngine');
const { buildDecisionOrchestration } = require('./decisionOrchestrator');

const base = {
  spot: 23000, support: 23000, resistance: 23000, ceWall: 23200, peWall: 22800,
  features: { trend30mPct: -0.2 }, marketPhase: 'OPEN', dte: 2, minutesRemaining: 100
};
const cases = [
  ...['BEAR_CALL_SPREAD', 'BULL_PUT_SPREAD'].map(strategy => ({
    strategy, credit: true,
    features: { trend30mPct: strategy === 'BEAR_CALL_SPREAD' ? -0.2 : 0.2 },
    legs: { netCredit: 25, sellLeg: { strike: strategy === 'BEAR_CALL_SPREAD' ? 23100 : 22900, premium: 50, bid: 50, ask: 51 }, buyLeg: { premium: 25, bid: 24, ask: 26 } },
    worsen: legs => { legs.sellLeg.bid = 48; }, limit: 23.75, good: 24, bad: 22
  })),
  {
    strategy: 'IRON_CONDOR', credit: true, features: {},
    legs: { netCredit: 50, ceShort: { bid: 50, ask: 51 }, ceLong: { bid: 24, ask: 26 }, peShort: { bid: 50, ask: 51 }, peLong: { bid: 24, ask: 26 } },
    worsen: legs => { legs.ceShort.bid = 48; }, limit: 47.5, good: 48, bad: 46
  },
  ...['BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'].map(strategy => ({
    strategy, credit: false,
    features: { trend30mPct: strategy === 'BULL_CALL_SPREAD' ? 0.2 : -0.2 },
    legs: { netDebit: 45, buyLeg: { premium: 100, bid: 99, ask: 101 }, sellLeg: { premium: 55, bid: 54, ask: 56 } },
    worsen: legs => { legs.buyLeg.ask = 103; }, limit: 47.25, good: 47, bad: 49
  })),
  ...['LONG_CALL', 'LONG_PUT'].map(strategy => ({
    strategy, credit: false,
    features: { trend30mPct: strategy === 'LONG_CALL' ? 0.2 : -0.2 },
    legs: { buyLeg: { premium: 100, bid: 99, ask: 101 } },
    worsen: legs => { legs.buyLeg.ask = 106; }, limit: 105, good: 101, bad: 106
  }))
];

function plan(c, legs = c.legs, overrides = {}) {
  return buildEntryPlan({ ...base, strategy: c.strategy, features: c.features, tradeLegs: legs, ...overrides });
}
function orchestrate(entry, marketPhase = 'OPEN') {
  return buildDecisionOrchestration({ strategy: 'BEAR_CALL_SPREAD', setup: { qualified: true }, entry,
    risk: { status: 'READY' }, management: { status: 'READY' }, position: { status: 'READY' },
    marketPhase, regime: { direction: 'BEARISH' } });
}

for (const c of cases) {
  const ready = plan(c);
  assert.strictEqual(ready.triggerReady, true, c.strategy);
  assert.strictEqual(ready.status, 'READY_TO_ENTER', c.strategy);
  assert.strictEqual(ready.displayState, 'BUY_NOW');
  assert.strictEqual(ready.execution.current, c.good);
  assert.strictEqual(ready.execution.limit, c.limit);

  // Move only bid/ask: the independent LTP valuation and its limit stay fixed.
  const worse = structuredClone(c.legs);
  c.worsen(worse);
  const rejected = plan(c, worse);
  assert.strictEqual(rejected.execution.limit, ready.execution.limit);
  assert.strictEqual(rejected.execution.current, c.bad);
  assert.strictEqual(rejected.execution.status, c.credit ? 'PRICE_TOO_LOW' : 'PRICE_TOO_HIGH');
  assert.strictEqual(rejected.priceReady, false);
  assert.strictEqual(rejected.status, 'WAIT_FOR_PRICE');
  assert.strictEqual(rejected.displayState, 'TRIGGER_HIT_PRICE_BAD');
  const decision = orchestrate(rejected);
  assert.strictEqual(decision.status, 'WAIT_FOR_PRICE');
  assert.strictEqual(decision.executionAllowed, false);
  assert(decision.blockers.includes('ENTRY_PRICE_NOT_ACCEPTABLE'));

  // Absent/null/zero/crossed leg quotes must never promote LTP to executable.
  for (const invalid of ['absent', null, 0, 'crossed']) {
    const indicative = structuredClone(c.legs);
    const leg = indicative.buyLeg || indicative.ceLong;
    if (invalid === 'absent') { delete leg.bid; delete leg.ask; }
    else if (invalid === 'crossed') { leg.bid = 200; leg.ask = 1; }
    else { leg.bid = invalid; leg.ask = invalid; }
    const unavailable = plan(c, indicative);
    assert.strictEqual(unavailable.premium.indicativeOnly, true);
    assert.strictEqual(unavailable.execution.status, 'PRICE_UNAVAILABLE');
    assert.strictEqual(unavailable.execution.current, null);
    assert.strictEqual(unavailable.priceReady, false);
    assert.strictEqual(unavailable.status, 'WAIT_FOR_PRICE');
    assert.strictEqual(orchestrate(unavailable).executionAllowed, false);
  }

  for (const marketPhase of ['CLOSED', 'PRE_OPEN']) {
    const closed = plan(c, c.legs, { marketPhase });
    assert.strictEqual(closed.triggerReady, true);
    assert.strictEqual(closed.priceReady, true);
    assert.strictEqual(closed.status, 'WAIT_FOR_MARKET');
    assert.strictEqual(closed.displayState, 'MARKET_NOT_OPEN');
    assert.strictEqual(closed.timing.validForMinutes, 0);
    const decision = orchestrate(closed, marketPhase);
    assert.strictEqual(decision.status, 'MARKET_CLOSED');
    assert.strictEqual(decision.executionAllowed, false);
    assert(decision.blockers.includes('MARKET_NOT_OPEN'));
    assert(!decision.blockers.includes('ENTRY_TRIGGER_NOT_CONFIRMED'));
  }
}

// An acceptable quote cannot substitute for a market trigger or start its clock.
const credit = cases[0];
for (const priceReady of [true, false]) {
  const legs = structuredClone(credit.legs);
  if (!priceReady) credit.worsen(legs);
  const waiting = plan(credit, legs, { spot: 23120 });
  assert.strictEqual(waiting.status, 'WAIT_FOR_TRIGGER');
  assert.strictEqual(waiting.triggerReady, false);
  assert.strictEqual(waiting.priceReady, priceReady);
  assert.strictEqual(waiting.displayState, priceReady ? 'PRICE_OK_WAITING_TRIGGER' : 'WAITING_TRIGGER_AND_PRICE');
  assert.strictEqual(waiting.timing.validForMinutes, null);
  assert.strictEqual(waiting.timing.validityStarts, 'AFTER_TRIGGER');
  assert.strictEqual(orchestrate(waiting).status, 'WAIT_FOR_TRIGGER');
}
assert.strictEqual(plan(credit).timing.validityStarts, 'TRIGGER_CONFIRMED');
assert.strictEqual(plan(credit, credit.legs, { minutesRemaining: null }).timing.validForMinutes, 15);
assert.strictEqual(plan(credit, credit.legs, { minutesRemaining: 2 }).timing.validForMinutes, 2);
console.log('Entry execution regression tests passed');
