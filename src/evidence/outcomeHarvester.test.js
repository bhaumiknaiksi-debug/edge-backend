'use strict';
const assert=require('assert');
const {eligible,harvestOutcome}=require('./outcomeHarvester');
const old=new Date(Date.now()-121*60000).toISOString();
const snapshot={id:'x',recordType:'POLL_SNAPSHOT',timestamp:old,orchestrationStatus:'READY_TO_EXECUTE',strategy:'LONG_CALL',tradeLegs:{buyLeg:{contractId:'NIFTY TEST CE',instrumentKey:'NSE_FO|123',premium:100,ask:101,bid:99}}};
assert.strictEqual(eligible(snapshot),true);
assert.strictEqual(eligible({...snapshot,orchestrationStatus:'WAIT_FOR_TRIGGER'}),false);
assert.strictEqual(eligible({...snapshot,tradeLegs:{buyLeg:{...snapshot.tradeLegs.buyLeg,instrumentKey:null}}}),false);
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
 console.log('EDGE outcome harvester tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
