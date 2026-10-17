'use strict';
// Broker-reported Kite F&O P&L statements. Historical, descriptive, and NEVER live-risk inputs.
const {summarizeBroker}=require('./kiteTradebook');
const round2=n=>Math.round((n+Number.EPSILON)*100)/100;
const round4=n=>Math.round((n+Number.EPSILON)*10000)/10000;
const signed=(v,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e8)throw Error('INVALID_'+name);return round4(v);};
const nonnegative=(v,name)=>{const n=signed(v,name);if(n<0)throw Error('INVALID_'+name);return n;};
function date(s,name){
  if(typeof s!=='string'||! /^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('INVALID_'+name);
  const d=new Date(s+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw Error('INVALID_'+name);
  return s;
}
function normalizeStatement(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_PNL_REPORT');
  const clientId=String(input.clientId||'').trim().toUpperCase();
  if(!/^[A-Z0-9_-]{3,24}$/.test(clientId))throw Error('INVALID_CLIENT_ID');
  const startDate=date(input.startDate,'PNL_START_DATE'),endDate=date(input.endDate,'PNL_END_DATE');
  const days=(Date.parse(endDate)-Date.parse(startDate))/86400000;
  if(days<0||days>370)throw Error('INVALID_PNL_DATE_RANGE');
  const grossPnl=signed(input.grossPnl,'PNL_GROSS'),charges=nonnegative(input.charges,'PNL_CHARGES');
  const otherCredits=signed(input.otherCredits,'PNL_OTHER_CREDITS');
  const unrealizedPnl=signed(input.unrealizedPnl,'PNL_UNREALIZED');
  if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>150)throw Error('INVALID_PNL_ROWS');
  const seen=new Set(),rows=[];
  for(const raw of input.rows){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_PNL_ROW');
    const symbol=String(raw.symbol||'').toUpperCase();
    if(!/^NIFTY[0-9A-Z]{6,30}(CE|PE)$/.test(symbol))throw Error('INVALID_PNL_SYMBOL');
    if(seen.has(symbol))throw Error('INVALID_PNL_DUPLICATE_SYMBOL');
    seen.add(symbol);
    if(!Number.isInteger(raw.quantity)||raw.quantity<1||raw.quantity>1000000)throw Error('INVALID_PNL_QUANTITY');
    const buyValue=nonnegative(raw.buyValue,'PNL_BUY_VALUE');
    const sellValue=nonnegative(raw.sellValue,'PNL_SELL_VALUE');
    const realizedPnl=signed(raw.realizedPnl,'PNL_ROW_REALIZED');
    if(Math.abs(round2(sellValue-buyValue)-round2(realizedPnl))>.02)throw Error('INVALID_PNL_ROW_ARITHMETIC');
    rows.push({symbol,quantity:raw.quantity,buyValue,sellValue,realizedPnl:round2(realizedPnl)});
  }
  if(Math.abs(round2(rows.reduce((n,r)=>n+r.realizedPnl,0))-round2(grossPnl))>.02)
    throw Error('INVALID_PNL_TOTAL_MISMATCH');
  return {id:startDate+'_'+endDate,clientId,startDate,endDate,grossPnl:round2(grossPnl),
    charges,otherCredits,unrealizedPnl:round2(unrealizedPnl),netPnl:round2(grossPnl+otherCredits-charges),
    rows:rows.sort((a,b)=>a.symbol.localeCompare(b.symbol))};
}
function importStatement(state,input){
  const incoming=normalizeStatement(input);
  if(state.brokerClientId&&state.brokerClientId!==incoming.clientId)throw Error('INVALID_CLIENT_ID_MISMATCH');
  const prior=Array.isArray(state.pnlStatements)?state.pnlStatements:[];
  const index=prior.findIndex(p=>p.id===incoming.id);
  const previous=index>=0?prior[index]:null;
  if(index<0&&prior.length>=24)throw Error('INVALID_PNL_REPORT_LIMIT');
  // Same reporting window replaces earlier snapshots. Overlapping DIFFERENT windows are never added together.
  const unchanged=previous&&JSON.stringify({...previous,importedAt:null})===JSON.stringify({...incoming,importedAt:null});
  if(!unchanged){
    incoming.importedAt=new Date().toISOString();
    state.pnlStatements=index<0?[...prior,incoming]:prior.map((p,i)=>i===index?incoming:p);
  }
  state.brokerClientId=incoming.clientId;
  return {id:incoming.id,unchanged:!!unchanged,replaced:!!previous&&!unchanged};
}
function summarizedReports(state){
  const reports=(Array.isArray(state.pnlStatements)?state.pnlStatements:[]).slice()
    .sort((a,b)=>b.endDate.localeCompare(a.endDate)||a.startDate.localeCompare(b.startDate));
  const episodes=summarizeBroker(state).episodes;
  return {reports:reports.map(report=>{
    const visible=episodes.filter(t=>t.closedAt.slice(0,10)>=report.startDate&&t.closedAt.slice(0,10)<=report.endDate);
    const bySymbol=new Map();
    for(const ep of visible){if(!bySymbol.has(ep.symbol))bySymbol.set(ep.symbol,[]);bySymbol.get(ep.symbol).push(ep);}
    const items=[];let matchedSymbols=0,unmatchedSymbols=0;
    for(const r of report.rows){
      const trades=bySymbol.get(r.symbol)||[];
      const qty=trades.reduce((n,t)=>n+t.quantity,0);
      const gross=round2(trades.reduce((n,t)=>n+t.grossPnl,0));
      const buy=round2(trades.reduce((n,t)=>n+t.entry*t.quantity,0));
      const sell=round2(trades.reduce((n,t)=>n+t.exit*t.quantity,0));
      const exact=trades.length&&qty===r.quantity&&Math.abs(gross-r.realizedPnl)<=.02&&
        Math.abs(buy-r.buyValue)<=.05&&Math.abs(sell-r.sellValue)<=.05;
      if(exact){
        matchedSymbols++;
        for(const ep of trades)items.push({...ep,kind:'TRADEBOOK_MATCHED',reportId:report.id});
      }else{
        unmatchedSymbols++;
        items.push({kind:trades.length?'PNL_MISMATCH':'PNL_ONLY',source:'KITE_PNL',reportId:report.id,
          symbol:r.symbol,quantity:r.quantity,openedAt:null,closedAt:null,entry:round2(r.buyValue/r.quantity),
          exit:round2(r.sellValue/r.quantity),grossPnl:r.realizedPnl,netPnl:null,
          detail:trades.length?'Tradebook fills do not cover the same quantity/values for this report period.':'Execution timestamps require a tradebook.'});
      }
    }
    items.sort((a,b)=>b.grossPnl-a.grossPnl);
    return {id:report.id,startDate:report.startDate,endDate:report.endDate,importedAt:report.importedAt,
      grossPnl:report.grossPnl,charges:report.charges,otherCredits:report.otherCredits,
      unrealizedPnl:report.unrealizedPnl,netPnl:report.netPnl,
      matchedSymbols,unmatchedSymbols,symbols:report.rows.length,
      // Group sums match the statement even when a contract was traded multiple times.
      items};
  }),affectsRiskLedger:false};
}
module.exports={normalizeStatement,importStatement,summarizedReports,round2};
