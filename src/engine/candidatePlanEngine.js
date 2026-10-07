'use strict';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(Number(v).toFixed(dp));
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function expiryShort(iso) {
  if (!iso || String(iso).length < 10) return '';
  const s=String(iso), m=Number(s.slice(5,7)), d=s.slice(8,10);
  return m>=1&&m<=12 ? d+' '+MONTHS[m-1] : '';
}
function contractId(expiry,strike,type) {
  return 'NIFTY '+expiryShort(expiry)+' '+strike+' '+type;
}

function quote(row,type) {
  if (!row) return null;
  const p = type === 'CE' ? 'ce' : 'pe';
  const rawDelta = type === 'CE' ? n(row.ceDelta) : n(row.peDelta);
  const delta = rawDelta === null ? null : (type === 'CE' ? rawDelta : Math.abs(rawDelta));
  const ltp=n(row[p+'LTP']), bid=n(row[p+'Bid']), ask=n(row[p+'Ask']);
  const instrumentKey=row[p+'InstrumentKey'] || null;
  if (ltp===null || ltp<=0) return null;
  return { row, strike:n(row.strike), type, delta, ltp, bid, ask, instrumentKey };
}

function executableLeg(q) {
  if (!q) return null;
  const spread=(q.ask!==null&&q.bid!==null)?q.ask-q.bid:null;
  const spreadPct=(spread!==null&&q.ask>0)?spread/q.ask*100:null;
  return {
    contractId:null,
    instrumentKey:q.instrumentKey,
    strike:q.strike,
    type:q.type,
    premium:round(q.ltp),
    bid:q.bid===null?null:round(q.bid),
    ask:q.ask===null?null:round(q.ask),
    delta:q.delta===null?null:round(q.delta,3),
    spread:spread===null?null:round(spread),
    spreadPct:spreadPct===null?null:round(spreadPct)
  };
}

function pickClosest(rows,type,target,filterFn=()=>true) {
  return (rows||[])
    .map(r=>quote(r,type))
    .filter(q=>q&&q.delta!==null&&filterFn(q))
    .sort((a,b)=>Math.abs(a.delta-target)-Math.abs(b.delta-target))[0] || null;
}

function liquidEnough(q) {
  if (!q || q.bid===null || q.ask===null || q.bid<=0 || q.ask<=0 || q.ask<q.bid) return false;
  const spread=q.ask-q.bid;
  return spread<=8 && (spread/q.ask*100)<=15;
}

function bestByDelta(rows,type,target,filterFn=()=>true) {
  const all=(rows||[]).map(r=>quote(r,type)).filter(q=>q&&q.delta!==null&&filterFn(q));
  const liquid=all.filter(liquidEnough);
  const pool=liquid.length?liquid:all;
  return pool.sort((a,b)=>Math.abs(a.delta-target)-Math.abs(b.delta-target))[0] || null;
}

function legWithId(q,expiry) {
  const x=executableLeg(q);
  if (!x) return null;
  x.contractId=contractId(expiry,x.strike,x.type);
  return x;
}

function buildDebitSpread(rows,direction,expiry,lotSize) {
  const type=direction==='BULLISH'?'CE':'PE';
  const buy=bestByDelta(rows,type,0.50);
  if (!buy) return null;
  const sell=bestByDelta(rows,type,0.25,q=>direction==='BULLISH'?q.strike>buy.strike:q.strike<buy.strike);
  if (!sell) return null;
  const buyLeg=legWithId(buy,expiry), sellLeg=legWithId(sell,expiry);
  const executable=(buy.ask!==null&&sell.bid!==null)?buy.ask-sell.bid:null;
  const indicative=buy.ltp-sell.ltp;
  const width=Math.abs(sell.strike-buy.strike);
  const debit=executable!==null&&executable>0?executable:indicative;
  return {
    strategy:direction==='BULLISH'?'BULL_CALL_SPREAD':'BEAR_PUT_SPREAD',
    legs:{buyLeg,sellLeg},
    indicativeNetDebit:round(indicative),
    executableNetDebit:debit>0?round(debit):null,
    width:round(width),
    maxLossPoints:debit>0?round(debit):null,
    maxLossRupees:debit>0?Math.round(debit*lotSize):null,
    liquidityBasis:(liquidEnough(buy)&&liquidEnough(sell))?'CLEAN_QUOTES':'RESEARCH_QUOTES_ONLY'
  };
}

function buildLong(rows,direction,expiry,lotSize) {
  const type=direction==='BULLISH'?'CE':'PE';
  const buy=bestByDelta(rows,type,0.45);
  if (!buy) return null;
  const buyLeg=legWithId(buy,expiry);
  const debit=buy.ask!==null&&buy.ask>0?buy.ask:buy.ltp;
  return {
    strategy:direction==='BULLISH'?'LONG_CALL':'LONG_PUT',
    legs:{buyLeg},
    executableDebit:round(debit),
    maxLossPoints:round(debit),
    maxLossRupees:Math.round(debit*lotSize),
    liquidityBasis:liquidEnough(buy)?'CLEAN_QUOTE':'RESEARCH_QUOTE_ONLY'
  };
}

function copyAuthoritative(strategy,tradeLegs,orchestration) {
  if (!strategy || strategy==='WAIT' || !tradeLegs) return null;
  return {
    strategy,
    legs: JSON.parse(JSON.stringify(tradeLegs)),
    backendStatus: orchestration?.status || 'UNKNOWN',
    executionAllowed: orchestration?.status === 'READY_TO_EXECUTE'
  };
}

function directionFamily(direction) {
  const d=String(direction||'');
  if (d.includes('BULL')) return 'BULLISH';
  if (d.includes('BEAR')) return 'BEARISH';
  return 'NEUTRAL';
}

function buildResearchCandidatePlans({
  strikes=[], regime=null, strategy=null, tradeLegs=null, orchestration=null,
  expiryDate=null, lotSize=1, chartIntelligence=null
}={}) {
  const direction=directionFamily(regime?.direction);
  const A=copyAuthoritative(strategy,tradeLegs,orchestration);
  const B=direction==='NEUTRAL'?null:buildDebitSpread(strikes,direction,expiryDate,lotSize);
  const C=direction==='NEUTRAL'?null:buildLong(strikes,direction,expiryDate,lotSize);
  const chartAgreement=chartIntelligence?.verdict===direction?'AGREES':
    ['BULLISH','BEARISH'].includes(chartIntelligence?.verdict)&&direction!=='NEUTRAL'?'CONTRADICTS':'UNRESOLVED';

  return {
    version:'RESEARCH_CANDIDATE_PLANS_V1',
    researchOnly:true,
    liveDecisionImpact:false,
    notProbability:true,
    direction,
    chartAgreement,
    plans:{
      A:{
        tier:'A',label:'STRICT',available:!!A,researchOnly:false,
        executionAllowed:!!A?.executionAllowed,
        description:'Existing backend-authoritative structure. It can execute only when every current EDGE gate passes.',
        ...(A||{})
      },
      B:{
        tier:'B',label:'STRONG_CANDIDATE',available:!!B,researchOnly:true,executionAllowed:false,
        description:'Research-only defined-risk directional spread chosen near 0.50/0.25 delta with liquidity preference.',
        ...(B||{})
      },
      C:{
        tier:'C',label:'DEVELOPING',available:!!C,researchOnly:true,executionAllowed:false,
        description:'Research-only early directional expression near 0.45 delta. Never shown as BUY NOW.',
        ...(C||{})
      }
    }
  };
}

module.exports={ buildResearchCandidatePlans, buildDebitSpread, buildLong, directionFamily };
