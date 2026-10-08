'use strict';
const assert = require('node:assert/strict');
const { MAX_LIVE_DATA_AGE_MS, isLiveDataFresh, dashboardAvailability } = require('./marketFreshness');

const NOW = 1770000000000;
const sample = { timestamp: new Date(NOW).toISOString() };
assert.equal(MAX_LIVE_DATA_AGE_MS, 120000);
assert.equal(isLiveDataFresh(NOW - 30000, NOW), true);
assert.equal(isLiveDataFresh(NOW - 120000, NOW), true);
assert.equal(isLiveDataFresh(NOW - 120001, NOW), false);
assert.equal(isLiveDataFresh(null, NOW), false);
assert.equal(isLiveDataFresh('not-a-time', NOW), false);
assert.equal(isLiveDataFresh(NOW + 30000, NOW), false);
assert.deepEqual(dashboardAvailability('OPEN', null, NOW, NOW), {ok:false,reason:'NO_DATA_YET'});
assert.deepEqual(dashboardAvailability('OPEN', sample, NOW - 121000, NOW), {ok:false,reason:'STALE_MARKET_DATA'});
assert.deepEqual(dashboardAvailability('OPEN', sample, NOW - 60000, NOW), {ok:true});
assert.deepEqual(dashboardAvailability('CLOSED', sample, NOW - 3600000, NOW), {ok:true}, 'Historical closed-session data remains available');
assert.deepEqual(dashboardAvailability('PRE_OPEN', sample, NOW - 3600000, NOW), {ok:true}, 'Pre-open must not be treated as actionable');
console.log('EDGE dashboard freshness guard PASS');
