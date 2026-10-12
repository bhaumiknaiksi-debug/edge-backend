'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildEntryPlan } = require('../engine/entryEngine');

// Exercise the production chain mapping without starting HTTP, polling or push.
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const mapping = source.slice(source.indexOf('  // totals'), source.indexOf('  // Full-chain OI totals'));
function plan(marketData) {
  const context = { chain: [{ strike_price: 22500, call_options: { market_data: marketData }, put_options: { market_data: { bid_price: 80, ask_price: 81 } } }] };
  vm.runInNewContext(mapping + '\nresult = strikes;', context);
  const row = context.result[0];
  assert.equal(row.peBid, 80);
  assert.equal(row.peAsk, 81);
  return buildEntryPlan({ strategy: 'LONG_CALL', spot: 22600, support: 22400, resistance: 22500,
    marketPhase: 'OPEN', dte: 2, minutesRemaining: 200, regime: 'STRONG_BULLISH', features: {},
    tradeLegs: { buyLeg: { strike: row.strike, premium: row.ceLTP, bid: row.ceBid, ask: row.ceAsk } } });
}
const valid = plan({ ltp: 100, bid_price: 99, ask_price: 100 });
assert.equal(valid.liquidityReady, true);
assert.equal(valid.premium.current, 100);
assert.equal(plan({ ltp: 100 }).liquidityReady, false);
assert.equal(plan({ ltp: 100, bid_price: 101, ask_price: 100 }).liquidityReady, false);
assert.equal(plan({ ltp: 100, bid_price: 50, ask_price: 100 }).liquidityReady, false);
console.log('Production quote mapping: valid, missing, crossed and wide markets PASS');
