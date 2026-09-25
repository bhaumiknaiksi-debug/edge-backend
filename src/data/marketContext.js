'use strict';

const https = require('https');

const API_BASE = 'https://api.upstox.com';
const INDEX_KEY = 'NSE_INDEX|Nifty 50';
const VIX_KEY = 'NSE_INDEX|India VIX';

let cachedFuture = null;
let cachedAt = 0;
const CACHE_MS = 15 * 60 * 1000;

function requestJson(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + (process.env.UPSTOX_ACCESS_TOKEN || ''),
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (_) { return reject(new Error('Upstox market-data JSON parse failed')); }
        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.status === 'error') {
          return reject(new Error('Upstox market-data HTTP ' + res.statusCode));
        }
        resolve(parsed);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Upstox market-data request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function findNearestNiftyFuture() {
  const now = Date.now();
  if (cachedFuture && now - cachedAt < CACHE_MS) return cachedFuture;

  const q = new URLSearchParams({
    query: 'NIFTY',
    exchanges: 'NSE',
    segments: 'FO',
    instrument_types: 'FUT',
    expiry: 'near_month',
    page_number: '1',
    records: '30'
  });
  const parsed = await requestJson('/v2/instruments/search?' + q.toString());
  const rows = (parsed.data || [])
    .filter(x => x && x.instrument_type === 'FUT' && x.segment === 'NSE_FO')
    .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));

  if (!rows.length) throw new Error('No active NIFTY futures contract found');
  cachedFuture = rows[0];
  cachedAt = now;
  return cachedFuture;
}

function extractQuote(parsed, instrumentKey) {
  const data = parsed.data || {};
  const normalized = instrumentKey.replace('|', ':');
  return data[instrumentKey] || data[normalized] || Object.values(data)[0] || null;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

async function fetchMarketContext() {
  const future = await findNearestNiftyFuture();
  const keys = [INDEX_KEY, future.instrument_key, VIX_KEY].join(',');

  const [quote, thirty, intraday5, intraday15] = await Promise.all([
    requestJson('/v3/market-quote/quotes?instrument_key=' + encodeURIComponent(keys)),
    requestJson('/v3/market-quote/ohlc?instrument_key=' + encodeURIComponent(INDEX_KEY) + '&interval=I30'),
    requestJson('/v3/historical-candle/intraday/' + encodeURIComponent(INDEX_KEY) + '/minutes/5').catch(() => ({data:{candles:[]}})),
    requestJson('/v3/historical-candle/intraday/' + encodeURIComponent(INDEX_KEY) + '/minutes/15').catch(() => ({data:{candles:[]}}))
  ]);

  const indexQuote = extractQuote(quote, INDEX_KEY);
  const futureQuote = extractQuote(quote, future.instrument_key);
  const vixQuote = extractQuote(quote, VIX_KEY);
  if (!indexQuote) throw new Error('NIFTY index quote unavailable');
  if (!futureQuote) throw new Error('NIFTY futures quote unavailable');

  const indexOhlc = indexQuote.ohlc || {};
  const futureOhlc = futureQuote.ohlc || {};
  const thirtyQuote = extractQuote(thirty, INDEX_KEY);
  const live30 = thirtyQuote?.live_ohlc || thirtyQuote?.ohlc || {};
  const prev30 = thirtyQuote?.prev_ohlc || {};

  const spot = Number(indexQuote.last_price ?? indexOhlc.close);
  const sessionChangePct = pct(spot, Number(indexQuote.prev_close_price ?? indexOhlc.open));
  const futuresPrice = Number(futureQuote.last_price ?? futureOhlc.close);
  const futuresPriceChangePct = pct(futuresPrice, Number(futureQuote.prev_close_price ?? futureOhlc.open));

  const currentOI = Number(futureQuote.oi);
  const previousOI = Number(futureQuote.previous_oi);
  const futuresOIChangePct = pct(currentOI, previousOI);
  const trend30mPct = pct(Number(live30.close), Number(prev30.close));
  function candleTrend(parsed) {
    const candles = parsed?.data?.candles || [];
    if (candles.length < 2) return null;
    const newest = Number(candles[0]?.[4]), previous = Number(candles[1]?.[4]);
    return pct(newest, previous);
  }
  const trend5mPct = candleTrend(intraday5);
  const trend15mPct = candleTrend(intraday15);
  const indiaVix = Number(vixQuote?.last_price ?? vixQuote?.ohlc?.close);

  let futuresBuildUp = 'UNAVAILABLE';
  if (Number.isFinite(futuresPriceChangePct) && Number.isFinite(futuresOIChangePct)) {
    if (futuresPriceChangePct > 0 && futuresOIChangePct > 0) futuresBuildUp = 'LONG_BUILDUP';
    else if (futuresPriceChangePct < 0 && futuresOIChangePct > 0) futuresBuildUp = 'SHORT_BUILDUP';
    else if (futuresPriceChangePct < 0 && futuresOIChangePct < 0) futuresBuildUp = 'LONG_UNWINDING';
    else if (futuresPriceChangePct > 0 && futuresOIChangePct < 0) futuresBuildUp = 'SHORT_COVERING';
    else futuresBuildUp = 'MIXED';
  }

  return {
    spot,
    sessionOpen: Number(indexOhlc.open) || null,
    sessionHigh: Number(indexOhlc.high) || null,
    sessionLow: Number(indexOhlc.low) || null,
    sessionChangePct,
    trend5mPct,
    trend15mPct,
    trend30mPct,
    indiaVix: Number.isFinite(indiaVix) ? indiaVix : null,
    futures: {
      instrumentKey: future.instrument_key,
      tradingSymbol: future.trading_symbol,
      expiry: future.expiry,
      price: futuresPrice,
      priceChangePct: futuresPriceChangePct,
      oi: Number.isFinite(currentOI) ? currentOI : null,
      previousOI: Number.isFinite(previousOI) ? previousOI : null,
      oiChangePct: futuresOIChangePct,
      buildup: futuresBuildUp
    },
    source: 'UPSTOX_V3'
  };
}

module.exports = { fetchMarketContext, findNearestNiftyFuture };
