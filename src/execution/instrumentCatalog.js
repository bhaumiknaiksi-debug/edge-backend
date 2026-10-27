'use strict';
const {gunzipSync}=require('node:zlib');
const {day}=require('./sandboxEngine');
const SOURCE='https://assets.upstox.com/market-quote/instruments/exchange/NSE.csv.gz';
function parseCsv(text){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===','||c==='\n')){row.push(field.replace(/\r$/,''));field='';if(c==='\n'){rows.push(row);row=[];}}
    else field+=c;
  }
  if(quoted)throw Error('INVALID_INSTRUMENT_CSV');
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  const headers=rows.shift()||[];
  const required=['instrument_key','name','expiry','strike','tick_size','lot_size','instrument_type','option_type','exchange'];
  if(required.some(k=>!headers.includes(k)))throw Error('INVALID_INSTRUMENT_CSV');
  return rows.filter(r=>r.length===headers.length).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));
}
function fromCsv(text,session){
  const result={};
  for(const r of parseCsv(text)){
    if(r.name!=='NIFTY'||r.exchange!=='NSE_FO'||r.instrument_type!=='OPTIDX'||!['CE','PE'].includes(r.option_type))continue;
    if(!/^NSE_FO\|\d+$/.test(r.instrument_key)||!/^\d{4}-\d{2}-\d{2}$/.test(r.expiry)||
      !Number.isSafeInteger(Number(r.lot_size))||Number(r.lot_size)<=0||!Number.isFinite(Number(r.tick_size))||Number(r.tick_size)<=0||Number(r.strike)<=0)throw Error('INVALID_NIFTY_METADATA');
    if(result[r.instrument_key])throw Error('DUPLICATE_INSTRUMENT');
    // CSV publishes tick_size in rupees (e.g. 0.05); do not apply JSON's differently scaled field.
    result[r.instrument_key]={instrumentKey:r.instrument_key,underlying:'NIFTY',optionType:r.option_type,
      strike:Number(r.strike),expiry:r.expiry,lotSize:Number(r.lot_size),tickSizeRupees:Number(r.tick_size),session,source:'UPSTOX_NSE_BOD_CSV'};
  }
  if(!Object.keys(result).length)throw Error('NO_NIFTY_INSTRUMENTS');return result;
}
function createCatalog({request=fetch,now=Date.now}={}){
  let records={},session=null,lastAttempt=-Infinity,error=null,inFlight=null;
  async function refresh(){
    const time=now();if(session===day(time))return;
    if(inFlight)return inFlight;if(time-lastAttempt<15*60000)return;lastAttempt=time;
    inFlight=(async()=>{
      try{
        const response=await request(SOURCE,{redirect:'error',signal:AbortSignal.timeout(15000)});
        const modified=Date.parse(response.headers.get('last-modified'));
        if(!response.ok||!Number.isFinite(modified)||day(modified)!==day(time))throw Error('CURRENT_BOD_REQUIRED');
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw Error('BOD_TOO_LARGE');chunks.push(Buffer.from(value));}}
        finally{await reader.cancel().catch(()=>{});}
        const text=gunzipSync(Buffer.concat(chunks),{maxOutputLength:80*1024*1024}).toString('utf8');
        records=fromCsv(text,day(time));session=day(time);error=null;
      }catch(_){error='INSTRUMENT_CATALOG_UNAVAILABLE';}
    })().finally(()=>{inFlight=null;});return inFlight;
  }
  return {async get(key){await refresh();return session===day(now())?records[key]||null:null;},
    status:()=>({ready:session===day(now()),error})};
}
module.exports={createCatalog,fromCsv,parseCsv};
