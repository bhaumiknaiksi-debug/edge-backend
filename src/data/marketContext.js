'use strict';

const https = require('https');
const { buildSetupObservability } = require('../engine/setupObservability');
const { buildChartIntelligence } = require('../engine/chartIntelligence');

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

function expiryIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || /^\d{12,}$/.test(String(value))) {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : null;
}

function istDateString(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const get = type => parts.find(p => p.type === type)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function selectNearestNiftyFuture(rows = [], now = Date.now()) {
  const today = istDateString(now);
  return (rows || [])
    .filter(x => {
      if (!x || x.instrument_type !== 'FUT' || x.segment !== 'NSE_FO') return false;
      const expiry = expiryIso(x.expiry);
      if (!expiry || expiry < today) return false;
      const underlying = String(x.underlying_symbol || '').toUpperCase();
      const name = String(x.name || '').toUpperCase();
      const symbol = String(x.trading_symbol || '').toUpperCase();
      return underlying === 'NIFTY' || name === 'NIFTY 50' || symbol.startsWith('NIFTY FUT ');
    })
    .sort((a, b) => String(expiryIso(a.expiry)).localeCompare(String(expiryIso(b.expiry))))[0] || null;
}

async function searchNiftyFutures(query) {
  // After monthly expiry, a single near_month keyword can temporarily return
  // no contract. Ask for the current + next two monthly buckets together.
  const q = new URLSearchParams({
    query,
    exchanges: 'NSE',
    segments: 'FO',
    instrument_types: 'FUT',
    expiry: 'current_month,next_month,far_month',
    page_number: '1',
    records: '30'
  });
  const parsed = await requestJson('/v2/instruments/search?' + q.toString());
  return parsed.data || [];
}

async function findNearestNiftyFuture() {
  const now = Date.now();
  if (cachedFuture && now - cachedAt < CACHE_MS) return cachedFuture;

  let rows = await searchNiftyFutures('NIFTY');
  let selected = selectNearestNiftyFuture(rows, now);
  if (!selected) {
    // Free-text matching can vary; the explicit futures phrase is a safe fallback.
    const fallback = await searchNiftyFutures('NIFTY FUT');
    rows = rows.concat(fallback);
    selected = selectNearestNiftyFuture(rows, now);
  }

  if (!selected) throw new Error('No active NIFTY futures contract found after current/next/far-month search');
  console.log('[market context] NIFTY future selected:', selected.trading_symbol || selected.instrument_key, expiryIso(selected.expiry));
  cachedFuture = selected;
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

  const [quote, thirty, intraday5, intraday15, futureIntraday5] = await Promise.all([
    requestJson('/v3/market-quote/quotes?instrument_key=' + encodeURIComponent(keys)),
    requestJson('/v3/market-quote/ohlc?instrument_key=' + encodeURIComponent(INDEX_KEY) + '&interval=I30'),
    requestJson('/v3/historical-candle/intraday/' + encodeURIComponent(INDEX_KEY) + '/minutes/5').catch(() => ({data:{candles:[]}})),
    requestJson('/v3/historical-candle/intraday/' + encodeURIComponent(INDEX_KEY) + '/minutes/15').catch(() => ({data:{candles:[]}})),
    requestJson('/v3/historical-candle/intraday/' + encodeURIComponent(future.instrument_key) + '/minutes/5').catch(() => ({data:{candles:[]}}))
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
  const setupFeatures = buildSetupObservability({
    index5m: intraday5?.data?.candles || [],
    future5m: futureIntraday5?.data?.candles || []
  });

  // Research-only deterministic chart reading. This is descriptive evidence
  // and does not affect live regime, strategy, setup, or execution gates.
  const chartIntelligence = buildChartIntelligence({
    index5m: intraday5?.data?.candles || [],
    index15m: intraday15?.data?.candles || [],
    setupFeatures
  });

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
    setupFeatures,
    chartIntelligence,
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

module.exports = { fetchMarketContext, findNearestNiftyFuture, selectNearestNiftyFuture, expiryIso, istDateString };
