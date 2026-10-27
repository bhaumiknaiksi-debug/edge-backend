'use strict';
// Isolated sandbox transport: no configurable host, live token fallback, or server wiring.
const URL='https://sandbox.upstox.com/v3/order/place';
function createSandbox({token,request=fetch}={}) {
  if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('SANDBOX_TOKEN_REQUIRED');
  if(typeof request!=='function')throw Error('SANDBOX_TRANSPORT_REQUIRED');
  async function placeLimit({instrumentKey,quantity,price,side,tag}) {
    if(typeof instrumentKey!=='string'||!/^NSE_FO\|[A-Za-z0-9]+$/.test(instrumentKey)||
      !Number.isSafeInteger(quantity)||quantity<=0||quantity>100000||typeof price!=='number'||!Number.isFinite(price)||price<=0||
      !['BUY','SELL'].includes(side)||typeof tag!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(tag))throw Error('INVALID_SANDBOX_ORDER');
    const body={quantity,product:'I',validity:'DAY',price,tag,instrument_token:instrumentKey,order_type:'LIMIT',
      transaction_type:side,disclosed_quantity:0,trigger_price:0,is_amo:false,slice:false};
    let response;
    try { response=await request(URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Accept':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)}); }
    catch (_) {return {state:'UNCERTAIN',reason:'TRANSPORT_UNCONFIRMED',tag};}
    let payload;
    try {payload=await response.json();}catch(_){return {state:'UNCERTAIN',reason:'INVALID_RESPONSE',tag};}
    // Acceptance is not a fill. Any ambiguous response remains unknown and is never retried here.
    if(response.ok && payload?.status==='success' && Array.isArray(payload?.data?.order_ids) &&
       payload.data.order_ids.length===1 && typeof payload.data.order_ids[0]==='string' && payload.data.order_ids[0])
      return {state:'ACKNOWLEDGED',orderId:payload.data.order_ids[0],tag};
    if(response.status>=400&&response.status<500 && response.status!==408 && response.status!==429 && payload?.status==='error')
      return {state:'REJECTED',reason:'SANDBOX_REQUEST_REJECTED',tag};
    return {state:'UNCERTAIN',reason:'AMBIGUOUS_RESPONSE',tag};
  }
  return {placeLimit};
}
module.exports={createSandbox};
