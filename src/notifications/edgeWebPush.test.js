'use strict';

const assert = require('node:assert/strict');
const {
  validEndpoint, validSubscription, timingSafeOwnerToken,
  summarizeDecision, makeTransition
} = require('./edgeWebPush');

const base = {
  endpoint: 'https://web.push.apple.com/abc123',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) }
};
assert.equal(validSubscription(base), true);
assert.equal(validEndpoint('http://localhost/admin'), false);
assert.equal(validEndpoint('https://evil.push.apple.com.attacker.invalid/path'), false);
assert.equal(validEndpoint('https://127.0.0.1/private'), false);
assert.equal(validEndpoint('https://user:password@web.push.apple.com/abc'), false);
assert.equal(validEndpoint('https://web.push.apple.com:8443/abc'), false);
assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/123'), true);
assert.equal(validSubscription({ ...base, keys: { ...base.keys, auth: '' } }), false);
assert.equal(timingSafeOwnerToken('owner', 'owner'), true);
assert.equal(timingSafeOwnerToken('wrong', 'owner'), false);
assert.equal(timingSafeOwnerToken('', ''), false);

function decision(status, allowed, phase = 'OPEN', date = new Date().toISOString()) {
  return {
    timestamp: date,
    decision: {
      orchestration: { status, executionAllowed: allowed },
      strategy: 'LONG_CALL', signalTier: { tier: allowed ? 'A' : 'B' },
      tradeLegs: { buyLeg: { contractId: 'NIFTY TEST CE' } }
    },
    market: { phase }
  };
}

const waiting = summarizeDecision(decision('WAIT_FOR_TRIGGER', false));
const ready = summarizeDecision(decision('READY_TO_EXECUTE', true));
const locked = summarizeDecision(decision('READY_TO_EXECUTE', false));
const marketClosed = summarizeDecision(decision('READY_TO_EXECUTE', true, 'CLOSED'));
assert.equal(waiting.ready, false);
assert.equal(ready.ready, true);
assert.equal(locked.ready, false, 'Never infer green from status alone');
assert.equal(marketClosed.ready, false, 'Never notify ready when market is closed');
assert.equal(makeTransition(null, ready), null, 'No startup READY notification');
assert.equal(makeTransition(waiting, ready)?.type, 'EXECUTION_READY');
assert.equal(makeTransition(ready, waiting)?.type, 'READY_INVALIDATED');
assert.equal(makeTransition(waiting, waiting), null);
assert.equal(makeTransition(ready, ready), null);
assert.equal(makeTransition(waiting, summarizeDecision(decision('NO_TRADE', false))), null);

const stale = summarizeDecision(decision('READY_TO_EXECUTE', true, 'OPEN', new Date(Date.now()-120000).toISOString()));
assert.equal(stale, null, 'No stale market signal');
assert.equal(makeTransition({ ...waiting, observedAt: new Date(Date.now()-180000).toISOString() }, ready), null, 'No stale transition');
console.log('EDGE Web Push security and authoritative transition tests PASS');

async function integration() {
  const previousWaiting = summarizeDecision(decision('WAIT_FOR_TRIGGER', false));
  const fake = {
    current: previousWaiting,
    sends: [],
    pool: null,
    failInitialization: false
  };
  const client = {
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('INSERT INTO edge_push_state')) {
        if (!fake.current) fake.current = JSON.parse(params[0]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT payload FROM edge_push_state")) {
        return { rows: [{ payload: fake.current }], rowCount: 1 };
      }
      if (sql.includes('UPDATE edge_push_state')) {
        fake.current = JSON.parse(params[0]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error('unexpected PG statement: ' + sql);
    },
    release() {}
  };
  fake.pool = {
    async query(sql) {
      if (fake.failInitialization && sql.includes('CREATE TABLE')) throw new Error('database temporarily offline');
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT endpoint_hash, subscription FROM edge_push_subscriptions')) {
        return { rows: [{ endpoint_hash: 'hash', subscription: base }] };
      }
      throw new Error('unexpected pool statement: ' + sql);
    },
    async connect() { return client; }
  };
  const sender = {
    setVapidDetails() {},
    async sendNotification(_sub, payload) {
      fake.sends.push(JSON.parse(payload));
      return { statusCode: 201 };
    }
  };
  const env = {
    EDGE_PUSH_VAPID_PUBLIC_KEY: 'A'.repeat(87),
    EDGE_PUSH_VAPID_PRIVATE_KEY: 'B'.repeat(43),
    EDGE_PUSH_VAPID_SUBJECT: 'mailto:edge@example.com',
    EDGE_PUSH_OWNER_TOKEN: 'z'.repeat(32),
    EDGE_PUSH_DATABASE_URL: 'postgresql://localhost/fake',
    EDGE_PUSH_AUTO_ALERTS: 'true'
  };
  const { buildWebPush } = require('./edgeWebPush');
  const manager = buildWebPush(env, { pool: fake.pool, sender });
  assert.equal(await manager.initialize(), true);
  await manager.onSuccessfulPoll(decision('READY_TO_EXECUTE', true));
  assert.equal(fake.sends.length, 0, 'First successful poll after restart must not send a retroactive READY notification');
  await manager.onSuccessfulPoll(decision('WAIT_FOR_TRIGGER', false));
  assert.equal(fake.sends.length, 1, 'Fresh READY invalidation should notify exactly once');
  assert.equal(fake.sends[0].type, 'READY_INVALIDATED');
  await manager.onSuccessfulPoll(decision('WAIT_FOR_TRIGGER', false));
  assert.equal(fake.sends.length, 1, 'Stable state must not emit duplicates');
  await manager.onSuccessfulPoll(decision('READY_TO_EXECUTE', true));
  assert.equal(fake.sends.length, 2);
  assert.equal(fake.sends[1].type, 'EXECUTION_READY');

  // Retry logic must reinitialize successfully after transient storage downtime.
  fake.failInitialization = true;
  const second = buildWebPush(env, { pool: fake.pool, sender });
  assert.equal(await second.initialize(), false);
  fake.failInitialization = false;
  const realDateNow = Date.now;
  try {
    const baseTime = realDateNow();
    Date.now = () => baseTime + 16000;
    assert.equal(await second.initialize(), true, 'Push storage should retry after a transient outage');
  } finally {
    Date.now = realDateNow;
  }
  console.log('EDGE Web Push persistence, restart and retry tests PASS');
}
integration().catch(error => { console.error(error); process.exitCode = 1; });

