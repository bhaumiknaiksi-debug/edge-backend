'use strict';
const assert=require('node:assert/strict'),{gzipSync}=require('node:zlib');
const {loadOpportunitySource,projectRecord}=require('./opportunitySource');
(async()=>{
 const compact=projectRecord({id:'out',recordType:'OPPORTUNITY_OUTCOME',timestamp:'2026-10-28T04:30:00Z',snapshot:{irrelevant:'x'.repeat(100000)},outcome:{status:'UNAVAILABLE',reason:'MISSING_CANDLES',error:'private details'}});
 assert.equal(compact.snapshot,undefined);assert.equal(compact.outcome.error,undefined);assert.equal(compact.outcome.reason,'MISSING_CANDLES');
 let rollback=false,released=false;
 const row=(id,at)=>({record_key:id,recorded_at:at,payload_gzip:gzipSync(JSON.stringify({id,timestamp:at}))});
 const dataset=[row('r1','2026-10-28T04:30:00Z')],calls=[],client={async query(sql,args){calls.push(sql);if(sql.startsWith('SELECT count'))return {rows:[{n:dataset.length}]};if(sql.includes('FROM edge_evidence'))return {rows:sql.includes('AND (recorded_at')?dataset.filter(r=>Date.parse(r.recorded_at)>Date.parse(args[1])||Date.parse(r.recorded_at)===Date.parse(args[1])&&r.record_key>args[2]):dataset.slice()};if(sql.includes('FROM edge_trade_ledger'))return {rows:[{payload:{brokerFills:[]}}]};if(sql.includes('FROM edge_trade_snapshots'))return {rows:[]};if(sql==='ROLLBACK')rollback=true;return {rows:[]};},release(){released=true;}};
 const out=await loadOpportunitySource({connect:async()=>client});assert.equal(out.records.length,1);assert.equal(out.source.completeRead,true);
 assert.ok(calls[0].includes('REPEATABLE READ READ ONLY'));assert.ok(!calls.some(s=>/INSERT|UPDATE|DELETE/.test(s)));assert.equal(released,true);
 dataset.push(row('r2','2026-10-28T04:31:00Z'));
 const incremental=await loadOpportunitySource({connect:async()=>client},out);assert.equal(incremental.records.length,2);assert.equal(incremental.source.recordsFetched,1);assert.equal(incremental.source.incrementalRead,true);
 dataset.unshift(row('r0','2026-10-27T04:30:00Z'));
 const late=await loadOpportunitySource({connect:async()=>client},incremental);assert.equal(late.records.length,3);assert.equal(late.source.incrementalRead,false,'late historical inserts force a full read');
 client.query=async sql=>{if(sql.includes('FROM edge_evidence'))return {rows:[{payload_gzip:Buffer.from('invalid')}]};if(sql==='ROLLBACK')rollback=true;return {rows:[]};};
 await assert.rejects(()=>loadOpportunitySource({connect:async()=>client}));assert.equal(rollback,true);
 console.log('Opportunity source PASS: complete read-only archive, incremental cursor/count validation, late insert recovery and corrupt data failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
