'use strict';
const assert=require('node:assert/strict');
const {apply,budget}=require('./ledger');
const {normalizeStatement,summarizedReports}=require('./kitePnl');
const now=new Date('2026-10-17T08:00:00Z');
const base=()=>({trades:[],confirmedDay:null,lockedDays:[],operations:[]});
const symbols=[
 ['NIFTY26O1322400PE',65,6678.75,7263.75],
 ['NIFTY26O1322500CE',65,3136.25,3952],
 ['NIFTY26O1922700PE',65,9158.5,9769.5],
 ['NIFTY26O1922800CE',65,7091.5,7546.5],
 ['NIFTY26O1922900CE',65,7393.75,8037.25],
 ['NIFTY26O1923050CE',65,6786,7169.5],
 ['NIFTY26O1923100CE',65,5876,7393.75],
 ['NIFTY26O1923150CE',65,5460,5570.5]
];
const rows=arr=>arr.map(([symbol,quantity,buyValue,sellValue])=>({
 symbol,quantity,buyValue,sellValue,realizedPnl:Math.round((sellValue-buyValue)*100)/100
}));
const narrow={clientId:'TEST123',startDate:'2026-10-10',endDate:'2026-10-17',
 grossPnl:5122,charges:509.1261,otherCredits:0,unrealizedPnl:0,rows:rows(symbols)};
const wide={...narrow,startDate:'2026-10-01',grossPnl:6048.25,charges:577.5421,
 rows:rows(symbols.map(x=>x[0]==='NIFTY26O1322500CE'?[x[0],130,11254.75,12996.75]:x))};
assert.equal(normalizeStatement(narrow).netPnl,4612.87);
assert.equal(normalizeStatement(wide).netPnl,5470.71);
assert.throws(()=>normalizeStatement({...narrow,grossPnl:999}),/TOTAL_MISMATCH/);
assert.throws(()=>normalizeStatement({...narrow,rows:[...narrow.rows,narrow.rows[0]]}),/DUPLICATE_SYMBOL/);
assert.throws(()=>normalizeStatement({...narrow,rows:narrow.rows.map((r,i)=>i? r : {...r,buyValue:999})}),/ROW_ARITHMETIC/);
assert.throws(()=>normalizeStatement({...narrow,startDate:'2026-10-19'}),/DATE_RANGE/);
assert.throws(()=>normalizeStatement({...narrow,clientId:'OTHER',rows:[{...narrow.rows[0],symbol:'BANKNIFTY26O1322400PE'}]}),/SYMBOL/);
const action=(state,id,report)=>apply(state,'pnl',{requestId:id,...report},now);
const initial=budget(base(),now);
let s=action(base(),'pnl_report_req_0000001',narrow);
assert.deepEqual(budget(s,now),initial,'P&L statements must never affect live position or loss budgets');
let result=summarizedReports(s);
assert.equal(result.reports.length,1);
assert.equal(result.reports[0].netPnl,4612.87);
assert.equal(result.reports[0].matchedSymbols,0);
assert.equal(result.reports[0].items.length,8);
assert.ok(result.reports[0].items.every(x=>x.kind==='PNL_ONLY'&&x.openedAt===null));
s=action(s,'pnl_report_req_0000002',narrow);
assert.equal(s.pnlStatements.length,1,'Same statement reupload is idempotent');
s=action(s,'pnl_report_req_0000003',wide);
result=summarizedReports(s);
assert.equal(result.reports.length,2,'Overlapping reporting windows are separate snapshots, not added');
assert.equal(result.reports[0].id,'2026-10-01_2026-10-17','Widest window wins if end dates match');
assert.equal(result.reports[0].grossPnl,6048.25);
assert.equal(result.reports[0].netPnl,5470.71);
const fixedFill=(id,side,time,price)=>({symbol:'NIFTY26O1322500CE',exchange:'NSE',
 tradeDate:time.slice(0,10),time,side,quantity:65,price,tradeId:id,orderId:'ORDER'+id});
s=apply(s,'import',{requestId:'kite_fills_req_0000001',clientId:'TEST123',fills:[
 fixedFill('101','buy','2026-10-09T12:10:56',124.90),
 fixedFill('102','sell','2026-10-09T12:58:16',139.15),
 fixedFill('103','buy','2026-10-13T11:22:15',48.25),
 fixedFill('104','sell','2026-10-13T11:39:58',60.8)
]},now);
result=summarizedReports(s);
const narrow22500=result.reports[1].items.filter(x=>x.symbol==='NIFTY26O1322500CE');
assert.equal(narrow22500.length,1,'Narrow report matches ONLY the Oct 13 trade');
assert.equal(narrow22500[0].kind,'TRADEBOOK_MATCHED');
assert.equal(narrow22500[0].grossPnl,815.75);
const wide22500=result.reports[0].items.filter(x=>x.symbol==='NIFTY26O1322500CE');
assert.equal(wide22500.length,2,'Wide report keeps both same-contract round trips');
assert.ok(wide22500.every(x=>x.kind==='TRADEBOOK_MATCHED'));
assert.ok(result.reports[0].items.some(x=>x.symbol==='NIFTY26O1923100CE'&&x.kind==='PNL_ONLY'));
assert.equal(Math.round(result.reports[0].items.reduce((x,r)=>x+r.grossPnl,0)*100)/100,6048.25,
 'Flattened displayed rows must sum to selected Kite report with no double counting');
assert.deepEqual(budget(s,now),initial,'Tradebook + P&L both remain completely separate from risk approvals');
assert.throws(()=>action(s,'pnl_report_req_0000004',{...narrow,clientId:'OTHER123'}),/CLIENT_ID_MISMATCH/);
s=action(s,'pnl_report_req_0000005',{...narrow,charges:500});
assert.equal(s.pnlStatements.length,2,'A corrected same-period statement replaces, never adds');
assert.equal(summarizedReports(s).reports[1].netPnl,4622);
console.log('Kite P&L reconciliation: actual 01-17 and 10-17 reports, same-contract multi-trades, missing fills, charges, overlap, duplicates, account isolation, budget invariance PASS');
