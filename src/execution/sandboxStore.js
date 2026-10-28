'use strict';
const {initialState,assertState}=require('./sandboxEngine');
const SCHEMA=`CREATE TABLE IF NOT EXISTS edge_sandbox_execution_v1 (
 id text PRIMARY KEY CHECK(id='owner'), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
// Append-only history: closed trades moved out of the hot state, and every model decision.
const ARCHIVE_SCHEMA=`CREATE TABLE IF NOT EXISTS edge_sandbox_archive_v1 (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('TRADE','DECISION')), recorded_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL)`;
function createSandboxStore({pool}){
  let initialized=null;
  async function init(){
    if(!pool)throw Error('SANDBOX_DATABASE_REQUIRED');
    if(!initialized)initialized=(async()=>{await pool.query(SCHEMA);await pool.query(ARCHIVE_SCHEMA);await pool.query("INSERT INTO edge_sandbox_execution_v1(id,payload) VALUES('owner',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(initialState())]);})().catch(e=>{initialized=null;throw e;});
    await initialized;
  }
  async function mutate(fn){
    await init();const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const row=await client.query("SELECT payload FROM edge_sandbox_execution_v1 WHERE id='owner' FOR UPDATE");
      const state=JSON.parse(JSON.stringify(row.rows[0].payload));assertState(state);
      const result=fn(state);
      if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw Error('ASYNC_REDUCER_NOT_ALLOWED');}
      // Archive rows written by the reducer are inserted in the SAME transaction as the state that dropped them.
      const queue=Array.isArray(state.archiveQueue)?state.archiveQueue:[];delete state.archiveQueue;assertState(state);
      for(const row of queue){
        if(typeof row?.id!=='string'||!row.id||row.id.length>200||!['TRADE','DECISION'].includes(row.kind))throw Error('INVALID_ARCHIVE_ROW');
        await client.query('INSERT INTO edge_sandbox_archive_v1(id,kind,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING',[row.id,row.kind,JSON.stringify(row.payload)]);
      }
      await client.query("UPDATE edge_sandbox_execution_v1 SET payload=$1::jsonb,updated_at=now() WHERE id='owner'",[JSON.stringify(state)]);
      await client.query('COMMIT');return {state,result};
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  async function read(){await init();const row=await pool.query("SELECT payload FROM edge_sandbox_execution_v1 WHERE id='owner'");const state=row.rows[0].payload;assertState(state);return state;}
  async function readArchive(kind,limit=5000){
    await init();
    const rows=await pool.query('SELECT payload FROM edge_sandbox_archive_v1 WHERE kind=$1 ORDER BY recorded_at DESC, id DESC LIMIT $2',[kind,Math.min(20000,Math.max(1,limit|0))]);
    return rows.rows.map(r=>r.payload);
  }
  return {init,mutate,read,readArchive};
}
module.exports={createSandboxStore,SCHEMA,ARCHIVE_SCHEMA};
