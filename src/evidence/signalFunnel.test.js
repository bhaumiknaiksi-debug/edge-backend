'use strict';
const assert = require('assert');
const { buildSignalFunnel } = require('./signalFunnel');

function row(id, fail=null, tier='OBSERVING') {
  const gates={market:true,regime:true,strategy:true,setup:true,risk:true,position:true};
  const entry={triggerReady:true,priceReady:true,liquidityReady:true};
  if (fail in gates) gates[fail]=false;
  if (fail==='trigger') entry.triggerReady=false;
  if (fail==='price') entry.priceReady=false;
  if (fail==='liquidity') entry.liquidityReady=false;
  const ready=!fail;
  return {
    id,recordType:'POLL_SNAPSHOT',timestamp:'2026-10-07T05:00:00Z',
    strategy:'LONG_PUT',entry,orchestrationStatus:ready?'READY_TO_EXECUTE':'NO_TRADE',
    orchestration:{status:ready?'READY_TO_EXECUTE':'NO_TRADE',gates,blockers:fail?[String(fail).toUpperCase()]:[]},
    signalTier:{tier:ready?'A':tier}
  };
}
const out=buildSignalFunnel([row('1'),row('2','liquidity','B'),row('3','trigger','C')]);
assert.equal(out.stages.observations,3);
assert.equal(out.stages.ready,1);
assert.equal(out.tierCounts.A,1);
assert.equal(out.tierCounts.B,1);
assert.equal(out.tierCounts.C,1);
assert.equal(out.nearReadyCount,2);
assert.equal(out.version,'SIGNAL_FUNNEL_V2');
assert.ok(Array.isArray(out.researchDiagnostics));
console.log('signalFunnel tests passed');
