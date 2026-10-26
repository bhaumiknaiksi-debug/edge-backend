'use strict';

// Deterministic in-memory PostgreSQL contract fake. Never contacts a database or Telegram.
function fakeTelegramPool() {
  const fake={states:new Map(),events:new Map(),outbox:new Map(),queries:[],commits:0,releases:0,failMatch:null};
  const copy=()=>structuredClone({states:fake.states,events:fake.events,outbox:fake.outbox});
  const result=(rows=[],rowCount=rows.length)=>({rows,rowCount});
  async function query(sql,args=[]) {
    fake.queries.push(sql);
    if(fake.failMatch&&sql.includes(fake.failMatch))throw new Error('private database details must never escape');
    if(sql.includes('CREATE TABLE IF NOT EXISTS edge_telegram_state_v1'))return result();
    if(sql.startsWith('INSERT INTO edge_telegram_state_v1')) {
      if(!fake.states.has(args[0]))fake.states.set(args[0],JSON.parse(args[1]));
      return result();
    }
    if(sql.startsWith('SELECT payload FROM edge_telegram_state_v1'))return result(fake.states.has(args[0])?[{payload:structuredClone(fake.states.get(args[0]))}]:[]);
    if(sql.startsWith('UPDATE edge_telegram_state_v1')) {fake.states.set(args[0],JSON.parse(args[1]));return result([],1);}
    if(sql.startsWith('INSERT INTO edge_telegram_events_v1')) {
      if(!fake.events.has(args[0]))fake.events.set(args[0],{recipient:args[1],payload:JSON.parse(args[4])});
      return result();
    }
    if(sql.startsWith('INSERT INTO edge_telegram_outbox_v1')) {
      if(!fake.events.has(args[0]))throw new Error('FK violation');
      if(!fake.outbox.has(args[0]))fake.outbox.set(args[0],{id:args[0],recipient:args[1],priority:args[2],
        createdAt:args[3],nextAttemptAt:args[3],status:'PENDING',attempts:0});
      return result();
    }
    if(sql.includes("SET status='UNCERTAIN'")) {
      for(const item of fake.outbox.values())if(item.recipient===args[0]&&item.status==='SENDING'&&item.leaseUntil<=args[1]) {
        item.status='UNCERTAIN';item.error='WORKER_INTERRUPTED';item.leaseUntil=null;
      }
      return result();
    }
    if(sql.startsWith('SELECT q.event_id')) {
      const rows=[...fake.outbox.values()].filter(item=>item.recipient===args[0]&&item.status==='PENDING'&&item.nextAttemptAt<=args[1])
        .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.priority-b.priority||a.id.localeCompare(b.id));
      const item=rows[0];
      return result(item?[{event_id:item.id,attempts:item.attempts,payload:structuredClone(fake.events.get(item.id).payload)}]:[]);
    }
    if(sql.includes("SET status='SENDING'")) {
      const item=fake.outbox.get(args[0]);
      if(item?.recipient===args[1]){item.status='SENDING';item.attempts++;item.leaseUntil=args[2];}
      return result([],1);
    }
    if(sql.includes('SET status=$3')) {
      const item=fake.outbox.get(args[0]);
      if(item?.recipient!==args[1]||item.status!=='SENDING')return result();
      Object.assign(item,{status:args[2],messageId:args[3],error:args[4],nextAttemptAt:args[5]||item.nextAttemptAt,leaseUntil:null});
      return result([],1);
    }
    throw new Error('Unexpected SQL contract: '+sql);
  }
  const pool={query,connect:async()=>{
    let saved;
    return {query:async(sql,args)=>{
      if(sql==='BEGIN'){saved=copy();return result();}
      if(sql==='COMMIT'){fake.commits++;return result();}
      if(sql==='ROLLBACK'){Object.assign(fake,saved);return result();}
      return query(sql,args);
    },release:()=>{fake.releases++;}};
  }};
  return {fake,pool};
}

function decision(time,ready=false,contract='NIFTY TEST CE') {
  return {timestamp:new Date(time).toISOString(),market:{phase:'OPEN'},decision:{strategy:'LONG_CALL',
    orchestration:{status:ready?'READY_TO_EXECUTE':'WAIT_FOR_TRIGGER',executionAllowed:ready},
    signalTier:{tier:ready?'A':'C',executionAllowed:ready,researchOnly:!ready},
    tradeLegs:{buyLeg:{contractId:contract,instrumentKey:contract+'|key'}}}};
}
const testEnv={EDGE_TELEGRAM_ENABLED:'true',EDGE_TELEGRAM_BOT_TOKEN:'123456:FAKE_TEST_TOKEN_NOT_REAL_1234567890',EDGE_TELEGRAM_CHAT_ID:'123456789'};
module.exports={fakeTelegramPool,decision,testEnv};
