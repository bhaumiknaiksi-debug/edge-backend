'use strict';
const assert=require('node:assert/strict');
const {simulate}=require('./paperExecution');
const row=(time,more={})=>({time,quoteAt:time,contract:'NIFTY-TEST-CE',strategy:'LONG_CALL',lotSize:25,bid:99,ask:100,stop:95,target:110,episodeId:'e1',marketPhase:'OPEN',trigger:true,...more});
const t1='2026-10-27T04:00:00Z',t2='2026-10-27T04:00:30Z',t3='2026-10-27T04:01:00Z';
let r=simulate([row(t1),row(t2,{bid:110,ask:111,trigger:false})]);
assert.equal(r.events[0].type,'OPEN'); assert.equal(r.netPnl,150); assert.equal(r.events[1].reason,'TARGET');
r=simulate([row(t1,{lotSize:65})]); assert.equal(r.events[0].reason,'RISK_LIMIT');
r=simulate([row(t1,{quoteAt:'2026-10-27T03:59:00Z'})]);assert.equal(r.events[0].reason,'STALE_OR_INVALID_QUOTE');
r=simulate([row(t1),row(t2,{bid:80,ask:81}),row(t3,{episodeId:'e2'})]);assert.equal(r.locked,true);assert.equal(r.events.at(-1).reason,'DAILY_LOSS_LOCK');
r=simulate([row(t1),row('2026-10-27T04:04:00Z')]);assert.equal(r.unknown,true);assert.equal(r.netPnl,null);
r=simulate([row(t1),row(t2,{bid:110,ask:111}),row(t3)]);assert.equal(r.events.at(-1).reason,'DUPLICATE_EPISODE');
assert.throws(()=>simulate([row(t1),row(t1)]),/TIMESTAMPS/);

// A stopped-out position can lose more than its planned risk; never cap the result.
assert.equal(simulate([row(t1),row(t2,{bid:80,ask:81})]).netPnl,-600);
// Losses consume cash; winnings do not enlarge the initial capital ceiling.
r=simulate([row(t1),row(t2,{bid:95,ask:96}),row(t3,{episodeId:'e2',bid:395,ask:396,stop:395,target:410})],{capital:10100});
assert.equal(r.events.at(-1).reason,'CAPITAL_LIMIT');
// Raising per-trade risk must not bypass the remaining daily budget.
r=simulate([row(t1,{stop:50}),row(t2,{bid:83,ask:84}),row(t3,{episodeId:'e2'})],{perTradeRisk:2000});
assert.equal(r.events[0].reason,'RISK_LIMIT');
// Quotes for the original contract continue to manage it when the displayed candidate changes.
r=simulate([row(t1),row(t2,{contract:'different',quotes:{'NIFTY-TEST-CE':{quoteAt:t2,bid:111,ask:112}}})]);
assert.equal(r.events[1].reason,'TARGET');
r=simulate([row(t1),row(t2,{quoteAt:'2026-10-27T04:01:00Z'}),row(t3,{bid:111,ask:112})]);
assert.equal(r.unknown,true);assert.equal(r.events.filter(e=>e.type==='CLOSE').length,0);
assert.equal(simulate([row(t1)]).netPnl,null);
assert.equal(simulate([]).netPnl,null);
assert.equal(simulate([row(t1,{marketPhase:'CLOSED'})]).events[0].reason,'MARKET_NOT_OPEN');
assert.equal(simulate([row('2026-10-27T10:00:00Z')]).events[0].reason,'MARKET_NOT_OPEN');
assert.throws(()=>simulate([row(t1),row('2026-10-28T04:00:00Z')]),/ONE_SESSION_ONLY/);
assert.throws(()=>simulate([row(t1)],{slippage:-1}),/INVALID_OPTIONS/);
assert.throws(()=>simulate([row('2026-10-27T04:00:00')]),/TIMESTAMPS/);
const input=[row(t1),row(t2,{bid:111,ask:112})], original=JSON.stringify(input);
simulate(input);assert.equal(JSON.stringify(input),original);
assert.equal(simulate(input).executionAllowed,false);
assert.equal(simulate(input,{slippage:0.5}).events[0].plannedRisk,250);
assert.equal(simulate(input,{slippage:1}).events[0].reason,'RISK_LIMIT','friction must consume planned risk');
console.log('Paper execution PASS: cash depletion, daily risk budget, loss latch, original contracts, no future quotes, gaps, open results and isolation');
