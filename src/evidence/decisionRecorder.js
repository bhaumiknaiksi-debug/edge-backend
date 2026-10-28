'use strict';
const {signalFingerprint}=require('./signalRecording');

// Decides what each poll persists, extracted unchanged from the server poll loop.
// FULL mode: every poll's observation is appended and append failures throw.
// LIGHTWEIGHT mode: only polls whose decision fingerprint changed are appended,
// and failures are logged so the live decision is preserved.
// The fingerprint only advances once the DECISION_TRANSITION row is durably saved,
// so a failed transition is retried on the next poll instead of being lost.
// onObservationAppended runs right after a successful observation append, before the
// transition append (which may throw in FULL mode), matching the original ordering.
function createDecisionRecorder({store,lightweight,log=console.error,onObservationAppended=()=>{}}){
  let lastFingerprint=null;
  async function record(snapshot,observed){
    const fingerprint=signalFingerprint(snapshot);
    const changed=fingerprint!==lastFingerprint;
    let saved=true;
    let observationAppended=false;
    if(!lightweight||changed){
      saved=await store.append(observed);
      if(!saved&&!lightweight)throw new Error('EVIDENCE_STORE_APPEND_FAILED');
      if(saved){observationAppended=true;onObservationAppended(observed);}
      else log('[evidence] optional lightweight append failed; live decision preserved');
    }
    let savedTransition=false;
    if(changed&&saved){
      const transition={...observed,id:observed.id+'|TRANSITION',recordType:'DECISION_TRANSITION'};
      savedTransition=await store.append(transition);
      if(!savedTransition&&!lightweight)throw new Error('EVIDENCE_TRANSITION_APPEND_FAILED');
      if(savedTransition)lastFingerprint=fingerprint;
      else log('[evidence] optional transition append failed; live decision preserved');
    }
    return {fingerprint,changed,observationAppended,savedTransition};
  }
  return {record,lastFingerprint:()=>lastFingerprint};
}
module.exports={createDecisionRecorder};
