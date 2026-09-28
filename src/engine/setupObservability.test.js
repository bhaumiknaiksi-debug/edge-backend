'use strict';

const assert = require('assert');
const { buildSetupObservability } = require('./setupObservability');

function candle(ts, o, h, l, c, v = 0) { return [ts, o, h, l, c, v, 0]; }

const index = [];
const future = [];
for (let i = 0; i < 18; i++) {
  const minute = 15 + i * 5;
  const hh = 9 + Math.floor(minute / 60);
  const mm = minute % 60;
  const iso = '2026-09-28T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+05:30';
  const base = 23000 + i * 5;
  index.push(candle(iso, base, base + 10, base - 10, base + 5));
  future.push(candle(iso, base + 20, base + 30, base + 10, base + 25, 1000 + i * 100));
}

const x = buildSetupObservability({ index5m: index, future5m: future });
assert.strictEqual(x.researchOnly, true);
assert.strictEqual(x.liveDecisionImpact, false);
assert.strictEqual(x.atr.source, 'NIFTY_INDEX');
assert(x.atr.value > 0);
assert.strictEqual(x.openingRange.available, true);
assert.strictEqual(x.openingRange.high, 23020);
assert.strictEqual(x.openingRange.low, 22990);
assert.strictEqual(x.openingRange.position, 'ABOVE');
assert.strictEqual(x.vwap.available, true);
assert.strictEqual(x.vwap.proxyForSpot, true);
assert(x.vwap.value > 23000);
assert(x.volume.relativeVolume > 0);
assert.strictEqual(x.dataCoverage.index5mCandles, 18);
assert.strictEqual(x.dataCoverage.future5mCandles, 18);

const missing = buildSetupObservability();
assert.strictEqual(missing.atr.value, null);
assert.strictEqual(missing.openingRange.available, false);
assert.strictEqual(missing.vwap.available, false);

console.log('EDGE setup observability tests passed');
