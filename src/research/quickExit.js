'use strict';
// Research only. Measures what a flagged single-leg card would have returned with a quick target, a hard stop
// and a time limit, walked minute by minute on that contract's own 1-minute candles. Never authorizes anything.
//
// Fill assumptions (stated, conservative):
// - Entry is the ask quoted on the card when it was first flagged (an executable quote, not an LTP).
// - The walk starts with the first 1-minute candle that opens at or after the flag.
// - Stop: a candle whose low reaches entry - stop exits at entry - stop, or at the candle's open if it gapped below.
// - Target: a candle whose high reaches entry + target exits at entry + target (never better).
// - A candle that touches both counts as the stop (the path inside a minute is unknown).
// - No hit within the time limit exits at the close of the last candle inside it; the window never runs past 15:29 IST.
// - Costs: Rs 100 per leg reserve, the same scenario the 60-minute report uses. Not measured broker charges.

const VERSION='QUICK_EXIT_V1';
// The primary rule is fixed in advance. The others are a sensitivity check only and must not be cherry-picked.
const RULES=[
 {id:'T8_S8_30M',target:8,stop:8,maxMinutes:30,primary:true},
 {id:'T6_S6_30M',target:6,stop:6,maxMinutes:30,primary:false},
 {id:'T10_S10_30M',target:10,stop:10,maxMinutes:30,primary:false},
 {id:'T10_S6_30M',target:10,stop:6,maxMinutes:30,primary:false},
 {id:'T15_S8_30M',target:15,stop:8,maxMinutes:30,primary:false}
];
const PRIMARY=RULES.find(r=>r.primary).id;
const MINUTE=60000,COST_PER_LEG=100,SINGLE=['LONG_CALL','LONG_PUT'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const round=x=>Math.round(x*100)/100;
const istDay=t=>new Date(t+19800000).toISOString().slice(0,10);
const sessionEnd=t=>Date.parse(istDay(t)+'T15:29:00+05:30'); // the 15:29 candle is the last one of the session

function normalize(candles){
 return (candles||[]).map(c=>Array.isArray(c)?{timestamp:c[0],open:c[1],high:c[2],low:c[3],close:c[4]}:c)
  .map(c=>({t:Date.parse(c.timestamp),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}))
  .filter(c=>Number.isFinite(c.t)&&[c.open,c.high,c.low,c.close].every(x=>Number.isFinite(x)&&x>=0)&&c.high>=c.low)
  .sort((a,b)=>a.t-b.t);
}

// One rule on one entry. candles: normalized, any order of the day.
function simulate({entry,candles,startMs,lotSize,rule}){
 if(!(finite(entry)&&entry>0))return {status:'UNAVAILABLE',reason:'NO_EXECUTABLE_ENTRY_PRICE'};
 if(!Number.isSafeInteger(lotSize)||lotSize<=0)return {status:'UNAVAILABLE',reason:'LOT_SIZE_UNAVAILABLE'};
 const limit=Math.min(startMs+rule.maxMinutes*MINUTE,sessionEnd(startMs)+MINUTE);
 const window=candles.filter(c=>c.t>=startMs&&c.t<limit);
 if(!window.length)return {status:'UNAVAILABLE',reason:'NO_CANDLES_AFTER_FLAG'};
 const stopLevel=entry-rule.stop,targetLevel=entry+rule.target;
 let exit=null;
 for(const c of window){
  if(c.low<=stopLevel){exit={kind:'STOP',price:Math.min(stopLevel,c.open),at:c.t};break;}
  if(c.high>=targetLevel){exit={kind:'TARGET',price:targetLevel,at:c.t};break;}
 }
 if(!exit){
  const last=window.at(-1);
  // The data must reach the end of the window (allowing one missing minute), or the result is unknown.
  if(last.t<limit-2*MINUTE)return {status:'UNAVAILABLE',reason:'INCOMPLETE_CANDLE_WINDOW'};
  exit={kind:'TIME',price:last.close,at:last.t};
 }
 const points=exit.price-entry,gross=points*lotSize,cost=COST_PER_LEG;
 return {status:'MEASURED',exit:exit.kind,exitPrice:round(exit.price),minutes:Math.round((exit.at+MINUTE-startMs)/MINUTE),
  grossPoints:round(points),grossRupees:round(gross),estimatedNetRupees:round(gross-cost),costReserveRupees:cost};
}

// All rules for one flagged card. Only single-leg long calls/puts with an executable ask are measured.
function measureCard({candidate,at,candles}){
 const legs=candidate?.legs||{},leg=legs.buyLeg;
 if(!SINGLE.includes(candidate?.strategy)||!leg||legs.sellLeg)return {status:'UNAVAILABLE',reason:'NOT_SINGLE_LEG_LONG'};
 const entry=Number(leg.ask),lotSize=Number(candidate.lotSize??legs.lotSize),startMs=Date.parse(at);
 if(!Number.isFinite(startMs))return {status:'UNAVAILABLE',reason:'FLAG_TIME_UNAVAILABLE'};
 const rows=normalize(candles),results={};
 for(const rule of RULES)results[rule.id]=simulate({entry,candles:rows,startMs,lotSize,rule});
 const primary=results[PRIMARY];
 return primary.status==='MEASURED'?{status:'MEASURED',version:VERSION,entry:round(entry),lotSize,results}:{status:'UNAVAILABLE',reason:primary.reason,version:VERSION};
}

// Weekday count to expiry, matching the sandbox's buckets (NSE holidays are not modelled).
function expiryBucket(expiry,session){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(expiry||'')||!/^\d{4}-\d{2}-\d{2}$/.test(session||''))return 'UNKNOWN';
 if(expiry===session)return 'EXPIRY_DAY';
 if(expiry<session)return 'UNKNOWN';
 let days=0;
 for(let t=Date.parse(session+'T00:00:00Z')+86400000;t<=Date.parse(expiry+'T00:00:00Z');t+=86400000){const w=new Date(t).getUTCDay();if(w!==0&&w!==6)days++;}
 return days===1?'DAY_BEFORE_EXPIRY':'OTHER_DAYS';
}
function timeBucket(at){
 const d=new Date(Date.parse(at)+19800000),m=d.getUTCHours()*60+d.getUTCMinutes();
 return m<600?'09:15-10:00':m<720?'10:00-12:00':m<840?'12:00-14:00':'14:00-15:30';
}

