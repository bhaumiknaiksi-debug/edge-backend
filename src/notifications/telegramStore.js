'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { advanceTelegram } = require('./telegramEvents');
const readSchema = () => fs.readFileSync(path.join(__dirname,'../storage/telegram.sql'),'utf8');

function createTelegramStore({pool,recipientKey}) {
  let transactions = Promise.resolve();
  async function withClient(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
  }
  function transaction(work) {
    // One active transport transaction per producer; no database client is held
    // while waiting for Telegram. This limits contention with the existing pool.
    const result = transactions.then(()=>withClient(work));
    transactions = result.catch(()=>{});
    return result;
  }
  async function lockState(client) {
    await client.query('INSERT INTO edge_telegram_state_v1(recipient_key,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [recipientKey,'{}']);
    const result = await client.query('SELECT payload FROM edge_telegram_state_v1 WHERE recipient_key=$1 FOR UPDATE',[recipientKey]);
    if (!result.rows[0]) throw new Error('TELEGRAM_STATE_UNAVAILABLE');
    return result.rows[0].payload;
  }
  async function saveState(client,state) {
    await client.query('UPDATE edge_telegram_state_v1 SET payload=$2::jsonb WHERE recipient_key=$1',[recipientKey,JSON.stringify(state)]);
  }
  async function checkpoint(context) {
    return transaction(async client => {
      const previous = await lockState(client);
      const {state,events} = advanceTelegram(previous,{...context,recipientKey});
      for (const event of events) {
        await client.query(`INSERT INTO edge_telegram_events_v1(event_id,recipient_key,occurred_at,event_type,payload)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [event.id,recipientKey,event.occurredAt,event.type,JSON.stringify(event)]);
        const priority = event.type === 'EXECUTION_READY' ? 20 : event.type === 'DAILY_SUMMARY' ? 30 : 10;
        await client.query(`INSERT INTO edge_telegram_outbox_v1(event_id,recipient_key,priority,created_at,next_attempt_at)
          VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING`,[event.id,recipientKey,priority,new Date(context.now).toISOString()]);
      }
      await saveState(client,state);
      return {events:events.length};
    });
  }
  async function loadState() {
    const result = await pool.query('SELECT payload FROM edge_telegram_state_v1 WHERE recipient_key=$1',[recipientKey]);
    return result.rows[0]?.payload || {};
  }
  async function claim(now) {
    return transaction(async client => {
      const state = await lockState(client);
      const timestamp = new Date(now).toISOString();
      // A process may have crashed after Telegram accepted a send but before its ACK was
      // stored. Never silently retry such a message as though it was certainly unsent.
      await client.query(`UPDATE edge_telegram_outbox_v1 SET status='UNCERTAIN',last_error='WORKER_INTERRUPTED',lease_until=NULL
        WHERE recipient_key=$1 AND status='SENDING' AND lease_until<=$2`,[recipientKey,timestamp]);
      if (now - (state.lastAttemptAt || 0) < 1500) return null;
      const result = await client.query(`SELECT q.event_id,q.attempts,e.payload FROM edge_telegram_outbox_v1 q
        JOIN edge_telegram_events_v1 e ON e.event_id=q.event_id
        WHERE q.recipient_key=$1 AND q.status='PENDING' AND q.next_attempt_at<=$2
        ORDER BY q.created_at,q.priority,q.event_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED`,[recipientKey,timestamp]);
      const row = result.rows[0];
      if (!row) return null;
      await client.query(`UPDATE edge_telegram_outbox_v1 SET status='SENDING',attempts=attempts+1,lease_until=$3
        WHERE event_id=$1 AND recipient_key=$2`,[row.event_id,recipientKey,new Date(now+15000).toISOString()]);
      state.lastAttemptAt = now;
      await saveState(client,state);
      return {event:row.payload,attempts:row.attempts+1};
    });
  }
  async function finish(eventId,status,{messageId=null,error=null,nextAttemptAt=null}={}) {
    if (!['PENDING','SENT','EXPIRED','FAILED','UNCERTAIN'].includes(status)) throw new Error('INVALID_DELIVERY_STATUS');
    return pool.query(`UPDATE edge_telegram_outbox_v1 SET status=$3,message_id=$4,last_error=$5,
      next_attempt_at=COALESCE($6,next_attempt_at),lease_until=NULL
      WHERE event_id=$1 AND recipient_key=$2 AND status='SENDING'`,
    [eventId,recipientKey,status,messageId,error,nextAttemptAt]);
  }
  return {initialize:()=>pool.query(readSchema()),checkpoint,loadState,claim,finish};
}

module.exports = { createTelegramStore,readSchema };
