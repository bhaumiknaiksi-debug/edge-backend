'use strict';
const assert=require('node:assert/strict');
const {createDecisionRecorder}=require('./decisionRecorder');
const {buildSignalTier}=require('../engine/signalTier');

// Tier B and Tier C share the contract and both have executionAllowed=false;
// only the chart verdict differs (AGREES vs CONTRADICTS).
const args={setup:{qualified:true},risk:{status:'READY'},position:{status:'READY'},strategy:'LONG_CALL',
 regime:{direction:'BULLISH'},marketPhase:'OPEN',orchestration:{status:'WAIT_FOR_TRIGGER'},
 entry:{triggerReady:false,priceReady:true,liquidityReady:true}};
let polls=0;
function poll(verdict){
  polls++;
  return {id:`poll-${polls}`,recordType:'POLL_SNAPSHOT',strategy:args.strategy,
    orchestrationStatus:'WAIT_FOR_TRIGGER',entryStatus:'WAIT_FOR_TRIGGER',entry:args.entry,
    signalTier:buildSignalTier({...args,chartIntelligence:{verdict}}),
    tradeLegs:{buyLeg:{instrumentKey:'NIFTY-CE-100',contractId:'NIFTY-CE-100',strike:100,type:'CE'}}};
}
const B=()=>poll('BULLISH');
const C=()=>poll('BEARISH');

// In-memory evidence store; `fail` holds the ids whose append should report failure.
function fakeStore(fail=new Set()){
  const rows=[];
  return {rows,fail,async append(row){if(fail.has(row.id))return false;rows.push(row);return true;}};
}
const transitions=store=>store.rows.filter(r=>r.recordType==='DECISION_TRANSITION');

(async()=>{
  // Slice 1: a failed transition append must not be lost; the next identical poll retries it.
  {
    const store=fakeStore(new Set(['poll-1|TRANSITION']));
    const recorder=createDecisionRecorder({store,lightweight:true,log:()=>{}});
    const first=B();
    const r1=await recorder.record(first,first);
    assert.equal(r1.savedTransition,false);
    assert.equal(transitions(store).length,0);
    const retry=B();
    const r2=await recorder.record(retry,retry);
    assert.equal(r2.changed,true,'unsaved transition must be retried on the next poll');
    assert.equal(r2.savedTransition,true);
    assert.deepEqual(transitions(store).map(r=>r.id),[`${retry.id}|TRANSITION`]);
  }

  // Slice 2: B -> C -> C -> B saves the B->C and C->B transitions even though the
  // contract and execution status never change; the repeated C poll saves nothing.
  {
    const store=fakeStore();
    const recorder=createDecisionRecorder({store,lightweight:true,log:()=>{}});
    const seq=[B(),C(),C(),B()];
    for(const s of seq)await recorder.record(s,s);
    assert.deepEqual(transitions(store).map(r=>r.signalTier.tier),['B','C','B']);
    assert.equal(store.rows.some(r=>r.id===seq[2].id),false,'repeated C poll must not be appended');
  }

  console.log('decisionRecorder PASS: transition retry, B<->C transitions');
})().catch(e=>{console.error(e);process.exit(1);});
