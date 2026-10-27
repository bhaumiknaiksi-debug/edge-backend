'use strict';
const assert=require('node:assert/strict');
const {createSandboxStore}=require('./sandboxStore');
function poolModel(){
 let payload=null,tail=Promise.resolve(),failUpdate=false,failCommit=false;
 const copy=x=>structuredClone(x);
 const pool={
  async query(sql,args){
   if(sql.startsWith('CREATE TABLE'))return {rows:[]};
   if(sql.startsWith('INSERT INTO')){payload ||= JSON.parse(args[0]);return {rows:[]};}
   if(sql.includes('SELECT payload'))return {rows:[{payload:copy(payload)}]};
   throw Error('UNEXPECTED_POOL_SQL');
  },
  async connect(){let local=null,release=null;return {async query(sql,args){
   if(sql==='BEGIN')return {rows:[]};
   if(sql.includes('FOR UPDATE')){const before=tail;tail=new Promise(r=>{release=r;});await before;local=copy(payload);return {rows:[{payload:copy(local)}]};}
   if(sql.startsWith('UPDATE')){assert.ok(release,'write must hold row lock');if(failUpdate){failUpdate=false;throw Error('WRITE_FAILED');}local=JSON.parse(args[0]);return {rows:[]};}
   if(sql==='COMMIT'){payload=local;release();release=null;if(failCommit){failCommit=false;throw Error('COMMIT_ACK_LOST');}return {rows:[]};}
   if(sql==='ROLLBACK'){if(release){release();release=null;}return {rows:[]};}
   throw Error('UNEXPECTED_CLIENT_SQL');
  },release(){assert.equal(release,null,'transaction lock released');}};
  },failUpdate(){failUpdate=true;},loseCommitAck(){failCommit=true;}
 };
 return pool;
}
(async()=>{
 const pool=poolModel(),a=createSandboxStore({pool}),b=createSandboxStore({pool});
 await a.init();await b.init();
 await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).mutate(s=>{s.counter=(s.counter||0)+1;})));
 assert.equal((await a.read()).counter,20);
 pool.failUpdate();await assert.rejects(()=>a.mutate(s=>{s.counter=999;}),/WRITE_FAILED/);assert.equal((await b.read()).counter,20);
 pool.loseCommitAck();await assert.rejects(()=>a.mutate(s=>{s.counter++;}),/COMMIT_ACK_LOST/);assert.equal((await b.read()).counter,21,'lost ACK may still be a committed write');
 await assert.rejects(()=>a.mutate(async()=>1),/ASYNC_REDUCER_NOT_ALLOWED/);
 const restarted=createSandboxStore({pool});assert.equal((await restarted.read()).counter,21);
 console.log('Sandbox store contract PASS: concurrent serialization, rollback, ambiguous commit ACK, restart and synchronous transaction reducers');
})().catch(e=>{console.error(e);process.exitCode=1;});
