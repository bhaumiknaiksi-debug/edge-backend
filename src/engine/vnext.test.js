'use strict';

const assert = require('assert');
const { buildMarketFeatures } = require('./marketFeatureEngine');
const { classifyRegime } = require('./regimeEngine');
const { selectStrategy } = require('./strategyEngine');
const { qualifySetup } = require('./setupEngine');
const { classifyOptionChainFlow } = require('./optionFlowEngine');
const { buildEntryPlan } = require('./entryEngine');
const { buildRiskPlan } = require('./riskEngine');
const { buildManagementPlan } = require('./managementEngine');
const { buildPositionPlan } = require('./positionSizingEngine');
const { buildDecisionOrchestration } = require('./decisionOrchestrator');

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
assert(optionFlow.aggregate.counts.CALL_WRITING >= 1);
assert(optionFlow.aggregate.counts.PUT_WRITING >= 1);

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
assert(Array.isArray(strategy.candidates));
const neutralRange = { direction: 'NEUTRAL', evidenceCoverage: 100 };
const neutralPick = selectStrategy(neutralRange, 'HIGH');
assert.strictEqual(neutralPick.name, 'IRON_CONDOR');
const neutralSetup = qualifySetup({ regime: neutralRange, strategy: 'IRON_CONDOR', tradeLegs: {}, marketPhase: 'OPEN' });
assert.strictEqual(neutralSetup.qualified, true);
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
const nearCloseEntry = buildEntryPlan({
  strategy: 'IRON_CONDOR', spot: 23000, support: 22900, resistance: 23100,
  ceWall: 23200, peWall: 22800, expectedMove: { low: 22800, high: 23200 },
  tradeLegs: {
    ceShort:{strike:23200,bid:20,ask:21}, ceLong:{strike:23300,bid:8,ask:9},
    peShort:{strike:22800,bid:20,ask:21}, peLong:{strike:22700,bid:8,ask:9},
    netCredit:'24'
  },
  regime: neutralRange, features:{optionFlow:{aggregate:{label:'MIXED_FLOW'}}},
  marketPhase:'OPEN', dte:2, minutesRemaining:2
});
assert.strictEqual(nearCloseEntry.timing.validForMinutes, 2);
assert.strictEqual(nearCloseEntry.timing.maxHoldMinutes, 2);
assert.strictEqual(nearCloseEntry.timing.sessionCapped, true);

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

const risk = buildRiskPlan({
  strategy: 'BEAR_CALL_SPREAD',
  tradeLegs: {
    sellLeg: { strike: 23100, premium: '50', bid: 49, ask: 51, type: 'CE' },
    buyLeg: { strike: 23200, premium: '25', bid: 24, ask: 26, type: 'CE' },
    netCredit: '25',
    breakeven: '23125'
  },
  spot: 23000,
  support: 22900,
  resistance: 23100,
  peWall: 22900,
  ceWall: 23100,
  expectedMove: { low: 22900, high: 23100 },
  marketPhase: 'OPEN',
  dte: 2
});
assert.strictEqual(risk.status, 'READY');
assert.strictEqual(risk.model, 'DEFINED_RISK_CREDIT');
assert.strictEqual(risk.stop.type, 'SPREAD_DEBIT');
assert.strictEqual(risk.target1.type, 'SPREAD_DEBIT');
assert.strictEqual(risk.target2.type, 'SPREAD_DEBIT');
assert(risk.maxLossPoints > 0);
assert.strictEqual(risk.rrTarget1, 0.33);
assert.strictEqual(risk.rrTarget2, 0.5);

const management = buildManagementPlan({
  strategy: 'BEAR_CALL_SPREAD',
  risk,
  entry,
  regime,
  spot: 23000
});
assert.strictEqual(management.status, 'READY');
assert.strictEqual(management.profitTaking.target1 !== undefined, true);
assert.strictEqual(management.trailing.afterTarget1 !== undefined, true);
assert.strictEqual(management.timeExit !== undefined, true);

const position = buildPositionPlan({
  strategy: 'BEAR_CALL_SPREAD',
  tradeLegs: { lotSize: 65 },
  risk,
  account: { capital: 1000000, maxRiskPct: 1, dailyLossLimitRupees: 20000 },
  marketPhase: 'OPEN',
  dailyLossRupees: 0,
  openRiskRupees: 0
});
assert.strictEqual(position.status, 'READY');
assert.strictEqual(position.recommendedLots, 3);
assert.strictEqual(position.riskPerLotRupees, 4875);
assert.strictEqual(position.actualRiskRupees, 14625);

const blockedPosition = buildPositionPlan({
  strategy: 'BEAR_CALL_SPREAD',
  tradeLegs: { lotSize: 65 },
  risk,
  account: { capital: 100000, maxRiskPct: 1 },
  marketPhase: 'OPEN'
});
assert.strictEqual(blockedPosition.status, 'BLOCKED');
assert.strictEqual(blockedPosition.recommendedLots, 0);

const orchestrationReady = buildDecisionOrchestration({
  strategy: 'BEAR_CALL_SPREAD',
  setup: { qualified: true, blockers: [] },
  entry: { status: 'READY_TO_ENTER' },
  risk: { status: 'READY' },
  management: { status: 'READY' },
  position: { status: 'READY' },
  marketPhase: 'OPEN',
  regime: { direction: 'BEARISH' }
});
assert.strictEqual(orchestrationReady.status, 'READY_TO_EXECUTE');
assert.strictEqual(orchestrationReady.executionAllowed, true);
assert.strictEqual(orchestrationReady.blockers.length, 0);

const orchestrationWait = buildDecisionOrchestration({
  strategy: 'BEAR_CALL_SPREAD',
  setup: { qualified: true, blockers: [] },
  entry: { status: 'WAIT_FOR_TRIGGER' },
  risk: { status: 'READY' },
  management: { status: 'READY' },
  position: { status: 'READY' },
  marketPhase: 'OPEN',
  regime: { direction: 'BEARISH' }
});
assert.strictEqual(orchestrationWait.status, 'WAIT_FOR_TRIGGER');
assert.strictEqual(orchestrationWait.executionAllowed, false);
assert.strictEqual(orchestrationWait.blockers.includes('ENTRY_TRIGGER_NOT_CONFIRMED'), true);

const orchestrationClosed = buildDecisionOrchestration({
  strategy: 'BEAR_CALL_SPREAD',
  setup: { qualified: false, blockers: ['MARKET_NOT_OPEN'] },
  entry: { status: 'WAIT_FOR_TRIGGER' },
  risk: { status: 'CONDITIONAL' },
  management: { status: 'CONDITIONAL' },
  position: { status: 'CONDITIONAL' },
  marketPhase: 'CLOSED',
  regime: { direction: 'BEARISH' }
});
assert.strictEqual(orchestrationClosed.status, 'MARKET_CLOSED');
assert.strictEqual(orchestrationClosed.executionAllowed, false);


const neutralOrchestration = buildDecisionOrchestration({
  strategy:'IRON_CONDOR', setup:{qualified:true,blockers:[]},
  entry:{status:'READY_TO_ENTER'}, risk:{status:'READY'}, management:{status:'READY'},
  position:{status:'READY'}, marketPhase:'OPEN', regime:{direction:'NEUTRAL'}
});
assert.strictEqual(neutralOrchestration.status, 'READY_TO_EXECUTE');
assert.strictEqual(neutralOrchestration.gates.regime, true);

console.log('EDGE vNext engine tests passed');
