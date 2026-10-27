'use strict';
const assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const {fromCsv,createCatalog}=require('./instrumentCatalog');
const {createMarketQuotes}=require('./marketQuotes');
const NOW=Date.parse('2026-10-28T10:00:00+05:30');
const csv='instrument_key,name,expiry,strike,tick_size,lot_size,instrument_type,option_type,exchange\nNSE_FO|12345,NIFTY,2026-11-03,23000,0.05,65,OPTIDX,CE,NSE_FO\n';
(async()=>{
 const parsed=fromCsv(csv,'2026-10-28');assert.equal(parsed['NSE_FO|12345'].tickSizeRupees,0.05);assert.equal(parsed['NSE_FO|12345'].lotSize,65);
 let calls=0;
 const catalog=createCatalog({now:()=>NOW,request:async(url,options)=>{
   calls++;assert.equal(url,'https://assets.upstox.com/market-quote/instruments/exchange/NSE.csv.gz');assert.equal(options.redirect,'error');
   return new Response(gzipSync(csv),{headers:{'last-modified':new Date(NOW).toUTCString()}});
 }});
 assert.equal((await catalog.get('NSE_FO|12345')).lotSize,65);await catalog.get('missing');assert.equal(calls,1);
 const stale=createCatalog({now:()=>NOW,request:async()=>new Response(gzipSync(csv),{headers:{'last-modified':new Date(NOW-86400000).toUTCString()}})});
 assert.equal(await stale.get('NSE_FO|12345'),null);
 let quoteCalls=0;
 const source=createMarketQuotes({token:'data-only-token',now:()=>NOW,request:async(url,options)=>{
   quoteCalls++;assert.equal(new URL(url).hostname,'api.upstox.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
   return new Response(JSON.stringify({status:'success',data:{contract:{instrument_token:'NSE_FO|12345',timestamp:new Date(NOW).toISOString(),depth:{buy:[{price:99.95}],sell:[{price:100}]}}}}));
 }});
 const result=await source.get(['NSE_FO|12345']);assert.equal(result['NSE_FO|12345'].ask,100);assert.equal(quoteCalls,1);
 assert.deepEqual(await source.get([]),{});assert.equal(quoteCalls,1);
 await assert.rejects(()=>source.get(['https://evil.test']),/INVALID_QUOTE_INSTRUMENTS/);
 const old=createMarketQuotes({token:'data-only',now:()=>NOW,request:async()=>new Response(JSON.stringify({status:'success',data:{contract:{instrument_token:'NSE_FO|12345',timestamp:new Date(NOW-11000).toISOString(),depth:{buy:[{price:99}],sell:[{price:100}]}}}}))});
 assert.deepEqual(await old.get(['NSE_FO|12345']),{});
 console.log('Execution catalog/quotes PASS: broker lot/tick metadata, current BOD, fixed read-only quote endpoint and exchange freshness');
})().catch(e=>{console.error(e);process.exitCode=1;});
