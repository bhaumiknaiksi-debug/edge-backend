'use strict';
// Research hypotheses ONLY. Never changes V3, entry gates, strikes, risk or order flow.
// Hypotheses: ORB close crossing on 1m / assembled 3m candles, and futures-VWAP
// pullback/resumption on settled five-minute futures candles.
const {createHash}=require('node:crypto');
const {RULES,PRIMARY,normalize}=require('./quickExit');
const {evaluateRule}=require('./triggeredExitV2');
const VERSION='TIMING_LAB_V1', IST=19800000, MIN=60000, FIVE=5*MIN, THREE=3*MIN;
const DAYSTART='T09:15:00+05:30';
const SETTLE_MS=30000, CONFIRM_MS=60000, RECENT_MS=5*MIN;
const FAMILIES=['ORB_1M','ORB_3M','FUTURES_VWAP_PULLBACK'];
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const day=t=>new Date(t+IST).toISOString().slice(0,10);
const time=t=>new Date(t).toISOString();
const round=x=>Math.round(x*10000)/10000;
const valid=x=>typeof x==='number'&&Number.isFinite(x);
function parsed(raw,period,now,session){
 const start=Date.parse(session+DAYSTART),map=new Map();
 for(const row of raw||[]){
  if(!Array.isArray(row)||row.length<5)continue;
  const t=Date.parse(row[0]),o=Number(row[1]),h=Number(row[2]),l=Number(row[3]),c=Number(row[4]),v=Number(row[5]);
  if(!Number.isFinite(t)||t<start||(t-start)%period!==0||day(t)!==session||t+period>now-SETTLE_MS)continue;
  if(![o,h,l,c].every(x=>Number.isFinite(x)&&x>0)||h<Math.max(o,c)||l>Math.min(o,c)||h<l)
   return {ok:false,reason:'INVALID_PROVIDER_CANDLE',rows:[]};
  if(map.has(t))return {ok:false,reason:'DUPLICATE_PROVIDER_CANDLE',rows:[]};
  map.set(t,{t,o,h,l,c,v:Number.isFinite(v)&&v>0?v:0});
 }
 const rows=[...map.values()].sort((a,b)=>a.t-b.t);
 if(!rows.length)return {ok:false,reason:'MISSING_COMPLETE_CANDLES',rows};
 if(rows[0].t!==start)return {ok:false,reason:'SESSION_START_MISSING',rows};
 for(let i=1;i<rows.length;i++)if(rows[i].t!==rows[i-1].t+period)
  return {ok:false,reason:'SESSION_CANDLE_GAP',rows};
 // Do not report on stale data after a skipped fetch/poll.
 if(now-(rows.at(-1).t+period)>3*period)return {ok:false,reason:'LATEST_CANDLE_STALE',rows};
 return {ok:true,rows};
}
function aggregate3(rows,session){
 const start=Date.parse(session+DAYSTART),out=[];
 for(let i=0;i+2<rows.length;i+=3){
  const slice=rows.slice(i,i+3);
  if(slice.length<3||slice[0].t!==start+i*MIN||
     slice[1].t!==slice[0].t+MIN||slice[2].t!==slice[1].t+MIN)break;
  out.push({t:slice[0].t,o:slice[0].o,h:Math.max(...slice.map(c=>c.h)),
   l:Math.min(...slice.map(c=>c.l)),c:slice[2].c});
 }
 return out;
}
function openingAnchor(index5m,now,session){
 const d=parsed(index5m,FIVE,now,session);
 if(!d.ok)return {ok:false,reason:'OPENING_5M_'+d.reason};
 const start=Date.parse(session+DAYSTART),opening=d.rows.filter(c=>c.t>=start&&c.t<start+3*FIVE);
 if(opening.length!==3)return {ok:false,reason:'OPENING_RANGE_NOT_COMPLETED'};
 return {ok:true,high:Math.max(...opening.map(c=>c.h)),low:Math.min(...opening.map(c=>c.l)),
  source:'NIFTY_INDEX_5M_0915_0930'};
}
function breakoutCrossings(rows,period,anchor,now,session,family){
 const start=Date.parse(session+'T09:30:00+05:30');
 const output=[];
 for(let i=1;i<rows.length;i++){
  const p=rows[i-1],c=rows[i],closed=c.t+period;
  if(c.t<start||now-closed>RECENT_MS)continue;
  const dir=p.c<=anchor.high&&c.c>anchor.high?'UP':p.c>=anchor.low&&c.c<anchor.low?'DOWN':null;
  if(dir)output.push({family,direction:dir,closedAt:time(closed),close:round(c.c),
   level:dir==='UP'?anchor.high:anchor.low,source:anchor.source});
 }
 return output;
}
function futuresVwapCrossings(rows,now){
 const output=[];
 if(rows.length<7)return output;
 // Only already-completed futures bars contribute. Index spot cannot be assigned volume.
 let value=0,volume=0;const vwap=[];
 for(const c of rows){
  if(c.v<=0)return output;
  const typical=(c.h+c.l+c.c)/3;value+=typical*c.v;volume+=c.v;
  vwap.push(value/volume);
 }
 const i=rows.length-1,p=rows[i-1],c=rows[i],prior=vwap[i-1],current=vwap[i];
 if(now-(c.t+FIVE)>RECENT_MS)return output;
 const slopeUp=current>vwap[i-3]&&prior>vwap[i-4],slopeDown=current<vwap[i-3]&&prior<vwap[i-4];
 const up=slopeUp&&p.l<=prior*1.0007&&p.c>=prior&&c.c>p.h&&c.c>current&&c.c>rows[i-5].c;
 const down=slopeDown&&p.h>=prior*0.9993&&p.c<=prior&&c.c<p.l&&c.c<current&&c.c<rows[i-5].c;
 const direction=up?'UP':down?'DOWN':null;
 if(direction)output.push({family:'FUTURES_VWAP_PULLBACK',direction,closedAt:time(c.t+FIVE),
  close:round(c.c),level:round(current),source:'NEAREST_NIFTY_FUTURE_VOLUME_WEIGHTED_5M'});
 return output;
}
function createTimingLab(){
 let activeDay=null,frozenAnchor=null;const pending=new Map(),emitted=new Set();
 function observe({now=Date.now(),index1m=[],index5m=[],future5m=[],index1mFetchedAt=now}={}){
  const session=day(now);
  if(activeDay!==session){activeDay=session;frozenAnchor=null;pending.clear();emitted.clear();}
  const anchor=openingAnchor(index5m,now,session);
  if(!anchor.ok)return {status:anchor.reason,events:[],session,liveDecisionImpact:false};
  if(!frozenAnchor)frozenAnchor={high:anchor.high,low:anchor.low};
  if(frozenAnchor.high!==anchor.high||frozenAnchor.low!==anchor.low)
   return {status:'OPENING_RANGE_REVISED',events:[],session,liveDecisionImpact:false};
  const minute=parsed(index1m,MIN,now,session),future=parsed(future5m,FIVE,now,session);
  const candidates=[];
  if(minute.ok){
   candidates.push(...breakoutCrossings(minute.rows,MIN,anchor,now,session,'ORB_1M'));
   candidates.push(...breakoutCrossings(aggregate3(minute.rows,session),THREE,anchor,now,session,'ORB_3M'));
  }
  if(future.ok)candidates.push(...futuresVwapCrossings(future.rows,now));
  const events=[];
  for(const c of candidates){
   const signature=sha([session,c.family,c.direction,c.closedAt,c.level]);
   if(emitted.has(signature))continue;
   const prior=pending.get(signature);
   if(!prior||prior.close!==c.close||index1mFetchedAt<=prior.readAt||index1mFetchedAt-prior.readAt<CONFIRM_MS){
    if(!prior||prior.close!==c.close)pending.set(signature,{seenAt:now,close:c.close,readAt:index1mFetchedAt});
    continue;
   }
   const closed=Date.parse(c.closedAt);
   if(closed>now-SETTLE_MS||now-closed>RECENT_MS)continue;
   events.push({id:signature,session,family:c.family,direction:c.direction,
    level:c.level,close:c.close,candleClosedAt:c.closedAt,firstSeenAt:time(prior.seenAt),
    confirmedAt:time(now),source:c.source,confirmation:'TWO_MATCHING_READS_60S_APART',
    executionAllowed:false});
  }
  // Prevent stale pending entries accumulating all day.
  for(const [key,v] of pending)if(now-v.seenAt>10*MIN)pending.delete(key);
  return {status:minute.ok?(future.ok?'OK':'FUTURES_'+future.reason):'INDEX_1M_'+minute.reason,
   events,session,openingRange:{...frozenAnchor},index1mReady:minute.ok,futures5mReady:future.ok,
   liveDecisionImpact:false,executionAllowed:false};
 }
 return {observe,ack(events){for(const e of events||[])if(e?.id)emitted.add(e.id);}};
}
function candidateQuotes(analysis,direction,observedAt,lotSize){
 const plans=analysis?.decision?.researchCandidatePlans?.plans||{};
 const at=Date.parse(analysis?.timestamp||'');
 if(!Number.isFinite(at)||observedAt<at||observedAt-at>15000)return [];
 const strategy=direction==='UP'?'LONG_CALL':'LONG_PUT';
 return ['A','B','C'].flatMap(tier=>{
  const p=plans[tier],leg=p?.legs?.buyLeg;
  if(!p?.available||p.strategy!==strategy||p?.legs?.sellLeg||!leg?.instrumentKey||!leg?.contractId||
   !(valid(leg.ask)&&leg.ask>0&&valid(leg.bid)&&leg.bid>0&&leg.ask>=leg.bid))return [];
  const q=Number(p.legs.lotSize||lotSize);
  if(!Number.isSafeInteger(q)||q<=0)return [];
  return [{tier,strategy,expiry:analysis.expiry,contractId:leg.contractId,instrumentKey:leg.instrumentKey,
   strike:leg.strike,type:leg.type,lotSize:q,ask:leg.ask,bid:leg.bid,analysisAt:analysis.timestamp,
   observedAt:time(observedAt),executionAllowed:false}];
 });
}
function measureEvent({entry,candles}){
 if(!entry||!valid(entry.ask)||entry.ask<=0||!Number.isSafeInteger(entry.lotSize)||entry.lotSize<=0)
  return {status:'UNAVAILABLE',reason:'EXECUTABLE_ENTRY_QUOTE_MISSING'};
 const t=Date.parse(entry.observedAt||'');
 if(!Number.isFinite(t))return {status:'UNAVAILABLE',reason:'ENTRY_TIME_MISSING'};
 const firstCandleMs=(Math.floor(t/MIN)+1)*MIN;
 const rows=normalize(candles).map(c=>({t:c.t,o:c.open,h:c.high,l:c.low,c:c.close}));
 const results=Object.fromEntries(RULES.map(rule=>[rule.id,evaluateRule({
  entry:entry.ask,quantity:entry.lotSize,firstCandleMs,rows,rule
 })]));
 const main=results[PRIMARY];
 return main.status==='MEASURED'?{status:'MEASURED',version:VERSION,
  entry:{...entry,firstCandleAt:time(firstCandleMs)},results}:
  {status:'UNAVAILABLE',reason:main.reason,version:VERSION};
}
function stats(rows){
 const measured=rows.filter(r=>r.outcome?.status==='MEASURED'),nets=measured.map(r=>r.outcome.results[PRIMARY]?.scenarios?.BASE_1PT?.estimatedNetRupees).filter(valid);
 return {observations:rows.length,measured:measured.length,distinctDays:new Set(measured.map(r=>r.session)).size,
  wins:nets.filter(x=>x>0).length,losses:nets.filter(x=>x<=0).length,
  meanNetRupees:nets.length?round(nets.reduce((a,b)=>a+b,0)/nets.length):null};
}
function buildTimingLabReport(events,outcomes){
 const byKey=new Map();
 for(const r of outcomes){const key=r.eventId+'|'+r.entryTier+'|'+r.instrumentKey;
  const arr=byKey.get(key)||[];arr.push(r);byKey.set(key,arr);}
 const mapped=events.flatMap(e=>e.candidateQuotes?.map(q=>{
  const key=e.eventId+'|'+q.tier+'|'+q.instrumentKey,records=byKey.get(key)||[];
  const result=records.find(x=>x.outcome?.status==='MEASURED')?.outcome||
   {status:'UNMEASURED',reason:records.at(-1)?.outcome?.reason||'AWAITING_CANDLE_OUTCOME'};
  return {family:e.family,tier:q.tier,session:e.session,at:e.confirmedAt,outcome:result};
 })||[]);
 const eventCount=Object.fromEntries(FAMILIES.map(k=>[k,events.filter(e=>e.family===k).length]));
 return {version:VERSION,liveDecisionImpact:false,promotionEligible:false,
  events:events.length,eventCount,entriesWithFreshQuotes:mapped.length,overall:stats(mapped),
  byFamily:FAMILIES.map(f=>({family:f,...stats(mapped.filter(x=>x.family===f))})),
  byTier:['A','B','C'].map(tier=>({tier,...stats(mapped.filter(x=>x.tier===tier))})),
  basis:'Research-only V3 comparison candidates: ORB_1M, ORB_3M and futures VWAP pullback. Net after 1-point modeled sell haircut, brokerage and taxes. Same initial +8/-8/30-minute exit policy as V2.',
  limitations:['Signals require two unchanged data reads; skipped polls and provider revisions produce missed or unknown opportunities.',
   'No contemporaneous option ask means no measurable entry; candle closes are not executable bid fills.',
   'The three strategy families and tiers can overlap on the same market move; not independent observations.',
   'No positive expectancy or risk-safe live deployment is established by synthetic tests or early paper outcomes.']};
}
module.exports={VERSION,FAMILIES,parsed,aggregate3,openingAnchor,breakoutCrossings,futuresVwapCrossings,
 createTimingLab,candidateQuotes,measureEvent,buildTimingLabReport};
