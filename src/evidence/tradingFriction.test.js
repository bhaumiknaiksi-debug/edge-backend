'use strict';

const assert=require('assert');
const {getProfile,optionOrderCharges,calibratedRoundTripCost}=require('./tradingFriction');

const profile=getProfile('UPSTOX_STANDARD_NSE_OPTIONS_2026');
assert.ok(profile);
assert.strictEqual(profile.brokeragePerExecutedOrderRupees,20);
assert.strictEqual(profile.sttSellPct,0.15);
assert.strictEqual(profile.exchangeTransactionPct,0.03552);
assert.strictEqual(profile.stampDutyBuyPct,0.003);
assert.strictEqual(profile.ipftPerCroreRupees,50);

const buy=optionOrderCharges({premium:100,side:'BUY',quantity:65,profile});
const sell=optionOrderCharges({premium:110,side:'SELL',quantity:65,profile});
assert.strictEqual(buy.brokerageRupees,20);
assert.strictEqual(sell.brokerageRupees,20);
assert(buy.stampDutyRupees>0);
assert.strictEqual(buy.sttRupees,0);
assert(sell.sttRupees>0);
assert.strictEqual(sell.stampDutyRupees,0);

const row={
  snapshot:{strategy:'LONG_CALL',tradeLegs:{lotSize:65,buyLeg:{contractId:'X'}},position:{recommendedLots:2}},
  outcome:{
    status:'MEASURED',
    entryValue:100,
    entryLegPrices:{buyLeg:{contractId:'X',side:'BUY',price:100}},
    horizonLegPrices:{60:{buyLeg:{contractId:'X',side:'SELL',price:110}}},
    horizonsPct:{60:10}
  }
};
const cost=calibratedRoundTripCost(row,60);
assert.strictEqual(cost.available,true);
assert.strictEqual(cost.profile,'UPSTOX_STANDARD_NSE_OPTIONS_2026');
assert.strictEqual(cost.lots,2);
assert.strictEqual(cost.quantity,130);
assert(cost.totalRupees>87&&cost.totalRupees<90);
assert(cost.costPct>0.67&&cost.costPct<0.70);
const slipped=calibratedRoundTripCost(row,60,'UPSTOX_STANDARD_NSE_OPTIONS_2026',{slippageBps:10});
assert(slipped.totalRupees>cost.totalRupees);
assert(slipped.slippageRupees>0);

// Legacy outcomes without leg-level horizon marks must not be assigned fake calibrated costs.
const legacy={snapshot:row.snapshot,outcome:{status:'MEASURED',entryValue:100,horizonsPct:{60:10}}};
const missing=calibratedRoundTripCost(legacy,60);
assert.strictEqual(missing.available,false);
assert.strictEqual(missing.reason,'LEG_MARKS_UNAVAILABLE');

console.log('EDGE calibrated trading friction tests passed');
