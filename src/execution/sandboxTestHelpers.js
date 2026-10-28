'use strict';
const {initialState}=require('./sandboxEngine');
// Same contract as sandboxStore: archive rows queued by a reducer commit atomically with the state.
function memoryStore(initial=initialState()){
 let state=structuredClone(initial),tail=Promise.resolve(),fail=false;const archive=new Map();
 return {
  async init(){},async read(){return structuredClone(state);},failNext(){fail=true;},
  mutate(fn){const run=tail.then(()=>{const next=structuredClone(state),result=fn(next);
   const queue=Array.isArray(next.archiveQueue)?next.archiveQueue:[];delete next.archiveQueue;
   if(fail){fail=false;throw Error('STORE_WRITE_FAILED');}
   for(const row of queue)if(!archive.has(row.id))archive.set(row.id,structuredClone(row));
   state=next;return {state:structuredClone(state),result};});tail=run.catch(()=>{});return run;},
  async readArchive(kind,limit=5000){return [...archive.values()].filter(r=>r.kind===kind).reverse().slice(0,limit).map(r=>structuredClone(r.payload));},
  archiveSize:()=>archive.size
 };
}
module.exports={memoryStore};
