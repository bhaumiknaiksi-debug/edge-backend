'use strict';

const assert = require('assert');
const { selectNearestNiftyFuture, expiryIso, istDateString, shiftIsoDate } = require('./marketContext');

const now = new Date('2026-09-30T02:45:00Z').getTime();
assert.strictEqual(istDateString(now), '2026-09-30');
assert.strictEqual(shiftIsoDate('2026-10-01', -1), '2026-09-30');

const rows = [
  {instrument_type:'FUT',segment:'NSE_FO',underlying_symbol:'NIFTY',expiry:'2026-09-29',instrument_key:'expired',trading_symbol:'NIFTY FUT 29 SEP 26'},
  {instrument_type:'FUT',segment:'NSE_FO',underlying_symbol:'FINNIFTY',expiry:'2026-10-27',instrument_key:'wrong-index',trading_symbol:'FINNIFTY FUT 27 OCT 26'},
  {instrument_type:'FUT',segment:'NSE_FO',underlying_symbol:'NIFTY',expiry:'2026-11-26',instrument_key:'far',trading_symbol:'NIFTY FUT 26 NOV 26'},
  {instrument_type:'FUT',segment:'NSE_FO',underlying_symbol:'NIFTY',expiry:'2026-10-29',instrument_key:'near',trading_symbol:'NIFTY FUT 29 OCT 26'},
  {instrument_type:'CE',segment:'NSE_FO',underlying_symbol:'NIFTY',expiry:'2026-10-06',instrument_key:'option',trading_symbol:'NIFTY 25000 CE'}
];

const selected = selectNearestNiftyFuture(rows, now);
assert.ok(selected);
assert.strictEqual(selected.instrument_key, 'near');

const numericExpiry = Date.parse('2026-10-29T00:00:00Z');
assert.strictEqual(expiryIso(numericExpiry), '2026-10-29');
assert.strictEqual(selectNearestNiftyFuture([
  {instrument_type:'FUT',segment:'NSE_FO',name:'NIFTY 50',expiry:numericExpiry,instrument_key:'numeric',trading_symbol:'NIFTY FUT 29 OCT 26'}
], now).instrument_key, 'numeric');

assert.strictEqual(selectNearestNiftyFuture([
  {instrument_type:'FUT',segment:'NSE_FO',underlying_symbol:'FINNIFTY',expiry:'2026-10-27',instrument_key:'fin'}
], now), null);

console.log('EDGE market context futures discovery tests passed');
