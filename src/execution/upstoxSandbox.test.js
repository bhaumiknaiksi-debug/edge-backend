'use strict';
const assert=require('node:assert/strict');
const {createSandbox}=require('./upstoxSandbox');
(async()=>{
 const order={instrumentKey:'NSE_FO|12345',quantity:65,price:100,side:'BUY',tag:'edge-test-1'};
 let calls=0;
 const s=createSandbox({token:'sandbox-secret',request:async(url,options)=>{
   calls++;assert.equal(url,'https://sandbox.upstox.com/v3/order/place');assert.equal(options.redirect,'error');
   const body=JSON.parse(options.body);assert.equal(body.instrument_token,order.instrumentKey);assert.equal(body.order_type,'LIMIT');assert.equal(body.slice,false);
   return {ok:true,status:200,json:async()=>({status:'success',data:{order_ids:['123']}})};
 }});
 assert.deepEqual(await s.placeLimit(order),{state:'ACKNOWLEDGED',orderId:'123',tag:order.tag});assert.equal(calls,1);
 await assert.rejects(()=>s.placeLimit({...order,quantity:0}),/INVALID_SANDBOX_ORDER/);assert.equal(calls,1);
 const timeout=createSandbox({token:'secret',request:async()=>{throw Error('secret');}});
 assert.deepEqual(await timeout.placeLimit(order),{state:'UNCERTAIN',reason:'TRANSPORT_UNCONFIRMED',tag:order.tag});
 const invalid=createSandbox({token:'secret',request:async()=>({ok:true,status:200,json:async()=>({status:'success',data:{order_ids:['1','2']}})})});
 assert.equal((await invalid.placeLimit(order)).state,'UNCERTAIN');
 const reject=createSandbox({token:'secret',request:async()=>({ok:false,status:400,json:async()=>({status:'error',errors:[{message:'secret'}]})})});
 assert.deepEqual(await reject.placeLimit(order),{state:'REJECTED',reason:'SANDBOX_REQUEST_REJECTED',tag:order.tag});
 assert.throws(()=>createSandbox({token:''}),/SANDBOX_TOKEN_REQUIRED/);
 console.log('Upstox sandbox transport PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
