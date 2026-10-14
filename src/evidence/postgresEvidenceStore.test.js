'use strict';
const assert=require('assert');
const {createPostgresEvidenceStore}=require('./postgresEvidenceStore');
(async()=>{
 const records=new Map();let fail=false;
 const pool={query:async(sql,args)=>{if(fail)throw new Error('offline');if(sql.startsWith('INSERT')){if(!records.has(args[0]))records.set(args[0],{payload_gzip:args[3]});return {};}return {rows:[...records.values()].reverse()};}};
 const store=createPostgresEvidenceStore({pool});
 const record={id:'signal-1',recordType:'POLL_SNAPSHOT',timestamp:new Date().toISOString(),signalTiers:{A:{status:'NO_TRADE'},B:{status:'RESEARCH'}}};
 assert.equal(await store.append(record),true);assert.equal(await store.append(record),true);assert.equal(records.size,1);
 const restarted=createPostgresEvidenceStore({pool});assert.deepEqual(await restarted.load(),[record]);assert.equal(restarted.status().restoredRecords,1);
 fail=true;assert.equal(await restarted.append({...record,id:'signal-2'}),false);assert.equal(restarted.status().writeError,'DATABASE_APPEND_FAILED');await assert.rejects(()=>restarted.load());
 fail=false;assert.equal(await restarted.append({...record,id:'signal-2'}),true);assert.equal(records.size,2);
 console.log('Postgres evidence: compressed roundtrip, restart restoration, deduplication and failure recovery PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
