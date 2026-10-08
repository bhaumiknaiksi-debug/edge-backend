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
