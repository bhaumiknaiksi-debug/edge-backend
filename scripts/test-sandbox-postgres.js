'use strict';
// Opt-in integration test. Use only an isolated test branch, never the application DATABASE_URL.
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const {Pool}=require('pg');
const assert=require('node:assert/strict');
const {createSandboxStore}=require('../src/execution/sandboxStore');
(async()=>{
 if(process.env.EDGE_EXECUTION_TEST_ALLOW_WRITE!=='true'||!process.argv[2])throw Error('ISOLATED_TEST_CONFIG_REQUIRED');
 const {connectionString}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const schema='sandbox_test_'+randomBytes(8).toString('hex');
 const root=new Pool({connectionString,connectionTimeoutMillis:5000});let pool;
 try{
  await root.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString,connectionTimeoutMillis:5000,options:'-c search_path='+schema,max:8});
  const a=createSandboxStore({pool}),b=createSandboxStore({pool});await a.init();await b.init();
  await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).mutate(s=>{s.counter=(s.counter||0)+1;})));
  assert.equal((await a.read()).counter,20);
  await assert.rejects(()=>a.mutate(s=>{s.counter=999;throw Error('FORCED_ROLLBACK');}),/FORCED_ROLLBACK/);
  assert.equal((await b.read()).counter,20);
  const restarted=createSandboxStore({pool});assert.equal((await restarted.read()).counter,20);
  const row=await pool.query('SELECT count(*)::int AS count FROM edge_sandbox_execution_v1');assert.equal(row.rows[0].count,1);
  console.log('Real PostgreSQL sandbox store PASS: additive initialization, concurrent row locking, rollback and restart persistence; test schema '+schema);
 }finally{if(pool)await pool.end();await root.end();}
})().catch(e=>{console.error('PostgreSQL sandbox integration failed:',/^[A-Z_0-9]+$/.test(e.code||'')?e.code:'TEST_FAILED');process.exitCode=1;});
