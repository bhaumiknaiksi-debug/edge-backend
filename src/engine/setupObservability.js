'use strict';

/**
 * Setup-observability features.
 *
 * These are descriptive measurements only. They MUST NOT change regime,
 * strategy, or execution eligibility until EDGE has enough outcome evidence.
 *
 * NIFTY index has no directly traded volume, so VWAP/relative-volume use the
 * nearest NIFTY future as an explicitly labelled proxy. ATR/opening range use
 * NIFTY index candles.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(Number(v).toFixed(dp));
}

function normalizeCandles(raw) {
  return (raw || []).map(row => {
    if (!Array.isArray(row) || row.length < 5) return null;
    const timestamp = row[0];
    const time = new Date(timestamp).getTime();
    const open = n(row[1]), high = n(row[2]), low = n(row[3]), close = n(row[4]);
    const volume = n(row[5]);
    if (!Number.isFinite(time) || [open, high, low, close].some(x => x === null)) return null;
    return { timestamp, time, open, high, low, close, volume };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function istMinutes(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const h = Number(parts.find(p => p.type === 'hour')?.value);
  const m = Number(parts.find(p => p.type === 'minute')?.value);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const sample = trs.slice(-period);
  return sample.length === period ? sample.reduce((a, b) => a + b, 0) / period : null;
}

function openingRange(candles) {
  const rows = (candles || []).filter(c => {
    const mins = istMinutes(c.timestamp);
    return mins !== null && mins >= 555 && mins < 570; // 09:15 <= t < 09:30 IST
  });
  if (!rows.length) return { available: false, high: null, low: null, width: null, position: 'UNAVAILABLE' };
  const high = Math.max(...rows.map(c => c.high));
  const low = Math.min(...rows.map(c => c.low));
  const last = candles[candles.length - 1]?.close;
  const position = !Number.isFinite(last) ? 'UNAVAILABLE' : last > high ? 'ABOVE' : last < low ? 'BELOW' : 'INSIDE';
  return { available: true, high: round(high), low: round(low), width: round(high - low), position };
}

function futuresVwap(candles) {
  const rows = (candles || []).filter(c => Number.isFinite(c.volume) && c.volume > 0);
  if (!rows.length) return { available: false, value: null, distancePct: null, slope: null, relativeVolume: null };

  let pv = 0, volume = 0;
  const series = [];
  for (const c of rows) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    volume += c.volume;
    series.push(volume > 0 ? pv / volume : null);
  }

  const value = series[series.length - 1];
  const close = rows[rows.length - 1].close;
  const lookback = Math.min(5, series.length - 1);
  const prior = lookback > 0 ? series[series.length - 1 - lookback] : null;
  const slope = Number.isFinite(prior) && prior !== 0 ? ((value - prior) / prior) * 100 : null;

  const latestVolume = rows[rows.length - 1].volume;
  const priorVolumes = rows.slice(Math.max(0, rows.length - 21), -1).map(c => c.volume).filter(v => v > 0);
  const avgPrior = priorVolumes.length ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : null;
  const relativeVolume = avgPrior && avgPrior > 0 ? latestVolume / avgPrior : null;

  return {
    available: true,
    value: round(value),
    distancePct: value ? round(((close - value) / value) * 100, 3) : null,
    slope: slope === null ? null : round(slope, 4),
    relativeVolume: relativeVolume === null ? null : round(relativeVolume, 2)
  };
}

function buildSetupObservability({ index5m = [], future5m = [] } = {}) {
  const index = normalizeCandles(index5m);
  const future = normalizeCandles(future5m);
  const atr5m14 = atr(index, 14);
  const or = openingRange(index);
  const vwap = futuresVwap(future);

  return {
    version: 'SETUP_OBSERVABILITY_V1',
    researchOnly: true,
    liveDecisionImpact: false,
    atr: {
      timeframe: '5m',
      period: 14,
      value: atr5m14 === null ? null : round(atr5m14),
      source: 'NIFTY_INDEX'
    },
    openingRange: {
      ...or,
      window: '09:15-09:30_IST',
      source: 'NIFTY_INDEX'
    },
    vwap: {
      ...vwap,
      source: 'NEAREST_NIFTY_FUTURE',
      proxyForSpot: true
    },
    volume: {
      relativeVolume: vwap.relativeVolume,
      source: 'NEAREST_NIFTY_FUTURE',
      proxyForSpot: true
    },
    dataCoverage: {
      index5mCandles: index.length,
      future5mCandles: future.length,
      atrAvailable: atr5m14 !== null,
      openingRangeAvailable: or.available,
      futuresVwapAvailable: vwap.available
    }
  };
}

module.exports = { normalizeCandles, atr, openingRange, futuresVwap, buildSetupObservability };
