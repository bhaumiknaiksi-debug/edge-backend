'use strict';
// Historical Kite tradebook import. Intentionally never changes live ledger risk or READY eligibility.
// Excel files are parsed locally in the browser; this module validates broker fills again.
const MAX_BATCH=120, MAX_STORED=5000;
const rounded=n=>Math.round((n+Number.EPSILON)*100)/100;
function validText(v,label,re,max=80){
  if(typeof v!=='string'||v.length>max||!re.test(v))throw new Error('INVALID_'+label);
  return v;
}
function normalizeFill(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('INVALID_FILL');
  const symbol=validText(raw.symbol,'SYMBOL',/^NIFTY[0-9A-Z]{6,30}(CE|PE)$/,46);
  const exchange=validText(raw.exchange,'EXCHANGE',/^(NSE|NFO)$/,4);
  const date=validText(raw.tradeDate,'TRADE_DATE',/^\d{4}-\d{2}-\d{2}$/,10);
  const time=validText(raw.time,'EXECUTION_TIME',/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,19);
  if(!time.startsWith(date+'T'))throw new Error('INVALID_EXECUTION_DATE_MISMATCH');
  const parsed=new Date(time+'+05:30');
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)==='0000'
     ||new Date(parsed.getTime()+330*60000).toISOString().slice(0,19)!==time)
    throw new Error('INVALID_EXECUTION_TIME');
  const side=validText(raw.side,'SIDE',/^(buy|sell)$/i,4).toUpperCase();
  const tradeId=validText(String(raw.tradeId||''),'TRADE_ID',/^[0-9A-Za-z_-]{1,32}$/,32);
  const orderId=validText(String(raw.orderId||''),'ORDER_ID',/^[0-9A-Za-z_-]{1,32}$/,32);
  if(typeof raw.quantity!=='number'||!Number.isInteger(raw.quantity)||raw.quantity<1||raw.quantity>1000000)throw new Error('INVALID_QUANTITY');
  if(typeof raw.price!=='number'||!Number.isFinite(raw.price)||raw.price<=0||raw.price>100000)throw new Error('INVALID_PRICE');
  const price=rounded(raw.price);
  if(Math.abs(price-raw.price)>0.00001)throw new Error('INVALID_PRICE_PRECISION');
  // Trade IDs can repeat across sessions, so include date + order + instrument.
  const key=[exchange,date,orderId,tradeId,symbol,side].join('|');
  return {key,symbol,exchange,tradeDate:date,time,side,tradeId,orderId,quantity:raw.quantity,price};
}
function importBrokerFills(state,input){
  if(!input||!Array.isArray(input.fills)||input.fills.length<1||input.fills.length>MAX_BATCH)throw new Error('INVALID_IMPORT_BATCH');
  const clientId=validText(input.clientId,'CLIENT_ID',/^[A-Za-z0-9_-]{3,24}$/,24).toUpperCase();
  if(state.brokerClientId&&state.brokerClientId!==clientId)throw new Error('INVALID_CLIENT_ID_MISMATCH');
  const existing=Array.isArray(state.brokerFills)?state.brokerFills:[];
  if(existing.length>MAX_STORED)throw new Error('INVALID_IMPORT_LIMIT');
  const known=new Map(existing.map(f=>[f.key,f]));
  const next=[];
  for(const raw of input.fills){
    const f=normalizeFill(raw);
    const before=known.get(f.key);
    if(before){
      const cmp=['symbol','exchange','tradeDate','time','side','tradeId','orderId','quantity','price'];
      if(cmp.some(k=>before[k]!==f[k]))throw new Error('INVALID_DUPLICATE_CONFLICT');
    } else {
      known.set(f.key,f);
      next.push(f);
    }
  }
  if(existing.length+next.length>MAX_STORED)throw new Error('INVALID_IMPORT_LIMIT');
  state.brokerClientId=clientId;
  state.brokerFills=existing.concat(next);
  return {added:next.length,duplicates:input.fills.length-next.length};
}
function summarizeBroker(state){
  const fills=Array.isArray(state.brokerFills)?state.brokerFills:[];
  const byContract=new Map();
  for(const f of fills){if(!byContract.has(f.symbol))byContract.set(f.symbol,[]);byContract.get(f.symbol).push(f);}
  const episodes=[];let unmatchedSellQuantity=0,openBuyQuantity=0,matchedQuantity=0;
  for(const [symbol,rows] of byContract){
    rows.sort((a,b)=>a.time.localeCompare(b.time)||a.orderId.localeCompare(b.orderId)||a.tradeId.localeCompare(b.tradeId));
    let lotQueue=[],opened=null,inValue=0,outValue=0,quantity=0,gross=0,closed=null;
    for(const f of rows){
      if(f.side==='BUY'){
        if(!lotQueue.length){opened=f.time;inValue=0;outValue=0;quantity=0;gross=0;closed=null;}
        lotQueue.push({quantity:f.quantity,price:f.price});
        inValue+=f.quantity*f.price;quantity+=f.quantity;
      }else{
        let remaining=f.quantity;
        while(remaining&&lotQueue.length){
          const lot=lotQueue[0],matched=Math.min(remaining,lot.quantity);
          outValue+=matched*f.price;
          gross+=(f.price-lot.price)*matched;
          matchedQuantity+=matched;
          lot.quantity-=matched;
          remaining-=matched;
          if(!lot.quantity)lotQueue.shift();
        }
        if(remaining)unmatchedSellQuantity+=remaining; // short / missing buy; never infer a profit.
        if(quantity&&lotQueue.length===0){
          closed=f.time;
          const matchedQty=quantity;
          episodes.push({symbol,quantity:matchedQty,openedAt:opened,closedAt:closed,
            entry:rounded(inValue/matchedQty),exit:rounded(outValue/matchedQty),
            grossPnl:rounded(gross),charges:null,netPnl:null,source:'KITE_TRADEBOOK'});
          opened=null;inValue=0;outValue=0;quantity=0;gross=0;
        }
      }
    }
    openBuyQuantity+=lotQueue.reduce((sum,lot)=>sum+lot.quantity,0);
  }
  episodes.sort((a,b)=>b.closedAt.localeCompare(a.closedAt)||a.symbol.localeCompare(b.symbol));
  const grossPnl=rounded(episodes.reduce((sum,t)=>sum+t.grossPnl,0));
  return {
    summary:{source:'KITE_TRADEBOOK',importedFills:fills.length,completedTrades:episodes.length,
      grossPnl,chargesKnown:false,unmatchedSellQuantity,openBuyQuantity,matchedQuantity,
      affectsRiskLedger:false},
    episodes:episodes.slice(0,200)
  };
}
module.exports={normalizeFill,importBrokerFills,summarizeBroker,MAX_BATCH};
