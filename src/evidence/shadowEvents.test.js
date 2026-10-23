'use strict';
const assert=require('node:assert/strict');
const {advance,quotesFromChain,createShadowEvents,SCHEMA}=require('./shadowEvents');
const t=Date.parse('2026-10-22T10:00:00+05:30'),FIVE=300000;
const source=(time,close,priorTime=time-FIVE,priorClose=100)=>({available:true,session:'2026-10-22',high:110,low:90,completedAt:'2026-10-22T04:00:00.000Z',source:'NIFTY_INDEX_5M_OPENING_RANGE',latest:{time,close},previous:{time:priorTime,close:priorClose}});
const candidate=(id='original',strategy='LONG_CALL')=>({available:true,strategy,legs:{buyLeg:{instrumentKey:id,contractId:id},...(strategy.endsWith('SPREAD')?{sellLeg:{instrumentKey:'hedge',contractId:'hedge'}}:{})}});
const candidates={plans:{A:candidate(),B:candidate('original','BULL_CALL_SPREAD'),C:candidate()}};
const quotes={original:{bid:99,ask:100},hedge:{bid:20,ask:21},replacement:{bid:60,ask:61}};
let state={cursor:null,events:[]};
function step(now,src,extra={}){state=advance({...state,now,source:src,candidates,quotes,...extra});return state;}
step(t,source(t-FIVE,100));
assert.equal(state.events.length,0);
// Poll observations continue before the next candle completes.
for(let n=t+30000;n<t+FIVE;n+=30000)step(n,source(t-FIVE,100));
step(t+FIVE,source(t,115,t-FIVE,100));
assert.equal(state.events.length,1);const eventId=state.events[0].id;
assert.equal(state.events[0].contracts.length,3);
assert.equal(state.events[0].contracts[1].entryMark,80);
assert.equal(state.events[0].contracts[1].samples[0].exitMark,78);
// Restart is a fresh transition using durable JSON, preserving original instruments.
state=JSON.parse(JSON.stringify(state));
step(t+FIVE+30000,source(t,115,t-FIVE,100),{candidates:{plans:{A:candidate('replacement'),B:candidate('replacement'),C:candidate('replacement')}},quotes:{...quotes,original:{bid:105,ask:106}}});
assert.equal(state.events[0].id,eventId);
assert.equal(state.events[0].contracts[0].legs[0].instrumentKey,'original');
assert.equal(state.events[0].contracts[0].samples.at(-1).points,5);
assert.ok(state.events[0].contracts[0].replacedAt);
// Spot moves are not used to invalidate before a completed candle.
assert.equal(state.events[0].status,'CONFIRMED');
for(let n=t+FIVE+60000;n<t+2*FIVE;n+=30000)step(n,source(t,115,t-FIVE,100));
step(t+2*FIVE,source(t+FIVE,108,t,115),{quotes:{...quotes,original:{bid:95,ask:96}}});
assert.equal(state.events[0].status,'INVALIDATED');
assert.equal(state.events[0].contracts[0].horizons[5].status,'OBSERVED');
assert.equal(state.events[0].contracts[0].horizons[5].points,-5);
// Invalidated events continue observing contracts through their horizon.
step(t+2*FIVE+30000,source(t+FIVE,108,t,115),{quotes:{}});
assert.equal(state.events[0].contracts[0].samples.at(-1).points,null);
assert.ok(state.events[0].contracts[0].missingQuotes>0);
// Long outage retains identity but cannot invent 15/30-minute prices.
step(t+40*60000,source(t+35*60000,105));
assert.equal(state.events[0].complete,true);
assert.equal(state.events[0].contracts[0].horizons[15].status,'UNKNOWN');
assert.equal(state.events[0].contracts[0].horizons[30].status,'UNKNOWN');
assert.ok(state.events[0].gapCount>0);
assert.equal(state.events[0].id,eventId);
const before=JSON.stringify(state);advance({...state,now:t+45*60000,source:source(t+40*60000,105),candidates,quotes});assert.equal(JSON.stringify(state),before);
// Cold start and unseen crossings cannot create an event.
assert.equal(advance({now:t+FIVE,source:source(t,115),candidates,quotes}).events.length,0);
assert.equal(advance({cursor:{session:'2026-10-22',high:110,low:90,completedAt:'2026-10-22T04:00:00.000Z',time:t-FIVE,close:100,observedAt:t},now:t+FIVE,source:source(t,115),candidates,quotes}).events.length,0);
assert.deepEqual(quotesFromChain([{call_options:{instrument_key:'x',market_data:{bid_price:0,ask_price:1}}}]),{});
assert.equal(quotesFromChain([{call_options:{instrument_key:'x',market_data:{bid_price:3,ask_price:4}}}]).x.bid,3);
// Put crossing and quote entry unavailable must never acquire an entry retrospectively.
const cursor={session:'2026-10-22',high:110,low:90,completedAt:'2026-10-22T04:00:00.000Z',time:t-FIVE,close:100,observedAt:t+FIVE-30000};
let put=advance({cursor,now:t+FIVE,source:source(t,85),candidates:{plans:{C:candidate('original','LONG_PUT')}},quotes:{}});
assert.equal(put.events[0].direction,'BEARISH');assert.equal(put.events[0].contracts[0].entryMark,null);
put=advance({...put,now:t+FIVE+30000,source:source(t,85),candidates,quotes});
assert.equal(put.events[0].contracts[0].entryMark,null);
assert.equal(put.events[0].contracts[0].samples.at(-1).points,null);
// Optional persistence: disabled never touches the database; failure rolls back and releases.
(async()=>{
 const disabled=createShadowEvents({enabled:false,pool:{query(){throw Error('must not query');}}});
 assert.deepEqual(await disabled.observe({}),{enabled:false});
 const calls=[];let released=false;
 const pool={async query(sql){assert.equal(sql,SCHEMA);},async connect(){return {async query(sql){calls.push(sql);if(sql.startsWith('SELECT payload FROM edge_shadow_cursor'))throw Error('database down');return {rows:[]};},release(){released=true;}};}};
 await assert.rejects(createShadowEvents({enabled:true,pool}).observe({now:t}),/database down/);
 assert.ok(calls.includes('ROLLBACK'));assert.ok(released);
 console.log('shadowEvents PASS: independent event identity, original contracts, spreads, restart state, invalidation, horizons, missing data, gaps, immutability and transaction failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
// Thirty-minute marks use the original contract even if the event was invalidated.
const observedEvent=JSON.parse(JSON.stringify(put.events[0]));
observedEvent.contracts[0].entryMark=100;
observedEvent.lastObservedAt=t+34*60000+30000;
const atThirty=advance({events:[observedEvent],now:t+35*60000,marketPhase:'OPEN',source:source(t+30*60000,85),candidates,quotes:{original:{bid:112,ask:113}}});
assert.equal(atThirty.events[0].contracts[0].horizons[30].points,12);
assert.equal(atThirty.events[0].complete,true);
assert.equal(atThirty.events[0].contracts[0].horizons[15].status,'UNKNOWN');
// Expired quote snapshot cannot become an entry or horizon observation.
const stale=advance({cursor,now:t+FIVE,source:source(t,115),candidates,quotes,quotesAt:t});
assert.equal(stale.events[0].contracts[0].entryMark,null);
// Equality is not a crossing, and data revision cannot create a crossing.
assert.equal(advance({cursor,now:t+FIVE,source:source(t,110),candidates,quotes}).events.length,0);
assert.equal(advance({cursor,now:t+FIVE,source:{...source(t,115),high:111},candidates,quotes}).events.length,0);
// A restart before market close cannot manufacture a price for the next session.
const tomorrow=advance({events:[observedEvent],now:t+86400000,marketPhase:'OPEN',candidates,quotes});
assert.equal(tomorrow.events[0].contracts[0].horizons[30].status,'UNKNOWN');
assert.equal(tomorrow.events[0].complete,true);
console.log('Additional horizons, quote age, equality, revision and session-boundary guards PASS');
(async()=>{
 // Database protocol fixture: retain committed JSON between separate tracker instances.
 const db={cursor:null,events:new Map()};
 const pool={async query(sql){if(sql===SCHEMA)return {rows:[]};if(sql.includes('ORDER BY detected_at DESC'))return {rows:[...db.events.values()].map(payload=>({payload}))};throw Error(sql);},async connect(){return {async query(sql,args=[]){
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('INSERT INTO edge_shadow_cursor'))return {rows:[]};
  if(sql.startsWith('SELECT payload FROM edge_shadow_cursor'))return {rows:[{payload:db.cursor}]};
  if(sql.startsWith('SELECT payload FROM edge_shadow_events'))return {rows:[...db.events.values()].filter(e=>!e.complete).map(payload=>({payload}))};
  if(sql.startsWith('INSERT INTO edge_shadow_events')){db.events.set(args[0],JSON.parse(args[3]));return {rows:[]};}
  if(sql.startsWith('UPDATE edge_shadow_cursor')){db.cursor=JSON.parse(args[0]);return {rows:[]};}
  throw Error(sql);
 },release(){}};}};
 const first=createShadowEvents({pool,enabled:true});
 await first.observe({now:t,source:source(t-FIVE,100),candidates,quotes});
 for(let n=t+30000;n<t+FIVE;n+=30000)await first.observe({now:n,source:source(t-FIVE,100),candidates,quotes});
 const confirmation=await first.observe({now:t+FIVE,source:source(t,115),candidates,quotes});
 const second=createShadowEvents({pool,enabled:true});
 const restored=await second.observe({now:t+FIVE+30000,source:source(t,115),candidates:{plans:{C:candidate('replacement')}},quotes});
 assert.equal(restored.events[0].id,confirmation.events[0].id);
 assert.equal(restored.events[0].contracts[2].legs[0].instrumentKey,'original');
 assert.ok(restored.events[0].contracts[2].replacedAt);
 const recent=await second.recent();assert.equal(recent.events.length,1);assert.equal(recent.executionAllowed,false);
 assert.equal(recent.events[0].contracts[2].sampleCount,2);
 assert.equal('samples' in recent.events[0].contracts[2],false);
 console.log('Persistence adapter PASS: committed event restored by new tracker instance and report retains original contract');
})().catch(e=>{console.error(e);process.exitCode=1;});
const versioned=advance({cursor,now:t+FIVE,source:source(t,115),candidates,quotes,ruleSpec:{version:'TEST',implementationHash:'original'}});
assert.equal(versioned.events[0].ruleSpec.implementationHash,'original');
const afterUpgrade=advance({...versioned,now:t+FIVE+30000,source:source(t,115),candidates,quotes,ruleSpec:{version:'TEST',implementationHash:'new'}});
assert.equal(afterUpgrade.events[0].ruleSpec.implementationHash,'original','Existing events retain their creation rules');