function summarize(rows,ruleId){
 const measured=rows.map(r=>r.results?.[ruleId]).filter(x=>x?.status==='MEASURED'),net=measured.map(x=>x.estimatedNetRupees);
 const count=k=>measured.filter(x=>x.exit===k).length,total=net.reduce((a,b)=>a+b,0);
 const minutes=measured.map(x=>x.minutes).sort((a,b)=>a-b);
 return {flagged:rows.length,measured:measured.length,wins:net.filter(x=>x>0).length,losses:net.filter(x=>x<=0).length,
  winRatePct:measured.length?round(100*net.filter(x=>x>0).length/measured.length):null,
  targetHits:count('TARGET'),stopHits:count('STOP'),timeExits:count('TIME'),
  meanNetRupees:measured.length?round(total/measured.length):null,totalNetRupees:measured.length?round(total):null,
  medianMinutes:minutes.length?minutes[Math.floor(minutes.length/2)]:null,
  days:new Set(rows.filter(r=>r.results?.[ruleId]?.status==='MEASURED').map(r=>r.session)).size};
}

// rows: [{tier, strategy, expiry, session, at, results}] for single-leg episodes. Pure.
function buildQuickExitReport(rows){
 const group=(key)=>{const out={};for(const r of rows){const k=key(r);(out[k]||=[]).push(r);}return out;};
 const by=(key)=>Object.fromEntries(RULES.map(rule=>[rule.id,Object.entries(group(key)).sort(([a],[b])=>a.localeCompare(b)).map(([k,list])=>({key:k,...summarize(list,rule.id)}))]));
 const unmeasured={};for(const r of rows)if(r.status!=='MEASURED'){unmeasured[r.reason||'NOT_YET_MEASURED']=(unmeasured[r.reason||'NOT_YET_MEASURED']||0)+1;}
 return {version:VERSION,primaryRule:PRIMARY,rules:RULES,episodes:rows.length,unmeasuredReasons:unmeasured,
  overall:Object.fromEntries(RULES.map(rule=>[rule.id,summarize(rows,rule.id)])),
  byCardTier:by(r=>r.tier),byDirection:by(r=>r.strategy==='LONG_CALL'?'CALL':'PUT'),
  byExpiry:by(r=>expiryBucket(r.expiry,r.session)),byTimeOfDay:by(r=>timeBucket(r.at)),
  basis:'Entry at the flagged ask; 1-minute candles; stop before target when both touch in a minute; Rs 100 per leg cost reserve; one lot.',
  limits:['Model results on candle data, not broker fills.','Overlapping cards on the same move are correlated; their totals are not independent trades.',
   'Only the primary rule was fixed in advance. The other rules are a sensitivity check; picking the best one after seeing results overstates it.',
   'A flagged card is not a trade the owner took; selection and timing by hand can differ.']};
}

module.exports={VERSION,RULES,PRIMARY,normalize,simulate,measureCard,expiryBucket,timeBucket,summarize,buildQuickExitReport};
