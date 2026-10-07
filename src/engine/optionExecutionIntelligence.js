'use strict';

const https=require('https');
const { normalizeCandles }=require('./setupObservability');
const { structure, candlePressure }=require('./chartIntelligence');

const API_BASE='https://api.upstox.com';
const CACHE_MS=45*1000;
const cache=new Map();

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=3){return Number(Number(v).toFixed(dp));}

function requestJson(path,token){
  return new Promise((resolve,reject)=>{
    const url=new URL(API_BASE+path);
    const req=https.request(url,{method:'GET',headers:{Authorization:'Bearer '+(token||''),Accept:'application/json'}},res=>{
      let body='';res.on('data',d=>body+=d);res.on('end',()=>{
        let parsed;try{parsed=JSON.parse(body);}catch(_){return reject(new Error('Option chart JSON parse failed'));}
        if(res.statusCode<200||res.statusCode>=300||parsed.status==='error')return reject(new Error('Option chart HTTP '+res.statusCode));
        resolve(parsed);
      });
    });
    req.setTimeout(10000,()=>req.destroy(new Error('Option chart request timed out')));
    req.on('error',reject);req.end();
  });
}
function ema(values,period){
  const xs=(values||[]).filter(Number.isFinite);
  if(xs.length<period)return null;
  const k=2/(period+1);
  let out=xs.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const x of xs.slice(period))out=(x*k)+(out*(1-k));
  return out;
}
function rsi(values,period=5){
  const xs=(values||[]).filter(Number.isFinite);
  if(xs.length<period+1)return null;
  const diffs=[];for(let i=1;i<xs.length;i++)diffs.push(xs[i]-xs[i-1]);
  const sample=diffs.slice(-period);
  const gains=sample.reduce((a,d)=>a+Math.max(0,d),0)/period;
  const losses=sample.reduce((a,d)=>a+Math.max(0,-d),0)/period;
  if(losses===0)return 100;
  const rs=gains/losses;return 100-(100/(1+rs));
}
function premiumVwap(candles){
  const rows=(candles||[]).filter(c=>Number.isFinite(c.volume)&&c.volume>0);
  if(!rows.length)return{available:false,value:null,distancePct:null,relativeVolume:null};
  let pv=0,vol=0;for(const c of rows){pv+=((c.high+c.low+c.close)/3)*c.volume;vol+=c.volume;}
  const value=pv/vol,last=rows.at(-1);
  const priors=rows.slice(Math.max(0,rows.length-21),-1).map(c=>c.volume).filter(v=>v>0);
  const avg=priors.length?priors.reduce((a,b)=>a+b,0)/priors.length:null;
  return{available:true,value:round(value,2),distancePct:value?round((last.close-value)/value*100,3):null,relativeVolume:avg?round(last.volume/avg,2):null};
}
function analyseCandles(raw){
  const candles=normalizeCandles(raw),closes=candles.map(c=>c.close);
  if(!candles.length)return{available:false,candleCount:0};
  const e9=ema(closes,9),e21=ema(closes,21),r5=rsi(closes,5),vwap=premiumVwap(candles);
  const s=structure(candles),pressure=candlePressure(candles);
  const last=candles.at(-1);
  const emaState=e9===null||e21===null?'UNAVAILABLE':e9>e21?'EMA9_ABOVE_21':e9<e21?'EMA9_BELOW_21':'EMA_EQUAL';
  const vwapState=!vwap.available?'UNAVAILABLE':last.close>vwap.value?'ABOVE_VWAP':last.close<vwap.value?'BELOW_VWAP':'AT_VWAP';
  return{available:true,candleCount:candles.length,lastClose:round(last.close,2),structure:s,pressure,ema:{ema9:e9===null?null:round(e9,2),ema21:e21===null?null:round(e21,2),state:emaState,separationPct:e9!==null&&e21?round((e9-e21)/e21*100,3):null},rsi5:r5===null?null:round(r5,2),vwap:{...vwap,state:vwapState}};
}
async function fetchInterval(instrumentKey,minutes,token){
  const key=instrumentKey+'|'+minutes,now=Date.now(),hit=cache.get(key);
  if(hit&&now-hit.at<CACHE_MS)return hit.value;
  const parsed=await requestJson('/v3/historical-candle/intraday/'+encodeURIComponent(instrumentKey)+'/minutes/'+minutes,token);
  const value=parsed?.data?.candles||[];
  cache.set(key,{at:now,value});return value;
}
function planLegs(plan){
  const l=plan?.legs||{},out=[];
  for(const [name,leg] of Object.entries(l)){
    if(leg&&typeof leg==='object'&&leg.instrumentKey)out.push({name,leg});
  }
  return out;
}
function primaryLeg(plan){
  const l=plan?.legs||{};
  return l.buyLeg||l.sellLeg||l.peShort||l.ceShort||l.peLong||l.ceLong||null;
}
async function buildOptionExecutionIntelligence({candidatePlans=null,token='' }={}){
  const plans=candidatePlans?.plans||{};
  const unique=new Map();
  for(const tier of ['A','B','C']){
    const p=plans[tier];if(!p?.available)continue;
    for(const x of planLegs(p))if(x.leg.instrumentKey&&!unique.has(x.leg.instrumentKey))unique.set(x.leg.instrumentKey,x.leg);
  }
  const data=new Map();
  await Promise.all([...unique.entries()].slice(0,8).map(async([key,leg])=>{
    try{
      const five=await fetchInterval(key,5,token);
      data.set(key,{leg,five:analyseCandles(five),error:null});
    }catch(err){data.set(key,{leg,five:{available:false,candleCount:0},error:err.message});}
  }));
  const primaryKeys=new Set(['A','B','C'].map(t=>primaryLeg(plans[t])?.instrumentKey).filter(Boolean));
  await Promise.all([...primaryKeys].slice(0,3).map(async key=>{
    const row=data.get(key)||{leg:unique.get(key),five:{available:false}};
    try{row.one=analyseCandles(await fetchInterval(key,1,token));}
    catch(err){row.one={available:false,candleCount:0};row.oneMinuteError=err.message;}
    data.set(key,row);
  }));

  const out={};
  for(const tier of ['A','B','C']){
    const p=plans[tier];
    if(!p?.available){out[tier]={available:false};continue;}
    const legs=planLegs(p).map(x=>({role:x.name,contractId:x.leg.contractId||null,instrumentKey:x.leg.instrumentKey,oneMinute:data.get(x.leg.instrumentKey)?.one||null,fiveMinute:data.get(x.leg.instrumentKey)?.five||null,error:data.get(x.leg.instrumentKey)?.error||null}));
    const primary=primaryLeg(p);
    out[tier]={available:legs.some(x=>x.fiveMinute?.available),strategy:p.strategy||null,primaryContractId:primary?.contractId||null,legs};
  }
  return{
    version:'OPTION_EXECUTION_INTELLIGENCE_V1',researchOnly:true,liveDecisionImpact:false,
    methodology:'Option premium charts refine execution research only. NIFTY underlying remains the directional source of truth. No premium-chart observation can authorize a live trade.',
    tiers:out
  };
}
module.exports={buildOptionExecutionIntelligence,analyseCandles,ema,rsi,premiumVwap};
