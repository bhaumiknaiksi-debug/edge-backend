'use strict';
const {initialState,assertState}=require('./sandboxEngine');
const SCHEMA=`CREATE TABLE IF NOT EXISTS edge_sandbox_execution_v1 (
 id text PRIMARY KEY CHECK(id='owner'), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
function createSandboxStore({pool}){
  let initialized=null;
  async function init(){
    if(!pool)throw Error('SANDBOX_DATABASE_REQUIRED');
    if(!initialized)initialized=(async()=>{await pool.query(SCHEMA);await pool.query("INSERT INTO edge_sandbox_execution_v1(id,payload) VALUES('owner',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(initialState())]);})().catch(e=>{initialized=null;throw e;});
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
      await client.query("UPDATE edge_sandbox_execution_v1 SET payload=$1::jsonb,updated_at=now() WHERE id='owner'",[JSON.stringify(state)]);
      await client.query('COMMIT');return {state,result};
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  async function read(){await init();const row=await pool.query("SELECT payload FROM edge_sandbox_execution_v1 WHERE id='owner'");const state=row.rows[0].payload;assertState(state);return state;}
  return {init,mutate,read};
}
module.exports={createSandboxStore,SCHEMA};
