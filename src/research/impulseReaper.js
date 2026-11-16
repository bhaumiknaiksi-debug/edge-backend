'use strict';
// Frozen, unvalidated NIFTY index hypotheses. No orders, strike selection or tier changes.
const {createHash}=require('node:crypto');
const MIN=60000, SETTLE=30000, CONFIRM=60000, MAX_AGE=4*MIN, IST=19800000;
const VERSION='IMPULSE_REAPER_V1';
const FAMILIES=['IMPULSE_1M','REAPER_RANGE_RECLAIM_1M'];
const iso=t=>new Date(t).toISOString();
const day=t=>iso(t+IST).slice(0,10);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const round=x=>Math.round(x*10000)/10000;
const median=a=>{const s=[...a].sort((x,y)=>x-y),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
const range=c=>c.h-c.l;
const body=c=>Math.abs(c.c-c.o);
// Independent from opening range and global directional regime. Only settled 1m rows supplied by timingLab.parsed.
function detect(rows,now,session){
 const result=[];
 if(!Array.isArray(rows)||rows.length<13)return result;
 const start=Date.parse(session+'T09:15:00+05:30'),end=Date.parse(session+'T15:00:00+05:30');
 for(let i=12;i<rows.length;i++){
  const cur=rows[i],closed=cur.t+MIN;
  if(closed>now-SETTLE||closed<start+13*MIN||closed>=end||now-closed>MAX_AGE)continue;
  const previous=rows.slice(i-12,i-2),last=rows.slice(i-2,i+1);
  const typical=median(previous.map(range));if(!(typical>0))continue;
  const [a,b,c]=last,origin=rows[i-3].c;
  const hi=Math.max(...previous.map(x=>x.h)),lo=Math.min(...previous.map(x=>x.l));
  const displacement=c.c-origin;
  // IMPULSE: 3-bar expansion with at least two directional bodies, strong final close,
  // and a local range break; reject already extended (chasing) moves.
  const up=displacement>=1.8*typical&&displacement<=4*typical&&
   last.filter(x=>x.c>x.o).length>=2&&b.c>a.c&&c.c>b.c&&c.c>hi&&
   c.c-hi<=1.5*typical&&body(c)>=.4*range(c)&&c.c>c.o&&(c.h-c.c)<=.25*range(c);
  const down=displacement<=-1.8*typical&&displacement>=-4*typical&&
   last.filter(x=>x.c<x.o).length>=2&&b.c<a.c&&c.c<b.c&&c.c<lo&&
   lo-c.c<=1.5*typical&&body(c)>=.4*range(c)&&c.c<c.o&&(c.c-c.l)<=.25*range(c);
  if(up||down)result.push({family:FAMILIES[0],direction:up?'UP':'DOWN',closedAt:closed,level:up?hi:lo,close:c.c,
   source:'NIFTY_INDEX_1M_PRIOR_10BAR_RANGE',fingerprint:hash(rows.slice(i-12,i+1)),scale:typical,
   evidence:{medianRange:round(typical),displacement:round(displacement),windowBars:13}});
  // REAPER: a separate two-bar sweep/reclaim of a PRIOR 10-bar range. A genuine
  // penetration and close back inside, then next candle stays inside and confirms.
  // Never use the sweep or confirmation candle to calculate its own reference level.
  const base=rows.slice(i-11,i-1),sweep=rows[i-1];
  const upper=Math.max(...base.map(x=>x.h)),lower=Math.min(...base.map(x=>x.l));
  const scale=median(base.map(range));if(!(scale>0))continue;
  const width=upper-lower;if(width<2*scale)continue;
  const bull=sweep.l<=lower-.25*scale&&sweep.c>lower&&sweep.c<upper&&
   sweep.h<upper&&cur.l>=lower&&cur.c>sweep.c&&cur.c>cur.o&&
   cur.c>=lower+.5*scale&&cur.c<=lower+2*scale&&cur.c<upper;
  const bear=sweep.h>=upper+.25*scale&&sweep.c<upper&&sweep.c>lower&&
   sweep.l>lower&&cur.h<=upper&&cur.c<sweep.c&&cur.c<cur.o&&
   cur.c<=upper-.5*scale&&cur.c>=upper-2*scale&&cur.c>lower;
  if(bull!==bear)result.push({family:FAMILIES[1],direction:bull?'UP':'DOWN',closedAt:closed,level:bull?lower:upper,close:cur.c,
   source:'NIFTY_INDEX_1M_PRIOR_10BAR_SWEEP_RECLAIM',fingerprint:hash(rows.slice(i-11,i+1)),scale,
   evidence:{medianRange:round(scale),sweepExtreme:round(bull?sweep.l:sweep.h),rangeHigh:round(upper),rangeLow:round(lower),sweepClosedAt:iso(sweep.t+MIN)}});
 }
 return result;
}
function createIndependentStrategies(){
 let session=null;const pending=new Map(),emitted=new Set();
 function observe({now,rows,fetchedAt,ready}){
  const today=day(now);
  if(session!==today){session=today;pending.clear();emitted.clear();}
  if(!ready||!Number.isFinite(fetchedAt)||fetchedAt>now||now-fetchedAt>90000){pending.clear();return [];}
  const candidates=detect(rows,now,today),next=new Map(),out=[];
  const latest=rows.at(-1);
  for(const c of candidates){
   // A setup does not remain eligible if its price has invalidated or chased beyond the original level.
   const distance=c.direction==='UP'?latest.c-c.level:c.level-latest.c;
   if(!(distance>0&&distance<=2*c.scale))continue;
   const intervening=rows.filter(r=>r.t>=c.closedAt);
   if(intervening.some(r=>c.direction==='UP'?r.c<=c.level:r.c>=c.level))continue;
   // Stable identity across revisions and process restart; exact entire causal window must match.
   const id=hash([VERSION,today,c.family,c.direction,c.closedAt]);
   if(emitted.has(id))continue;
   const prior=pending.get(id);
   if(!prior||prior.fingerprint!==c.fingerprint){next.set(id,{fingerprint:c.fingerprint,fetchedAt,seenAt:now});continue;}
   next.set(id,prior);
   if(fetchedAt-prior.fetchedAt<CONFIRM||fetchedAt<=prior.fetchedAt)continue;
   out.push({id,session:today,family:c.family,direction:c.direction,level:round(c.level),close:round(c.close),
    candleClosedAt:iso(c.closedAt),firstSeenAt:iso(prior.seenAt),confirmedAt:iso(now),source:c.source,
    confirmation:'TWO_MATCHING_CAUSAL_WINDOWS_60S_APART',strategyVersion:VERSION,
    evidence:c.evidence,executionAllowed:false});
  }
  pending.clear();for(const [k,v] of next)pending.set(k,v);
  return out;
 }
 return {observe,ack(events){for(const e of events||[])if(e?.id)emitted.add(e.id);}};
}
module.exports={VERSION,FAMILIES,detect,createIndependentStrategies};
