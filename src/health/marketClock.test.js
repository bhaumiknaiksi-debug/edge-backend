'use strict';
const assert = require('node:assert/strict');
const { nextMarketOpenIST } = require('./marketClock');

const holiday = new Set(['2026-10-20']);
assert.equal(nextMarketOpenIST(new Date('2026-10-08T02:00:00Z'), holiday)?.toISOString(), '2026-10-08T03:45:00.000Z');
assert.equal(nextMarketOpenIST(new Date('2026-10-08T04:00:00Z'), holiday)?.toISOString(), '2026-10-09T03:45:00.000Z');
assert.equal(nextMarketOpenIST(new Date('2026-10-09T07:30:00Z'), holiday)?.toISOString(), '2026-10-12T03:45:00.000Z');
assert.equal(nextMarketOpenIST(new Date('2026-10-19T04:00:00Z'), holiday)?.toISOString(), '2026-10-21T03:45:00.000Z');
assert.equal(nextMarketOpenIST(new Date('2026-10-07T23:30:00Z'), holiday)?.toISOString(), '2026-10-08T03:45:00.000Z');
console.log('EDGE next market open timezone tests PASS');
