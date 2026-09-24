'use strict';

const assert = require('assert');
const { buildMarketFeatures } = require('./marketFeatureEngine');
const { classifyRegime } = require('./regimeEngine');
const { selectStrategy } = require('./strategyEngine');
const { qualifySetup } = require('./setupEngine');
const { classifyOptionChainFlow } = require('./optionFlowEngine');
const { buildEntryPlan } = require('./entryEngine');

const strikes = [
  { strike: 22900, ceOI: 100, peOI: 300, cePrevOI: 80, pePrevOI: 260, ceLTP: 100, peLTP: 70 },
  { strike: 22950, ceOI: 120, peOI: 280, cePrevOI: 100, pePrevOI: 250, ceLTP: 80, peLTP: 60 },
  { strike: 23000, ceOI: 160, peOI: 250, cePrevOI: 140, pePrevOI: 230, ceLTP: 60, peLTP: 50 },
  { strike: 23050, ceOI: 220, peOI: 180, cePrevOI: 200, pePrevOI: 190, ceLTP: 45, peLTP: 55 },
  { strike: 23100, ceOI: 300, peOI: 140, cePrevOI: 260, pePrevOI: 160, ceLTP: 35, peLTP: 70 }
];

const optionFlow = classifyOptionChainFlow([
  { strike: 22900, ceOI: 120, cePrevOI: 100, ceLTP: 8, ceClosePrice: 10, peOI: 320, pePrevOI: 280, peLTP: 13, peClosePrice: 15 },
  { strike: 23000, ceOI: 180, cePrevOI: 150, ceLTP: 8, ceClosePrice: 10, peOI: 320, pePrevOI: 270, peLTP: 15, peClosePrice: 12 }
], -1.2);
assert(optionFlow.aggregate.classifiedContracts >= 2);
assert(optionFlow.aggregate.counts.CE_WRITING >= 1);
assert(optionFlow.aggregate.counts.PE_WRITING >= 1);

const features = buildMarketFeatures({
  spot: 23000, strikes, maxPain: 23100, avgIV: 22, ivRegime: 'HIGH', atmIndex: 2,
  sessionChangePct: -1.2,
  trend30mPct: -0.6,
  optionFlow,
  futures: { priceChangePct: -1.1, oiChangePct: 2.4, buildup: 'SHORT_BUILDUP' }
});
assert(features.pcr > 0);
const regime = classifyRegime(features);
assert(regime && regime.direction);
assert(regime.factors.some(f => f.key === 'FUTURES_BUILDUP' && f.available));
assert(regime.factors.some(f => f.key === 'TREND_30M' && f.available));
assert(regime.factors.some(f => f.key === 'OPTION_FLOW' && f.available));
assert.strictEqual(regime.direction, 'STRONG_BEARISH');
const strategy = selectStrategy(regime, 'HIGH');
assert(strategy && strategy.name);
const setup = qualifySetup({ regime, strategy: strategy.name, tradeLegs: {}, marketPhase: 'OPEN' });
assert.strictEqual(setup.action, 'WAIT_FOR_ENTRY');

const entry = buildEntryPlan({
  strategy: 'BEAR_CALL_SPREAD',
  spot: 23000,
  support: 22900,
  resistance: 23100,
  ceWall: 23150,
  peWall: 22900,
  expectedMove: { low: 22900, high: 23100 },
  tradeLegs: {
    sellLeg: { strike: 23100, premium: '50', bid: 49, ask: 51 },
    buyLeg: { strike: 23200, premium: '25', bid: 24, ask: 26 },
    netCredit: '25'
  },
  regime,
  features,
  marketPhase: 'OPEN',
  dte: 2
});
assert.strictEqual(entry.status, 'READY_TO_ENTER');
assert.strictEqual(entry.type, 'NET_CREDIT_ZONE');
assert(entry.premium.available);
assert(entry.timing.validForMinutes > 0);

const blockedEntry = buildEntryPlan({
  strategy: 'BEAR_CALL_SPREAD',
  spot: 23120,
  support: 22900,
  resistance: 23100,
  ceWall: 23150,
  peWall: 22900,
  expectedMove: { low: 23020, high: 23220 },
  tradeLegs: {
    sellLeg: { strike: 23100, premium: '50', bid: 49, ask: 51 },
    buyLeg: { strike: 23200, premium: '25', bid: 24, ask: 26 },
    netCredit: '25'
  },
  regime,
  features,
  marketPhase: 'OPEN',
  dte: 2
});
assert.strictEqual(blockedEntry.status, 'WAIT_FOR_TRIGGER');

console.log('EDGE vNext engine tests passed');
