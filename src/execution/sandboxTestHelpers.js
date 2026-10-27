'use strict';
const {initialState}=require('./sandboxEngine');
function memoryStore(initial=initialState()){
 let state=structuredClone(initial),tail=Promise.resolve(),fail=false;
 return {
  async init(){},async read(){return structuredClone(state);},failNext(){fail=true;},
  mutate(fn){const run=tail.then(()=>{const next=structuredClone(state),result=fn(next);if(fail){fail=false;throw Error('STORE_WRITE_FAILED');}state=next;return {state:structuredClone(state),result};});tail=run.catch(()=>{});return run;}
 };
}
module.exports={memoryStore};
