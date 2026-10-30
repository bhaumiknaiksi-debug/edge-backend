'use strict';
const assert=require('node:assert/strict'),{gzipSync}=require('node:zlib');
const {loadOpportunitySource,projectRecord}=require('./opportunitySource');
(async()=>{
 const compact=projectRecord({id:'out',recordType:'OPPORTUNITY_OUTCOME',timestamp:'2026-10-28T04:30:00Z',snapshot:{irrelevant:'x'.repeat(100000)},outcome:{status:'UNAVAILABLE',reason:'MISSING_CANDLES',error:'private details'}});
 assert.equal(compact.snapshot,undefined);assert.equal(compact.outcome.error,undefined);assert.equal(compact.outcome.reason,'MISSING_CANDLES');
 let rollback=false,released=false,seq=0;
 const row=(id,at,committed=true)=>({record_key:id,recorded_at:at,seq:String(++seq),committed,payload_gzip:gzipSync(JSON.stringify({id,timestamp:at}))});
 const dataset=[row('r1','2026-10-28T04:30:00Z')],calls=[],visible=()=>dataset.filter(r=>r.committed),bytes=rows=>rows.reduce((a,r)=>a+(r.payload_gzip?.length||0),0);
 let payloadBytes=0;
 const client={async query(sql,args){calls.push(sql);
  if(sql.startsWith('SELECT count'))return {rows:[{n:visible().length}]};
  if(sql.startsWith('SELECT record_key FROM'))return {rows:visible().filter(r=>args.length<2||+r.seq>args[1]&&+r.seq<=args[2]).map(r=>({record_key:r.record_key}))};
  if(sql.includes('FROM edge_evidence')){let rows=visible().slice();
   if(sql.includes('seq>$2'))rows=rows.filter(r=>+r.seq>args[1]);if(sql.includes('record_key = ANY'))rows=rows.filter(r=>args[1].includes(r.record_key));
   rows.sort((a,b)=>a.seq-b.seq);payloadBytes+=bytes(rows);return {rows};}
  if(sql.includes('FROM edge_trade_ledger'))return {rows:[{payload:{brokerFills:[]}}]};if(sql.includes('FROM edge_trade_snapshots'))return {rows:[]};if(sql==='ROLLBACK')rollback=true;return {rows:[]};},release(){released=true;}};
 const pool={connect:async()=>client,query:async sql=>{calls.push(sql);return {rows:[]};}};
 const out=await loadOpportunitySource(pool);assert.equal(out.records.length,1);assert.equal(out.source.completeRead,true);
 assert.ok(calls.some(s=>s.includes('ADD COLUMN IF NOT EXISTS seq bigserial')),'the insertion-order column is ensured');
 assert.ok(calls.find(s=>s.startsWith('BEGIN')).includes('REPEATABLE READ READ ONLY'));assert.ok(!calls.filter(s=>!s.startsWith('ALTER')).some(s=>/INSERT|UPDATE|DELETE/.test(s)));assert.equal(released,true);
 assert.equal(Object.keys(out).includes('entries'),false,'internal read state is never reported');
 dataset.push(row('r2','2026-10-28T04:31:00Z'));
 const incremental=await loadOpportunitySource(pool,out);assert.equal(incremental.records.length,2);assert.equal(incremental.source.recordsFetched,1);assert.equal(incremental.source.incrementalRead,true);
 // The pattern that used up the monthly transfer: a record stamped EARLIER than the newest one, written later.
 dataset.push(row('r0','2026-10-27T04:30:00Z'));payloadBytes=0;
 const late=await loadOpportunitySource(pool,incremental);
 assert.equal(late.records.length,3);assert.equal(late.source.incrementalRead,true,'an earlier-stamped record no longer forces a full read');
 assert.equal(late.source.recordsFetched,1);assert.equal(payloadBytes,bytes([dataset.at(-1)]),'only the new row is transferred');
 assert.deepEqual(late.records.map(r=>r.id),['r0','r1','r2'],'records stay in time order, same as a full read');
 // Commit-order gap: a row takes a lower sequence number but becomes visible after a higher one was read.
 const slow=row('r3','2026-10-28T04:32:00Z',false);dataset.push(slow);dataset.push(row('r4','2026-10-28T04:33:00Z'));
 const before=await loadOpportunitySource(pool,late);assert.equal(before.records.length,4);
 slow.committed=true;payloadBytes=0;
 const gap=await loadOpportunitySource(pool,before);
 assert.equal(gap.records.length,5);assert.equal(gap.source.readMode,'GAP_RECOVERY');assert.equal(gap.source.incrementalRead,true);
 assert.equal(payloadBytes,bytes([slow]),'gap recovery fetches only the missing row');
 assert.deepEqual(gap.records.map(r=>r.id),['r0','r1','r2','r3','r4']);
 const fresh=await loadOpportunitySource(pool);assert.deepEqual(fresh.records,gap.records,'incremental result equals a full read');
 // A late commit far outside the recent window (sequence numbers can be burned by conflicting inserts):
 // keys are compared across the whole archive and only the missing payload is downloaded.
 const far=row('r5','2026-10-28T04:34:00Z',false);dataset.push(far);seq+=6000;
 for(let i=0;i<20;i++)dataset.push(row('n'+i,'2026-10-28T05:'+String(10+i)+':00Z'));
 const beforeFar=await loadOpportunitySource(pool,gap);assert.equal(beforeFar.records.length,25);
 far.committed=true;payloadBytes=0;
 const farGap=await loadOpportunitySource(pool,beforeFar);
 assert.equal(farGap.source.readMode,'GAP_RECOVERY');assert.equal(farGap.records.length,26);assert.equal(payloadBytes,bytes([far]),'a distant gap still fetches only the missing row');
 assert.deepEqual(farGap.records,(await loadOpportunitySource(pool)).records,'still identical to a full read');
 // A deletion: the deleted row is dropped from the cache, with no payload download.
 dataset.splice(0,1);payloadBytes=0;const shrunk=await loadOpportunitySource(pool,farGap);
 assert.equal(shrunk.source.readMode,'GAP_RECOVERY');assert.equal(shrunk.records.length,25);assert.equal(payloadBytes,0);
 assert.deepEqual(shrunk.records,(await loadOpportunitySource(pool)).records);
 // Size limit with deletions (review): deleted rows leave the cache before new rows are counted.
 {
  let n=0;const big=(id,mb)=>({record_key:id,recorded_at:'2026-10-29T04:'+String(10+(n%40)).padStart(2,'0')+':00Z',seq:String(++n),committed:true,
   payload_gzip:gzipSync(JSON.stringify({id,recordType:'POLL_SNAPSHOT',timestamp:'2026-10-29T04:00:00Z',orchestration:{blockers:'x'.repeat(Math.round(mb*1024*1024))}}))});
  dataset.length=0;for(let i=0;i<31;i++)dataset.push(big('b'+i,1));
  const fetches=[];const loaded=await loadOpportunitySource(pool,null,{onFetch:f=>fetches.push(f)});
  assert.ok(loaded.source.retainedBytes>31*1024*1024&&loaded.source.retainedBytes<32*1024*1024,'starts just under the 32 MiB limit');
  assert.equal(fetches.length,1);assert.equal(fetches[0].kind,'FULL');assert.equal(fetches[0].rows,31);
  dataset.splice(0,2);dataset.push(big('c1',0.75),big('c2',0.75)); // net archive about 30.5 MiB
  const after=await loadOpportunitySource(pool,loaded);
  assert.equal(after.records.length,31);assert.ok(after.source.retainedBytes<32*1024*1024);
  assert.equal(after.source.retainedBytes,(await loadOpportunitySource(pool)).source.retainedBytes,'same size accounting as a full read');
 }
 client.query=async sql=>{if(sql.startsWith('SELECT count'))return {rows:[{n:1}]};if(sql.includes('FROM edge_evidence'))return {rows:[{record_key:'x',recorded_at:'2026-10-28T04:30:00Z',seq:'1',payload_gzip:Buffer.from('invalid')}]};if(sql==='ROLLBACK')rollback=true;return {rows:[]};};
 await assert.rejects(()=>loadOpportunitySource(pool));assert.equal(rollback,true);
 console.log('Opportunity source PASS: complete read-only archive, insertion-order cursor, earlier-stamped rows read incrementally, commit-gap recovery and corrupt data failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
