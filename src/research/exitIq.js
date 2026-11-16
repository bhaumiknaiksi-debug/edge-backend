'use strict';
// EXIT IQ V1: isolated, paired candle-reference experiments. Never an order authority.
// The common horizon starts at the first full minute AFTER the recorded entry ask.
const {modeledNet,SCENARIOS}=require('./triggeredExitV2');
const VERSION='EXIT_IQ_TOURNAMENT_V1',MIN=60000,IST=19800000,HORIZON=30,BASELINE='FIXED_8_8';
const POLICIES=Object.freeze([
 {id:BASELINE,stop:8,target:8},
 {id:'FIXED_14_7',stop:7,target:14},
 {id:'STEP_LOCK',stop:8,target:16,ratchet:'STEP'},
 {id:'CONVEX_RATCHET',stop:8,target:null,ratchet:'CONVEX'},
 {id:'STAGNATION_15',stop:8,target:8,stagnation:15},
 {id:'STEP_LOCK_STAGNATION',stop:8,target:16,ratchet:'STEP',stagnation:15}
].map(Object.freeze));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const stamp=x=>typeof x==='string'?Date.parse(x):NaN;
const iso=t=>new Date(t).toISOString();
const day=t=>iso(t+IST).slice(0,10);
const round=x=>Math.round(x*100)/100;
const fail=reason=>({version:VERSION,status:'UNAVAILABLE',reason,executionAllowed:false});
function number(x){return typeof x==='number'||typeof x==='string'&&x.trim()?Number(x):NaN;}
function pathFor(candles,start,end){
 if(!Array.isArray(candles))return null;
 const map=new Map();
 for(const raw of candles){
  const t=stamp(Array.isArray(raw)?raw[0]:raw?.timestamp);
  if(!(t>=start&&t<end))continue;
  if((t-start)%MIN!==0||map.has(t))return null;
  const [o,h,l,c]=(Array.isArray(raw)?raw.slice(1,5):[raw.open,raw.high,raw.low,raw.close]).map(number);
  if(![o,h,l,c].every(v=>finite(v)&&v>0)||h<Math.max(o,c)||l>Math.min(o,c))return null;
  map.set(t,{t,o,h,l,c});
 }
 const rows=[];
 for(let t=start;t<end;t+=MIN){if(!map.has(t))return null;rows.push(map.get(t));}
 return rows;
}
function candidateFloor(p,peak,entry,qty){
 if(p.ratchet==='STEP')return peak>=12?8:peak>=7?1.5:-p.stop;
 if(p.ratchet!=='CONVEX')return -p.stop;
 if(peak<5)return -p.stop;
 if(peak<9){
  // Estimate friction-clearing floor using existing stress-aware fee model, not a fixed promised breakeven.
  for(let x=0;x<=5;x+=.05){
   const n=modeledNet({entry,referenceExitPrice:entry+x,quantity:qty,exitHaircutPoints:1});
   if(n&&n.estimatedNetRupees>=0)return round(x);
  }
  return -p.stop;
 }
 return peak<20?peak*(.45+.012*(peak-9)):peak*Math.min(.82,.58+.008*(peak-20));
}
function simulate(p,rows,entry,qty){
 let floor=-p.stop,peak=0,exit=null;
 for(let i=0;i<rows.length;i++){
  const c=rows[i],stopPrice=entry+floor;
  // Only use previously completed bars for a raised stop. Unknown intrabar order => stop first.
  if(c.l<=stopPrice){exit={i,reason:floor>-p.stop?'RATCHET':'STOP',px:Math.min(c.o,stopPrice)};break;}
  if(p.target!==null&&c.h>=entry+p.target){exit={i,reason:'TARGET',px:entry+p.target};break;}
  peak=Math.max(peak,c.h-entry);
  if(p.stagnation&&i+1>=p.stagnation&&peak<3.5&&c.c-entry<1){
   exit={i,reason:'STAGNATION',px:c.c};break;
  }
  floor=Math.max(floor,candidateFloor(p,peak,entry,qty));
  // If the close is already through a newly raised floor, use that close rather than retroactive floor fill.
  if(c.c<=entry+floor){exit={i,reason:'RATCHET_AT_CLOSE',px:c.c};break;}
 }
 if(!exit)exit={i:rows.length-1,reason:'TIME',px:rows.at(-1).c};
 const px=round(Math.max(0,exit.px));
 const scenarios=Object.fromEntries(SCENARIOS.map(s=>[s.id,modeledNet({entry,quantity:qty,referenceExitPrice:px,exitHaircutPoints:s.exitHaircutPoints})]));
 const afterlife={};
 for(const minutes of [5,10,15]){
  const subsequent=rows.slice(exit.i+1,exit.i+1+minutes);
  afterlife[minutes]=subsequent.length===minutes?{
   status:'MEASURED_REFERENCE_ONLY',maxRisePoints:round(Math.max(0,...subsequent.map(c=>c.h-px))),
   maxFallPoints:round(Math.max(0,...subsequent.map(c=>px-c.l))),
   endChangePoints:round(subsequent.at(-1).c-px)
  }:{status:'UNAVAILABLE',reason:'OUTSIDE_COMMON_HORIZON'};
 }
 return {policy:p.id,reason:exit.reason,exitCandleAt:iso(rows[exit.i].t),minutes:exit.i+1,
  referenceExitPrice:px,priorCompletedBarMfePoints:round(peak),finalFloorPoints:round(floor),
  scenarios,afterlife};
}
function measureTournament({entry,candles,now=Date.now()}={}){
 const at=stamp(entry?.observedAt),analysisAt=stamp(entry?.analysisAt),qty=entry?.lotSize,ask=entry?.ask,bid=entry?.bid;
 if(!finite(now)||!finite(at)||!finite(analysisAt)||analysisAt>at||at-analysisAt>15000||!finite(ask)||!finite(bid)||bid<=0||ask<bid||
  !Number.isSafeInteger(qty)||qty<=0||typeof entry.instrumentKey!=='string'||!entry.instrumentKey||typeof entry.contractId!=='string'||!entry.contractId)
  return fail('ENTRY_QUOTE_UNAVAILABLE');
 const start=(Math.floor(at/MIN)+1)*MIN,end=start+HORIZON*MIN;
 if(at<Date.parse(day(at)+'T09:15:00+05:30')||end>Date.parse(day(at)+'T15:30:00+05:30'))return fail('FULL_COMMON_SESSION_WINDOW_UNAVAILABLE');
 if(now<end)return fail('COMMON_HORIZON_NOT_COMPLETE');
 const rows=pathFor(candles,start,end);
 if(!rows)return fail('INCOMPLETE_OR_INVALID_COMMON_PATH');
 const results=Object.fromEntries(POLICIES.map(p=>[p.id,simulate(p,rows,ask,qty)]));
 const mfe=Math.max(0,...rows.map(c=>c.h-ask)),mae=Math.max(0,...rows.map(c=>ask-c.l));
 for(const r of Object.values(results)){
  r.commonHorizonCapture=mfe>0?round((r.referenceExitPrice-ask)/mfe):null;
 }
 return {version:VERSION,status:'MEASURED',executionAllowed:false,baseline:BASELINE,
  entry:{instrumentKey:entry.instrumentKey,contractId:entry.contractId,tier:entry.tier,observedAt:entry.observedAt,ask,lotSize:qty},
  window:{firstCandleAt:iso(start),endExclusive:iso(end),minutes:HORIZON},
  commonHorizonReferenceMfePoints:round(mfe),commonHorizonReferenceMaePoints:round(mae),results,
  basis:'RECORDED_ASK; NEXT_FULL_MINUTE_OHLC; SAME_30M_PATH; STOP_FIRST; 0/1/2_POINT_EXIT_HAIRCUTS'};
}
function buildExitIqReport(events=[],outcomes=[],now=Date.now()){
 const byEvent=new Map(),counts=new Map();
 for(const e of events)if(e?.eventId){counts.set(e.eventId,(counts.get(e.eventId)||0)+1);byEvent.set(e.eventId,e);}
 const byKey=new Map(),id=(e,q)=>JSON.stringify([e.eventId,q.tier,q.instrumentKey]);
 for(const o of outcomes){
  const t=stamp(o?.timestamp);if(!finite(t)||t>now)continue;
  const k=JSON.stringify([o.eventId,o.entryTier,o.instrumentKey]),list=byKey.get(k)||[];
  list.push(o);byKey.set(k,list);
 }
 const pairs=[],missing={},seen=new Set(),days=new Set();
 const miss=k=>{missing[k]=(missing[k]||0)+1;};
 for(const e of byEvent.values()){
  if(counts.get(e.eventId)!==1){miss('DUPLICATE_EVENT');continue;}
  if(!finite(stamp(e.timestamp))||stamp(e.timestamp)>now)continue;
  if(!e.candidateQuotes?.length){miss('NO_ENTRY_QUOTE');continue;}
  for(const q of e.candidateQuotes){
   const k=id(e,q);if(seen.has(k))continue;seen.add(k);
   const rows=(byKey.get(k)||[]).filter(o=>o.session===e.session&&o.family===e.family&&o.direction===e.direction&&stamp(o.timestamp)>=stamp(e.timestamp))
    .sort((a,b)=>stamp(a.timestamp)-stamp(b.timestamp));
   const hit=rows.find(o=>o.outcome?.exitIq?.status==='MEASURED'),m=hit?.outcome?.exitIq;
   if(!m){miss(rows.at(-1)?.outcome?.exitIq?.reason||'NOT_RECORDED_OR_PENDING');continue;}
   if(m.version!==VERSION||m.baseline!==BASELINE||m.entry?.instrumentKey!==q.instrumentKey||m.entry?.contractId!==q.contractId||
    m.entry?.tier!==q.tier||m.entry?.observedAt!==q.observedAt||m.entry?.ask!==q.ask||m.entry?.lotSize!==q.lotSize||
    !finite(stamp(m.window?.endExclusive))||stamp(m.window.endExclusive)>stamp(hit.timestamp)||
    !POLICIES.every(p=>SCENARIOS.every(s=>finite(m.results?.[p.id]?.scenarios?.[s.id]?.estimatedNetRupees)))){
    miss('INVALID_PAIRED_MEASUREMENT');continue;
   }
   pairs.push(m);days.add(e.session);
  }
 }
 const mean=a=>a.length?round(a.reduce((x,y)=>x+y,0)/a.length):null;
 const report=POLICIES.map(p=>{
  const scenarios=Object.fromEntries(SCENARIOS.map(s=>{
   const nets=pairs.map(m=>m.results[p.id].scenarios[s.id].estimatedNetRupees);
   const diffs=pairs.map(m=>m.results[p.id].scenarios[s.id].estimatedNetRupees-m.results[BASELINE].scenarios[s.id].estimatedNetRupees);
   const gains=nets.filter(x=>x>0).reduce((a,b)=>a+b,0),losses=-nets.filter(x=>x<0).reduce((a,b)=>a+b,0);
   return [s.id,{meanNetRupees:mean(nets),pairedMeanDifferenceRupees:mean(diffs),wins:nets.filter(x=>x>0).length,losses:nets.filter(x=>x<0).length,profitFactor:losses?round(gains/losses):null}];
  }));
  return {policy:p.id,scenarios,meanHoldMinutes:mean(pairs.map(m=>m.results[p.id].minutes)),
   afterlifeCoverage:Object.fromEntries([5,10,15].map(n=>[n,pairs.filter(m=>m.results[p.id].afterlife?.[n]?.status==='MEASURED_REFERENCE_ONLY').length]))};
 });
 return {version:VERSION,baseline:BASELINE,entryRows:seen.size,matchedRows:pairs.length,distinctMeasuredSessions:days.size,missing,policies:report,
  executionAllowed:false,liveDecisionImpact:false,promotionEligible:false,
  limitations:['Modeled OHLC exits, not executable bid paths; partial entry minute unobserved.','Complete 30-minute path required even after early exit; missing data is not a loss.','Afterlife ends at the common horizon; late exits lack full post-exit observation.','Correlated tiers and strategy events are not independent trades. No account simulation or automatic winner promotion.','Baseline is existing research +8/-8, not exact paper executor. Session boundary unchanged from existing research.']};
}
module.exports={VERSION,POLICIES,BASELINE,measureTournament,buildExitIqReport};
