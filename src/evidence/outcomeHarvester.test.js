'use strict';
const assert=require('assert');
const {eligible,isExpired,harvestOutcome,createOutcomeHarvester,retryDelay}=require('./outcomeHarvester');
const old=new Date(Date.now()-121*60000).toISOString();
const snapshot={id:'x',recordType:'POLL_SNAPSHOT',timestamp:old,expiry:'2099-09-29',orchestrationStatus:'READY_TO_EXECUTE',strategy:'LONG_CALL',tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE',instrumentKey:'NSE_FO|123',strike:23000,type:'CE',premium:100,ask:101,bid:99}}};
assert.strictEqual(eligible(snapshot),true);
assert.strictEqual(eligible({...snapshot,orchestrationStatus:'WAIT_FOR_TRIGGER'}),false);
assert.strictEqual(eligible({...snapshot,tradeLegs:{buyLeg:{...snapshot.tradeLegs.buyLeg,instrumentKey:null}}}),false);
assert.strictEqual(isExpired({...snapshot,expiry:'2020-01-01'}),true);
assert(retryDelay(2)>retryDelay(1));

(async()=>{
 const fetchCandles=async()=>[
  {timestamp:new Date(new Date(old).getTime()+15*60000).toISOString(),close:110},
  {timestamp:new Date(new Date(old).getTime()+30*60000).toISOString(),close:95},
  {timestamp:new Date(new Date(old).getTime()+60*60000).toISOString(),close:130},
  {timestamp:new Date(new Date(old).getTime()+120*60000).toISOString(),close:120}
 ];
 const out=await harvestOutcome(snapshot,{token:'test',fetchCandles});
 assert.strictEqual(out.status,'MEASURED');
 assert(out.mfePct>28&&out.mfePct<29);
 assert.strictEqual(out.bestMinute,60);

 // Restart recovery: a measured outcome already on disk must suppress another fetch.
 let calls=0;
 const measured={id:'x|OUTCOME|1',recordType:'OUTCOME',snapshotId:'x',attempt:1,outcome:{status:'MEASURED'}};
 const rows=[snapshot,measured];
 const store={append:r=>{rows.push(r);return true;}};
 const h=createOutcomeHarvester({store,snapshots:rows,token:'test',intervalMs:999999});
 await h.run();
 assert.strictEqual(h.getStatus().pending,0);

 // Retry/dedupe: failed attempts get unique IDs and backoff instead of appending every minute.
 const y={...snapshot,id:'y'};
 const rows2=[y]; const writes=[];
 const h2=createOutcomeHarvester({store:{append:r=>{writes.push(r);rows2.push(r);return true;}},snapshots:rows2,token:'test',harvest:async()=>({status:'UNAVAILABLE',reason:'TEST_FAILURE'})});
 await h2.run();
 assert.strictEqual(writes.length,1);
 assert.strictEqual(writes[0].id,'y|OUTCOME|1');
 assert(writes[0].nextRetryAt);
 await h2.run();
 assert.strictEqual(writes.length,1);

 console.log('EDGE outcome harvester tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
