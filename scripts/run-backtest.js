'use strict';

const fs = require('fs');
const path = require('path');
const { runBacktest } = require('../src/replay/backtestEngine');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-backtest.js <backtest.json>');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const report = runBacktest(input);
console.log(JSON.stringify(report, null, 2));
