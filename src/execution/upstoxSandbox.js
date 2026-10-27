'use strict';
// Host is deliberately fixed. No live mode, live-token fallback or redirect following.
const BASE='https://sandbox.upstox.com';
const idPattern=/^[A-Za-z0-9-]{1,100}$/;
async function boundedJson(response,maxBytes=2*1024*1024){
  if(!response.body?.getReader)throw Error('INVALID_RESPONSE');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function createSandbox({token,request=fetch}={}){
  if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('SANDBOX_TOKEN_REQUIRED');
  if(typeof request!=='function')throw Error('SANDBOX_TRANSPORT_REQUIRED');
  async function call(method,path,body){
    try{
      const response=await request(BASE+path,{method,redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:'Bearer '+token},
        ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(7000)});
      const payload=await boundedJson(response).catch(()=>null);
      return {ok:response.ok,status:response.status,payload};
    }catch(_){return null;}
  }
  async function placeOrder({instrumentKey,quantity,price,side,tag,orderType='LIMIT',trigger=0}){
    if(typeof instrumentKey!=='string'||!/^NSE_FO\|[A-Za-z0-9]+$/.test(instrumentKey)||
      !Number.isSafeInteger(quantity)||quantity<=0||quantity>100000||typeof price!=='number'||!Number.isFinite(price)||price<=0||
      !['BUY','SELL'].includes(side)||typeof tag!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(tag)||
      !['LIMIT','SL'].includes(orderType)||(orderType==='SL'&&(side!=='SELL'||!Number.isFinite(trigger)||trigger<=price))||
      (orderType==='LIMIT'&&trigger!==0))throw Error('INVALID_SANDBOX_ORDER');
    const body={quantity,product:'I',validity:'DAY',price,tag,instrument_token:instrumentKey,order_type:orderType,
      transaction_type:side,disclosed_quantity:0,trigger_price:trigger,is_amo:false,slice:false};
    const reply=await call('POST','/v3/order/place',body);
    if(reply?.ok&&reply.payload?.status==='success'&&Array.isArray(reply.payload.data?.order_ids)&&reply.payload.data.order_ids.length===1&&typeof reply.payload.data.order_ids[0]==='string'&&idPattern.test(reply.payload.data.order_ids[0]))
      return {state:'ACKNOWLEDGED',orderId:reply.payload.data.order_ids[0],tag};
    return failure(reply,tag);
  }
  function failure(reply,tag){
    if(reply?.status>=400&&reply.status<500&&![408,429].includes(reply.status)&&reply.payload?.status==='error')return {state:'REJECTED',reason:'SANDBOX_REQUEST_REJECTED',...(tag?{tag}:{})};
    return {state:'UNCERTAIN',reason:'TRANSPORT_OR_ACK_UNCONFIRMED',...(tag?{tag}:{})};
  }
  async function cancel(orderId){
    if(typeof orderId!=='string'||!idPattern.test(orderId))throw Error('INVALID_ORDER_ID');
    const reply=await call('DELETE','/v3/order/cancel?order_id='+encodeURIComponent(orderId));
    if(reply?.ok&&reply.payload?.status==='success'&&reply.payload.data?.order_id===orderId)return {state:'ACKNOWLEDGED',orderId};
    return failure(reply);
  }
  async function read(path){const reply=await call('GET',path);if(!reply?.ok||reply.payload?.status!=='success'||!Array.isArray(reply.payload.data)){const error=Error('SANDBOX_READ_UNAVAILABLE');error.httpStatus=Number.isInteger(reply?.status)?reply.status:null;throw error;}return reply.payload.data;}
  return {placeOrder,placeLimit:placeOrder,cancel,getOrders:()=>read('/v2/order/retrieve-all'),getPositions:()=>read('/v2/portfolio/short-term-positions')};
}
module.exports={createSandbox,boundedJson};
