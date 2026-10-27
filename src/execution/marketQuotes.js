'use strict';
// This credential is used exclusively for a fixed read-only market-data endpoint.
const {boundedJson}=require('./upstoxSandbox');
function createMarketQuotes({token,request=fetch,now=Date.now}={}){
  if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('MARKET_DATA_TOKEN_REQUIRED');
  return {async get(keys){
    keys=[...new Set(keys)];if(!keys.length)return {};
    if(keys.length>10||keys.some(k=>typeof k!=='string'||!/^NSE_FO\|\d+$/.test(k)))throw Error('INVALID_QUOTE_INSTRUMENTS');
    try{
      const url='https://api.upstox.com/v2/market-quote/quotes?instrument_key='+encodeURIComponent(keys.join(','));
      const response=await request(url,{method:'GET',redirect:'error',headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(7000)});
      const payload=await boundedJson(response);if(!response.ok||payload?.status!=='success'||!payload.data)throw Error();
      const receivedAt=now(),result={};
      for(const q of Object.values(payload.data)){
        if(!keys.includes(q.instrument_token))continue;
        const bid=q.depth?.buy?.[0]?.price,ask=q.depth?.sell?.[0]?.price;
        const exchangeAt=typeof q.timestamp==='number'||/^\d{13}$/.test(q.timestamp||'')?Number(q.timestamp):Date.parse(q.timestamp);
        if(!Number.isFinite(exchangeAt)||exchangeAt>receivedAt+1000||receivedAt-exchangeAt>10000||
          typeof bid!=='number'||typeof ask!=='number'||bid<=0||ask<bid)continue;
        result[q.instrument_token]={instrumentKey:q.instrument_token,bid,ask,receivedAt,exchangeAt};
      }
      return result;
    }catch(_){throw Error('MARKET_QUOTES_UNAVAILABLE');}
  }};
}
module.exports={createMarketQuotes};
