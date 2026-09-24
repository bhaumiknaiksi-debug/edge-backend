'use strict';

const fs = require('fs');
const path = require('path');
const { fetchExpiredOptionWindow } = require('../src/replay/upstoxExpiredData');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  const expiry = arg('expiry');
  const fromDate = arg('from');
  const toDate = arg('to', fromDate);
  if (!token || !expiry || !fromDate) {
    throw new Error('Usage: UPSTOX_ACCESS_TOKEN=... node scripts/fetch-expired-window.js --expiry YYYY-MM-DD --from YYYY-MM-DD [--to YYYY-MM-DD] [--interval 5minute] [--min-strike N] [--max-strike N]');
  }

  const data = await fetchExpiredOptionWindow({
    token,
    expiry,
    fromDate,
    toDate,
    interval: arg('interval', '5minute'),
    minStrike: arg('min-strike'),
    maxStrike: arg('max-strike'),
    maxContracts: Number(arg('max-contracts', 40))
  });

  const out = arg('out', path.join('fixtures', 'historical', expiry + '.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.log('Saved', out);
  console.log(JSON.stringify(data.coverage, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
