'use strict';

const assert = require('node:assert/strict');
const {observationOf,advanceTelegram,deliverable,formatTelegramEvent,READY_TTL_MS} = require('./telegramEvents');
const base = Date.parse('2026-10-26T05:00:00Z');
function source(time,ready=false,contract='NIFTY TEST CE') {
  return {timestamp:new Date(time).toISOString(),expiry:'2026-10-27',market:{phase:'OPEN'},
    decision:{strategy:'LONG_CALL',orchestration:{status:ready?'READY_TO_EXECUTE':'WAIT_FOR_TRIGGER',executionAllowed:ready},
      signalTier:{tier:ready?'A':'C',researchOnly:!ready,executionAllowed:ready},
      tradeLegs:{buyLeg:{contractId:contract,instrumentKey:contract+'|key'}},
      ruleSpec:{version:'SIGNAL_RULE_SPEC_V1',implementationHash:'a'.repeat(64)},
      privateLedger:{secret:'DO_NOT_COPY'},tradePlan:{target:999999}}};
}
const observe = (time,ready=false,contract) => observationOf(source(time,ready,contract),time);
const context = (now,observation=null,extra={}) => ({now,observation,phase:'OPEN',bootId:'boot-1',
  recipientKey:'recipient-1',startedAt:base-100000,dailySummary:true,...extra});
function step(previous,time,ready=false,extra={}) {return advanceTelegram(previous,context(time,observe(time,ready),extra));}

const actual = source(base,true);
const frozen = JSON.stringify(actual);
assert.equal(observationOf(actual,base).ready,true);
assert.equal(JSON.stringify(actual),frozen);
assert(!JSON.stringify(observationOf(actual,base)).includes('DO_NOT_COPY'));
assert(!JSON.stringify(observationOf(actual,base)).includes('999999'));
for (const patch of [
  value=>{value.decision.orchestration.executionAllowed=false;},
  value=>{value.decision.signalTier.tier='B';},
  value=>{value.decision.signalTier.tier='C';},
  value=>{value.decision.signalTier.researchOnly=true;},
  value=>{value.decision.tradeLegs.buyLeg.instrumentKey=null;},
  value=>{value.market.phase='CLOSED';},
  value=>{value.decision.strategy='WAIT';}
]) {
  const copy=structuredClone(actual);patch(copy);
  assert.equal(observationOf(copy,base).ready,false);
}
assert.equal(observationOf(actual,base+90001),null);
assert.equal(observationOf(actual,base-5001),null);
assert.equal(observationOf({...actual,timestamp:null},base),null);

let state = step(null,base).state;
const original = JSON.stringify(state);
const promoted = step(state,base+10000,true);
assert.equal(JSON.stringify(state),original,'pure reducer must not mutate prior state');
assert.deepEqual(promoted.events.map(e=>e.type),['EXECUTION_READY']);
const readyEvent = promoted.events[0];
state = promoted.state;
assert.equal(deliverable(readyEvent,state,context(base+20000)),true);
assert.equal(deliverable(readyEvent,state,context(base+10000+READY_TTL_MS)),false);
assert.equal(deliverable(readyEvent,state,context(base+20000,null,{phase:'CLOSED'})),false);
assert.equal(deliverable(readyEvent,state,context(base+20000,null,{bootId:'restarted'})),false);
assert.equal(deliverable({...readyEvent,expiresAt:null},state,context(base+20000)),false);
assert.equal(deliverable({...readyEvent,type:'UNKNOWN'},state,context(base+20000)),false);
assert.equal(deliverable({...readyEvent,observation:null},state,context(base+20000)),false);
assert.equal(step(state,base+20000,true).events.length,0,'stable READY never repeats');
assert.equal(step(state,base+10000,true).events.length,0,'duplicate observations never repeat');
assert.equal(step(state,base+5000,true).events.length,0,'out-of-order observations cannot replace latest');
const invalidated = step(state,base+20000,false);
assert.deepEqual(invalidated.events.map(e=>e.type),['READY_INVALIDATED']);
assert.equal(invalidated.events[0].priorEpisodeId,readyEvent.id);
assert.equal(deliverable(readyEvent,invalidated.state,context(base+21000)),false);

