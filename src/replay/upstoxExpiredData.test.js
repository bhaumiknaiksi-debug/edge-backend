'use strict';

const assert = require('assert');
const { normalizeCandle } = require('./upstoxExpiredData');

const row = normalizeCandle(
  ['2026-04-01T09:20:00+05:30', 100, 110, 95, 105, 1200, 50000],
  { strike_price: 23000, instrument_type: 'CE', expiry: '2026-04-30', instrument_key: 'NSE_FO|TEST', lot_size: 65 }
);

assert.strictEqual(row.close, 105);
assert.strictEqual(row.oi, 50000);
assert.strictEqual(row.strike, 23000);
assert.strictEqual(row.optionType, 'CE');
assert.strictEqual(row.lotSize, 65);

console.log('EDGE historical adapter tests passed');
