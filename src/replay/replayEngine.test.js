'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runReplay } = require('./replayEngine');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../fixtures/replay-scenarios.json'), 'utf8'
));

const report = runReplay(fixture);
assert.strictEqual(report.count, 4);
assert.strictEqual(report.executionAllowedCount >= 0, true);
assert.strictEqual(report.results[0].status, 'READY_TO_EXECUTE');
assert.strictEqual(report.results[1].status, 'WAIT_FOR_TRIGGER');
assert.strictEqual(report.results[2].status, 'POSITION_BLOCKED');
assert.strictEqual(report.results[3].status, 'MARKET_CLOSED');

console.log('EDGE replay tests passed');
