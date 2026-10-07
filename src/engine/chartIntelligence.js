'use strict';

const { normalizeCandles, atr } = require('./setupObservability');

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=3){return Number(Number(v).toFixed(dp));}
function pct(a,b){return Number.isFinite(a)&&Number.isFinite(b)&&b!==0?((a-b)/b)*100:null;}

function directionFromCloses(candles,lookback=4){
  if(!candles||candles.length<3)return{direction:'UNAVAILABLE',changePct:null};
  const first=candles[Math.max(0,candles.length-lookback)]?.close,last=candles[candles.length-1]?.close;
  const p=pct(last,first);
  return p===null?{direction:'UNAVAILABLE',changePct:null}:{direction:p>0?'UP':p<0?'DOWN':'FLAT',changePct:round(p)};
}
function pivots(candles,radius=2){
  const highs=[],lows=[];
  for(let i=radius;i<candles.length-radius;i++){
    const c=candles[i],left=candles.slice(i-radius,i),right=candles.slice(i+1,i+1+radius);
    if(left.every(x=>c.high>x.high)&&right.every(x=>c.high>=x.high))highs.push({...c,index:i});
    if(left.every(x=>c.low<x.low)&&right.every(x=>c.low<=x.low))lows.push({...c,index:i});
  }
  return{highs,lows};
}
function structure(candles){
  const p=pivots(candles);
  if(p.highs.length<2||p.lows.length<2)return{state:'UNAVAILABLE',lastSwingHigh:null,lastSwingLow:null};
  const h1=p.highs.at(-2),h2=p.highs.at(-1),l1=p.lows.at(-2),l2=p.lows.at(-1);
  const state=h2.high>h1.high&&l2.low>l1.low?'BULLISH':h2.high<h1.high&&l2.low<l1.low?'BEARISH':'MIXED';
  return{state,lastSwingHigh:round(h2.high),previousSwingHigh:round(h1.high),lastSwingLow:round(l2.low),previousSwingLow:round(l1.low)};
}
function levelState(candles,lookback=12){
  if(!candles||candles.length<3)return{state:'UNAVAILABLE',priorHigh:null,priorLow:null,close:null};
  const last=candles.at(-1),prior=candles.slice(Math.max(0,candles.length-lookback-1),-1);
  if(!prior.length)return{state:'UNAVAILABLE',priorHigh:null,priorLow:null,close:round(last.close)};
  const priorHigh=Math.max(...prior.map(c=>c.high)),priorLow=Math.min(...prior.map(c=>c.low));
  return{state:last.close>priorHigh?'BREAKOUT_ABOVE':last.close<priorLow?'BREAKDOWN_BELOW':'INSIDE_PRIOR_RANGE',priorHigh:round(priorHigh),priorLow:round(priorLow),close:round(last.close)};
}
function candlePressure(candles){
  if(!candles||candles.length<4)return{state:'UNAVAILABLE'};
  const recent=candles.slice(-3),bullishCloses=recent.filter(c=>c.close>c.open).length,bearishCloses=recent.filter(c=>c.close<c.open).length;
  const rr=recent.reduce((a,c)=>a+(c.high-c.low),0)/recent.length,base=candles.slice(Math.max(0,candles.length-13),-3);
  const br=base.length?base.reduce((a,c)=>a+(c.high-c.low),0)/base.length:null;
  return{state:bullishCloses>=2?'BUYING_PRESSURE':bearishCloses>=2?'SELLING_PRESSURE':'MIXED',bullishCloses,bearishCloses,rangeExpansionRatio:br?round(rr/br,2):null};
}
function vwapRead(setupFeatures){
  const v=setupFeatures?.vwap,d=n(v?.distancePct),s=n(v?.slope);
  if(!v?.available||d===null)return{available:false,side:'UNAVAILABLE',slope:'UNAVAILABLE',distancePct:null};
  return{available:true,side:d>0?'ABOVE':d<0?'BELOW':'AT',slope:s===null?'UNAVAILABLE':s>0?'RISING':s<0?'FALLING':'FLAT',distancePct:round(d),value:n(v.value)};
}
function participation(setupFeatures){
  const r=n(setupFeatures?.volume?.relativeVolume);
  return r===null?{state:'UNAVAILABLE',relativeVolume:null}:{state:r>=1?'ABOVE_RECENT_AVERAGE':'BELOW_RECENT_AVERAGE',relativeVolume:round(r,2)};
}
function regressionChannel(candles,lookback=20){
  const rows=(candles||[]).slice(-lookback);
  if(rows.length<6)return{state:'UNAVAILABLE',slopePctPerBar:null,position:'UNAVAILABLE'};
  const ys=rows.map(c=>c.close),N=ys.length,xbar=(N-1)/2,ybar=ys.reduce((a,b)=>a+b,0)/N;
  let num=0,den=0;for(let i=0;i<N;i++){num+=(i-xbar)*(ys[i]-ybar);den+=(i-xbar)*(i-xbar);}
  const slope=den?num/den:0,intercept=ybar-slope*xbar;
  const residuals=ys.map((y,i)=>y-(intercept+slope*i)),sd=Math.sqrt(residuals.reduce((a,b)=>a+b*b,0)/N);
  const currentResidual=residuals.at(-1),slopePct=ybar?100*slope/ybar:0;
  const state=Math.abs(slopePct)<0.01?'SIDEWAYS':slopePct>0?'RISING_CHANNEL':'FALLING_CHANNEL';
  const z=sd?currentResidual/sd:0;
  return{state,slopePctPerBar:round(slopePct,4),position:z>0.75?'UPPER_CHANNEL':z<-0.75?'LOWER_CHANNEL':'MID_CHANNEL',channelWidthPct:ybar?round(100*(2*sd)/ybar,3):null};
}
function previousDay(daily){
  if(!daily.length)return null;
  const c=daily.at(-1);
  return{date:String(c.timestamp).slice(0,10),open:round(c.open),high:round(c.high),low:round(c.low),close:round(c.close)};
}
function gapStructure(five,prev){
  if(!five.length||!prev)return{state:'UNAVAILABLE',gapPct:null,filled:null};
  const open=five[0].open,g=pct(open,prev.close);
  if(g===null)return{state:'UNAVAILABLE',gapPct:null,filled:null};
  const state=Math.abs(g)<0.05?'FLAT_OPEN':g>0?'GAP_UP':'GAP_DOWN';
  const filled=state==='GAP_UP'?five.some(c=>c.low<=prev.close):state==='GAP_DOWN'?five.some(c=>c.high>=prev.close):true;
  return{state,gapPct:round(g),filled,sessionOpen:round(open),previousClose:prev.close};
}
function meaningfulLevels({setupFeatures,prevDay,sessionHigh,sessionLow,structure5m}){
  const out=[];
  const add=(name,value)=>{const v=n(value);if(v!==null)out.push({name,value:v});};
  add('PREVIOUS_DAY_HIGH',prevDay?.high);add('PREVIOUS_DAY_LOW',prevDay?.low);add('PREVIOUS_DAY_CLOSE',prevDay?.close);
  add('OPENING_RANGE_HIGH',setupFeatures?.openingRange?.high);add('OPENING_RANGE_LOW',setupFeatures?.openingRange?.low);
  add('SESSION_HIGH',sessionHigh);add('SESSION_LOW',sessionLow);add('LAST_SWING_HIGH',structure5m?.lastSwingHigh);add('LAST_SWING_LOW',structure5m?.lastSwingLow);
  const seen=new Set();return out.filter(x=>{const k=x.name+'|'+x.value;if(seen.has(k))return false;seen.add(k);return true;});
}
function levelEvents(candles,levels,atrValue){
  const recent=(candles||[]).slice(-14),events=[],tolFor=l=>Math.max(2,(atrValue||0)*0.08,l.value*0.00015);
  for(const level of levels){
    const tol=tolFor(level);
    for(let i=0;i<recent.length;i++){
      const c=recent[i],body=Math.max(Math.abs(c.close-c.open),0.01),upper=c.high-Math.max(c.open,c.close),lower=Math.min(c.open,c.close)-c.low;
      if(c.high>level.value+tol&&c.close<level.value)events.push({type:'LIQUIDITY_SWEEP_HIGH',direction:'BEARISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      if(c.low<level.value-tol&&c.close>level.value)events.push({type:'LIQUIDITY_SWEEP_LOW',direction:'BULLISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      if(Math.abs(c.low-level.value)<=tol&&lower>=body*1.5&&c.close>c.open)events.push({type:'BULLISH_REJECTION',direction:'BULLISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      if(Math.abs(c.high-level.value)<=tol&&upper>=body*1.5&&c.close<c.open)events.push({type:'BEARISH_REJECTION',direction:'BEARISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      if(i<recent.length-1&&c.close>level.value+tol){
        const nxt=recent.slice(i+1,Math.min(recent.length,i+4));
        if(nxt.some(x=>x.close<level.value))events.push({type:'FAILED_BREAKOUT',direction:'BEARISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
        else if(nxt.some(x=>x.low<=level.value+tol&&x.close>=level.value))events.push({type:'RETEST_HELD_ABOVE',direction:'BULLISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      }
      if(i<recent.length-1&&c.close<level.value-tol){
        const nxt=recent.slice(i+1,Math.min(recent.length,i+4));
        if(nxt.some(x=>x.close>level.value))events.push({type:'FAILED_BREAKDOWN',direction:'BULLISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
        else if(nxt.some(x=>x.high>=level.value-tol&&x.close<=level.value))events.push({type:'RETEST_HELD_BELOW',direction:'BEARISH',level:level.name,value:round(level.value),timestamp:c.timestamp});
      }
    }
  }
  const uniq=[],seen=new Set();
  for(const e of events.reverse()){const k=e.type+'|'+e.level;if(!seen.has(k)){seen.add(k);uniq.push(e);}}
  return uniq.slice(0,10);
}
function supplyDemandZones(candles,atrValue){
  const p=pivots(candles),zones=[];
  const impulse=Math.max(atrValue||0,1);
  for(const x of p.highs.slice(-4)){
    const next=candles.slice(x.index+1,x.index+4);
    if(next.some(c=>x.high-c.low>=impulse*0.6))zones.push({type:'SUPPLY',low:round(Math.min(x.open,x.close)),high:round(x.high),sourceTimestamp:x.timestamp});
  }
  for(const x of p.lows.slice(-4)){
    const next=candles.slice(x.index+1,x.index+4);
    if(next.some(c=>c.high-x.low>=impulse*0.6))zones.push({type:'DEMAND',low:round(x.low),high:round(Math.max(x.open,x.close)),sourceTimestamp:x.timestamp});
  }
  return zones.slice(-6);
}
function buildStory(x){
  const story=[];
  const s=x.structure;
  if(s.fiveMinute.state==='BULLISH')story.push('5-minute structure is making higher swing highs and higher swing lows.');
  else if(s.fiveMinute.state==='BEARISH')story.push('5-minute structure is making lower swing highs and lower swing lows.');
  if(s.fifteenMinute.state==='BULLISH'&&s.thirtyMinute.state==='BULLISH')story.push('15-minute and 30-minute structure confirm the bullish side.');
  else if(s.fifteenMinute.state==='BEARISH'&&s.thirtyMinute.state==='BEARISH')story.push('15-minute and 30-minute structure confirm the bearish side.');
  if(x.gap.state==='GAP_UP')story.push('The session opened above the previous close'+(x.gap.filled?' and the gap has been filled.':', and the gap remains open.'));
  if(x.gap.state==='GAP_DOWN')story.push('The session opened below the previous close'+(x.gap.filled?' and the gap has been filled.':', and the gap remains open.'));
  if(x.vwap.side==='ABOVE'&&x.vwap.slope==='RISING')story.push('Price is above a rising futures-VWAP proxy.');
  if(x.vwap.side==='BELOW'&&x.vwap.slope==='FALLING')story.push('Price is below a falling futures-VWAP proxy.');
  if(x.levelEvents.length){const e=x.levelEvents[0];story.push(e.type.replace(/_/g,' ').toLowerCase()+' around '+e.level.replace(/_/g,' ').toLowerCase()+'.');}
  if(x.channel.fiveMinute.state!=='UNAVAILABLE')story.push('5-minute regression context: '+x.channel.fiveMinute.state.replace(/_/g,' ').toLowerCase()+', price in the '+x.channel.fiveMinute.position.replace(/_/g,' ').toLowerCase()+'.');
  if(!story.length)story.push('Chart structure is mixed or not mature enough for a clean discretionary-style read.');
  return{headline:x.verdict==='BULLISH'?'Price action leans bullish.':x.verdict==='BEARISH'?'Price action leans bearish.':x.verdict==='CONFLICTED'?'Price action is conflicted.':x.verdict==='NEUTRAL'?'Price action is balanced.':'Price-action context is incomplete.',points:story.slice(0,7)};
}
function buildChartIntelligence({index5m=[],index15m=[],index30m=[],historicalDaily=[],setupFeatures=null,sessionHigh=null,sessionLow=null}={}){
  const five=normalizeCandles(index5m),fifteen=normalizeCandles(index15m),thirty=normalizeCandles(index30m),daily=normalizeCandles(historicalDaily);
  const s5=structure(five),s15=structure(fifteen),s30=structure(thirty),t5=directionFromCloses(five),t15=directionFromCloses(fifteen),t30=directionFromCloses(thirty);
  const levels=levelState(five),vwap=vwapRead(setupFeatures),pressure=candlePressure(five),part=participation(setupFeatures),atr5=atr(five,14);
  const prev=previousDay(daily),gap=gapStructure(five,prev),keyLevels=meaningfulLevels({setupFeatures,prevDay:prev,sessionHigh,sessionLow,structure5m:s5});
  const events=levelEvents(five,keyLevels,atr5),zones=supplyDemandZones(five,atr5);
  const channel={fiveMinute:regressionChannel(five,20),fifteenMinute:regressionChannel(fifteen,16),thirtyMinute:regressionChannel(thirty,12)};
  const votes=[];const vote=(label,dir)=>{if(dir==='BULLISH'||dir==='BEARISH')votes.push({label,direction:dir});};
  [ ['5m structure',s5.state],['15m structure',s15.state],['30m structure',s30.state] ].forEach(x=>vote(x[0],x[1]));
  [ ['5m trend',t5],['15m trend',t15],['30m trend',t30] ].forEach(x=>vote(x[0],x[1].direction==='UP'?'BULLISH':x[1].direction==='DOWN'?'BEARISH':null));
  vote('range break',levels.state==='BREAKOUT_ABOVE'?'BULLISH':levels.state==='BREAKDOWN_BELOW'?'BEARISH':null);
  if(vwap.side==='ABOVE'&&vwap.slope==='RISING')vote('VWAP','BULLISH');if(vwap.side==='BELOW'&&vwap.slope==='FALLING')vote('VWAP','BEARISH');
  vote('candle pressure',pressure.state==='BUYING_PRESSURE'?'BULLISH':pressure.state==='SELLING_PRESSURE'?'BEARISH':null);
  [channel.fiveMinute,channel.fifteenMinute,channel.thirtyMinute].forEach((c,i)=>vote(['5m channel','15m channel','30m channel'][i],c.state==='RISING_CHANNEL'?'BULLISH':c.state==='FALLING_CHANNEL'?'BEARISH':null));
  events.slice(0,4).forEach(e=>vote(e.type,e.direction));
  const bull=votes.filter(v=>v.direction==='BULLISH').length,bear=votes.filter(v=>v.direction==='BEARISH').length;
  let verdict='UNAVAILABLE';if(votes.length){if(bull&&bear&&Math.abs(bull-bear)<=2)verdict='CONFLICTED';else if(bull>bear)verdict='BULLISH';else if(bear>bull)verdict='BEARISH';else verdict='NEUTRAL';}
  const result={version:'CHART_INTELLIGENCE_V2',researchOnly:true,liveDecisionImpact:false,methodology:'Deterministic multi-timeframe OHLCV price-action research. Heuristics describe structure; they are not a probability of profit.',verdict,bullishVotes:bull,bearishVotes:bear,evidenceCount:votes.length,
    structure:{fiveMinute:s5,fifteenMinute:s15,thirtyMinute:s30},trend:{fiveMinute:t5,fifteenMinute:t15,thirtyMinute:t30},levels,vwap,momentum:pressure,participation:part,
    previousDay:prev,gap,keyLevels,levelEvents:events,supplyDemandZones:zones,channel,votes,dataCoverage:{index5m:five.length,index15m:fifteen.length,index30m:thirty.length,historicalDaily:daily.length,previousDayAvailable:!!prev}};
  result.story=buildStory(result);return result;
}
module.exports={buildChartIntelligence,structure,levelState,candlePressure,regressionChannel,gapStructure,levelEvents,supplyDemandZones};
