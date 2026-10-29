'use strict';
// Owner policy: one option strike at a time. The main engine must never choose a spread, condor or straddle,
// whatever the volatility, and no spread card is offered.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {selectStrategy}=require('./strategyEngine');
const {buildResearchCandidatePlans}=require('./candidatePlanEngine');
const MULTI=/SPREAD|CONDOR|BUTTERFLY|STRADDLE|STRANGLE/;
const on={singleStrikeOnly:true};
for(const dir of ['STRONG_BULLISH','BULLISH','MILD_BULLISH'])for(const iv of ['HIGH','NORMAL','LOW']){
 const s=selectStrategy({direction:dir},iv,null,on);
 assert.equal(s.name,'LONG_CALL',dir+'/'+iv);assert.ok(!s.candidates.some(c=>MULTI.test(c)));
}
for(const dir of ['STRONG_BEARISH','BEARISH','MILD_BEARISH'])for(const rich of ['RICH','FAIR','CHEAP']){
 const s=selectStrategy({direction:dir},'NORMAL',{richness:rich},on);
 assert.equal(s.name,'LONG_PUT',dir+'/'+rich);assert.ok(!s.candidates.some(c=>MULTI.test(c)));
}
for(const iv of ['HIGH','LOW'])assert.equal(selectStrategy({direction:'NEUTRAL'},iv,null,on).name,'WAIT','neutral never becomes a condor or straddle');
// The default (policy off) is unchanged, so existing behaviour and tests stay comparable.
assert.equal(selectStrategy({direction:'BULLISH'},'NORMAL').name,'BULL_CALL_SPREAD');

// Cards: no spread card under the policy; the single-strike card and the authoritative copy remain.
const q=(strike,type,delta,ask)=>({strike,[type==='CE'?'ce':'pe']:{ltp:ask-0.5,bid:ask-1,ask,delta,instrumentKey:'NSE_FO|'+strike+type,oi:1000}});
const strikes=[22900,22950,23000,23050,23100,23150].map((k,i)=>({strike:k,ceLTP:120-i*15,ceBid:119-i*15,ceAsk:120-i*15,ceDelta:0.6-i*0.07,ceInstrumentKey:'NSE_FO|'+k+'CE',
 peLTP:60+i*15,peBid:59+i*15,peAsk:60+i*15,peDelta:-(0.4+i*0.07),peInstrumentKey:'NSE_FO|'+k+'PE'}));
const plans=buildResearchCandidatePlans({strikes,regime:{direction:'BULLISH'},strategy:'LONG_CALL',tradeLegs:{buyLeg:{contractId:'x',instrumentKey:'NSE_FO|1',strike:23000,type:'CE'}},
 orchestration:{status:'NO_TRADE'},expiryDate:'2026-11-03',lotSize:65,singleStrikeOnly:true}).plans;
assert.equal(plans.B.available,false);assert.equal(plans.B.unavailableReason,'SINGLE_STRIKE_POLICY');
assert.equal(plans.A.strategy,'LONG_CALL');
assert.ok(!plans.C.available||plans.C.strategy==='LONG_CALL','C stays a single strike');
const legacy=buildResearchCandidatePlans({strikes,regime:{direction:'BULLISH'},expiryDate:'2026-11-03',lotSize:65}).plans;
assert.ok(!legacy.B.unavailableReason,'policy off: card B is built as before');

// The server turns the policy on in code (part of the rule fingerprint), for both the engine and the cards.
const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
assert.match(server,/const SINGLE_STRIKE_ONLY = true;/);
assert.match(server,/selectStrategy\(regime, ivRegime, volatility, \{ singleStrikeOnly: SINGLE_STRIKE_ONLY \}\)/);
assert.match(server,/buildResearchCandidatePlans\(\{\s*singleStrikeOnly: SINGLE_STRIKE_ONLY,/);
const spec=fs.readFileSync(path.join(__dirname,'..','evidence','signalRecording.js'),'utf8');
assert.ok(['engine/strategyEngine.js','engine/candidatePlanEngine.js','server.js'].every(f=>spec.includes("'"+f+"'")),'policy files are in the rule fingerprint');
console.log('Single-strike policy PASS: calls/puts only in every volatility, neutral waits, no spread card, default unchanged, server enables it in fingerprinted code');