const switched = advanceTelegram(state,context(base+20000,observe(base+20000,true,'NIFTY DIFFERENT CE')));
assert.deepEqual(switched.events.map(e=>e.type),['READY_INVALIDATED','EXECUTION_READY']);
assert.equal(deliverable(readyEvent,switched.state,context(base+21000)),false);
assert.equal(step(null,base,true).events.length,0,'startup READY is baseline only');
assert.equal(step(state,base+20000,true,{bootId:'restarted'}).events.length,0,'no retroactive READY after restart');
assert.equal(step(state,base+110000,true).events.length,0,'a collection gap forces a new baseline');
assert.equal(step(state,base+20000,true,{resetBaseline:true}).events.length,0,'database outage forces a baseline');
const coalesced = {...observe(base+20000,true),coalesced:2};
const dropped = advanceTelegram(state,context(base+20000,coalesced));
assert.equal(dropped.events.length,0);
assert.equal(dropped.state.daily.coalesced,2);
assert.equal(dropped.state.daily.gapCount,1);

const stale = advanceTelegram(state,context(base+110000));
assert.deepEqual(stale.events.map(e=>e.type),['COLLECTOR_STALE']);
assert.equal(deliverable(readyEvent,stale.state,context(base+110000)),false);
assert.equal(advanceTelegram(stale.state,context(base+115000)).events.length,0,'stale warning is deduplicated');
assert.equal(advanceTelegram(state,context(base+110000,null,{startedAt:base+100000,bootId:'new-boot'})).events.length,0,'startup grace avoids false stale warnings');
const recovered = step(stale.state,base+120000,true);
assert.equal(recovered.events.length,0,'recovery baseline is not a new entry signal');
assert.equal(deliverable(stale.events[0],recovered.state,context(base+121000)),false,'obsolete stale warning must not be delivered');

// Close summary is built after the final market-close invalidation, and is once per day.
const closeTime=Date.parse('2026-10-26T10:15:00Z'); // 15:45 IST
const close = advanceTelegram(state,context(closeTime,null,{phase:'CLOSED'}));
assert.deepEqual(close.events.map(e=>e.type),['READY_INVALIDATED','DAILY_SUMMARY']);
assert.equal(close.events[1].daily.invalidations,1);
assert.equal(close.events[1].coverage,'UNKNOWN');
assert.equal(close.events[1].performanceIncluded,false);
assert.equal(advanceTelegram(close.state,context(closeTime+10000,null,{phase:'CLOSED'})).events.length,0);
assert.equal(advanceTelegram(close.state,context(closeTime+20000,null,{phase:'CLOSED',bootId:'restarted'})).events.length,0);
const nextDay=Date.parse('2026-10-27T04:00:00Z');
const late = step(state,nextDay,false,{bootId:'next-day'});
assert.equal(late.events[0].type,'DAILY_SUMMARY');
assert.equal(late.events[0].daily.day,'2026-10-26','late summary must retain the original date');
assert.equal(late.state.daily.day,'2026-10-27');
const noMarket=observationOf({...source(closeTime,false),market:{phase:'CLOSED'}},closeTime);
assert.equal(advanceTelegram(null,context(closeTime,noMarket,{phase:'CLOSED'})).events.length,0,'unknown/unobserved day is not a no-trade summary');
const readyText=formatTelegramEvent(readyEvent);
assert(readyText.includes('Do not use after:'));
assert(readyText.includes('recheck current entry, prices and risk'));
assert(readyText.length<=3000);
assert(formatTelegramEvent(close.events[1]).includes('Coverage UNKNOWN'));
console.log('Telegram events PASS: authoritative A-only readiness, vetoes, identity, restart/gaps, expiration, stale warnings, summary scope and immutability');
