'use strict';

const https = require('https');

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return reject(new Error('Invalid JSON from Upstox')); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Upstox HTTP ' + res.statusCode + ': ' + (parsed?.errors?.[0]?.message || parsed?.message || body.slice(0, 200))));
        }
        resolve(parsed);
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Upstox request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function getExpiredContracts({ token, expiry }) {
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is required');
  const url = new URL('https://api.upstox.com/v2/expired-instruments/option/contract');
  url.searchParams.set('instrument_key', 'NSE_INDEX|Nifty 50');
  url.searchParams.set('expiry_date', expiry);
  const data = await requestJson(url, token);
  return data.data || [];
}

async function getExpiredCandle({ token, instrumentKey, interval, fromDate, toDate }) {
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is required');
  const url = new URL(
    'https://api.upstox.com/v2/expired-instruments/historical-candle/' +
    encodeURIComponent(instrumentKey) + '/' + interval + '/' + toDate + '/' + fromDate
  );
  const data = await requestJson(url, token);
  return data.data?.candles || [];
}

function normalizeCandle(candle, contract) {
  return {
    timestamp: candle[0],
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
    oi: Number(candle[6]),
    strike: Number(contract.strike_price),
    optionType: contract.instrument_type,
    expiry: contract.expiry,
    instrumentKey: contract.instrument_key,
    lotSize: Number(contract.lot_size)
  };
}

/**
 * Fetch a bounded set of expired option contracts around a spot/strike range.
 * The API provides expired contract metadata and OHLC/OI candles, but not
 * historical bid/ask, IV or Greeks. Those fields therefore remain absent.
 */
async function fetchExpiredOptionWindow({
  token,
  expiry,
  fromDate,
  toDate,
  interval = '5minute',
  minStrike,
  maxStrike,
  maxContracts = 40
}) {
  const contracts = await getExpiredContracts({ token, expiry });
  const filtered = contracts
    .filter(c => ['CE', 'PE'].includes(c.instrument_type))
    .filter(c => minStrike == null || Number(c.strike_price) >= Number(minStrike))
    .filter(c => maxStrike == null || Number(c.strike_price) <= Number(maxStrike))
    .slice(0, maxContracts);

  const candles = [];
  for (const contract of filtered) {
    const rows = await getExpiredCandle({
      token,
      instrumentKey: contract.instrument_key,
      interval,
      fromDate,
      toDate
    });
    for (const row of rows) candles.push(normalizeCandle(row, contract));
  }

  return {
    expiry,
    fromDate,
    toDate,
    interval,
    contractsRequested: filtered.length,
    observations: candles.length,
    contracts: filtered,
    candles,
    coverage: {
      ltp: true,
      oi: true,
      volume: true,
      bidAsk: false,
      iv: false,
      greeks: false,
      reason: 'Upstox expired historical candle data supplies OHLC and OI, not historical option-chain bid/ask, IV or Greeks.'
    }
  };
}

module.exports = {
  normalizeCandle,
  getExpiredContracts,
  getExpiredCandle,
  fetchExpiredOptionWindow
};
