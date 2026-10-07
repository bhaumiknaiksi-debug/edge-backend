'use strict';
const assert=require('assert');
const {buildPriceActionResearch}=require('./priceActionResearch');
const rows=[
 {recordType:'RESEARCH_CANDIDATE_OUTCOME',tier:'B',outcome:{status:'MEASURED',horizonsPct:{60:2},mfePct:4,maePct:-1},snapshot:{chartIntelligence:{verdict:'BULLISH',cpr:{daily:{widthClass:'ADAPTIVE_NARROW'}},technicals:{trendStrength:'STRONG'},levelEvents:[{type:'RETEST_HELD_ABOVE'}]},optionExecutionIntelligence:{tiers:{B:{thesisAlignment:'AGREES'}}}}},
 {recordType:'RESEARCH_CANDIDATE_OUTCOME',tier:'B',outcome:{status:'MEASURED',horizonsPct:{60:-1},mfePct:1,maePct:-3},snapshot:{chartIntelligence:{verdict:'BULLISH',cpr:{daily:{widthClass:'ADAPTIVE_NARROW'}},technicals:{trendStrength:'STRONG'},levelEvents:[]},optionExecutionIntelligence:{tiers:{B:{thesisAlignment:'CONTRADICTS'}}}}}
];
const out=buildPriceActionResearch(rows);
assert.equal(out.totalMeasured,2);assert.equal(out.byTier.B.samples,2);assert.equal(out.byTier.B.winRate60mPct,50);assert.equal(out.byCprWidth.ADAPTIVE_NARROW.samples,2);
console.log('priceActionResearch tests passed');
