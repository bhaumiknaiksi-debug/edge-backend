'use strict';

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=3){return Number(Number(v).toFixed(dp));}

function cprFromOhlc(row){
  if(!row)return null;
  const high=n(row.high),low=n(row.low),close=n(row.close);
  if(high===null||low===null||close===null)return null;
  const pivot=(high+low+close)/3;
  const rawBc=(high+low)/2;
  const rawTc=(2*pivot)-rawBc;
  const bc=Math.min(rawBc,rawTc),tc=Math.max(rawBc,rawTc);
  const range=high-low;
  return {
    pivot:round(pivot),bc:round(bc),tc:round(tc),
    r1:round((2*pivot)-low),s1:round((2*pivot)-high),
    r2:round(pivot+range),s2:round(pivot-range),
    widthPct:pivot?round(Math.abs(tc-bc)/pivot*100,4):null
  };
}
function mondayKey(dateString){
  const d=new Date(String(dateString).slice(0,10)+'T12:00:00Z');
  if(Number.isNaN(d.getTime()))return null;
  const day=d.getUTCDay()||7;
  d.setUTCDate(d.getUTCDate()-day+1);
  return d.toISOString().slice(0,10);
}
function aggregateWeek(rows){
  if(!rows.length)return null;
  return {
    high:Math.max(...rows.map(x=>x.high)),
    low:Math.min(...rows.map(x=>x.low)),
    close:rows.at(-1).close
  };
}
function percentileRank(value,baseline){
  const xs=(baseline||[]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!Number.isFinite(value)||xs.length<10)return null;
  return xs.filter(x=>x<=value).length/xs.length;
}
function location(price,cpr){
  const p=n(price);
  if(p===null||!cpr)return'UNAVAILABLE';
  return p>cpr.tc?'ABOVE_TC':p<cpr.bc?'BELOW_BC':'INSIDE_CPR';
}
function buildCprContext({historicalDaily=[],todayIso=null,spot=null}={}){
  const rows=(historicalDaily||[]).filter(x=>x&&n(x.high)!==null&&n(x.low)!==null&&n(x.close)!==null)
    .map(x=>({...x,date:String(x.timestamp||x.date||'').slice(0,10),high:n(x.high),low:n(x.low),close:n(x.close)}))
    .filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date))
    .sort((a,b)=>a.date.localeCompare(b.date));
  const currentSource=rows.at(-1)||null;
  const previousSource=rows.at(-2)||null;
  const daily=currentSource?cprFromOhlc(currentSource):null;
  const previousDaily=previousSource?cprFromOhlc(previousSource):null;
  const widths=rows.slice(0,-1).map(r=>cprFromOhlc(r)?.widthPct).filter(Number.isFinite);
  const widthPercentile=daily?percentileRank(daily.widthPct,widths.slice(-30)):null;
  const widthClass=widthPercentile===null?'UNCLASSIFIED':
    widthPercentile<=0.25?'ADAPTIVE_NARROW':widthPercentile>=0.75?'ADAPTIVE_WIDE':'ADAPTIVE_NORMAL';
  const alignment=!daily||!previousDaily?'UNAVAILABLE':
    daily.pivot>previousDaily.pivot?'ASCENDING':daily.pivot<previousDaily.pivot?'DESCENDING':'FLAT';

  const currentWeek=todayIso?mondayKey(todayIso):null;
  const groups=new Map();
  for(const r of rows){
    const key=mondayKey(r.date);
    if(!key||key===currentWeek)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(r);
  }
  const weekKeys=[...groups.keys()].sort();
  const priorWeekKey=weekKeys.at(-1)||null;
  const priorWeek=priorWeekKey?aggregateWeek(groups.get(priorWeekKey)):null;
  const weekly=priorWeek?cprFromOhlc(priorWeek):null;

  return {
    version:'CPR_CONTEXT_V1',researchOnly:true,liveDecisionImpact:false,
    methodology:'CPR levels are exact OHLC formulas. Width class uses EDGE rolling percentile context rather than imported fixed thresholds.',
    daily:daily?{...daily,sourceDate:currentSource.date,location:location(spot,daily),alignment,widthPercentile:widthPercentile===null?null:round(widthPercentile,3),widthClass}:null,
    previousDaily:previousDaily?{...previousDaily,sourceDate:previousSource.date}:null,
    weekly:weekly?{...weekly,sourceWeek:priorWeekKey,location:location(spot,weekly)}:null,
    dataCoverage:{dailyRows:rows.length,widthBaseline:Math.min(30,widths.length),weeklyAvailable:!!weekly}
  };
}
module.exports={cprFromOhlc,buildCprContext,mondayKey,percentileRank};
