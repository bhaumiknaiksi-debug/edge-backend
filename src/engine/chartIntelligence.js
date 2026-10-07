'use strict';

const { normalizeCandles } = require('./setupObservability');

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 3) {
  return Number(Number(v).toFixed(dp));
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

function directionFromCloses(candles) {
  if (!candles || candles.length < 3) return { direction: 'UNAVAILABLE', changePct: null };
  const first = candles[Math.max(0, candles.length - 4)]?.close;
  const last = candles[candles.length - 1]?.close;
  const changePct = pct(last, first);
  if (changePct === null) return { direction: 'UNAVAILABLE', changePct: null };
  return {
    direction: changePct > 0 ? 'UP' : changePct < 0 ? 'DOWN' : 'FLAT',
    changePct: round(changePct)
  };
}

function pivots(candles, radius = 2) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const c = candles[i];
    const left = candles.slice(i - radius, i);
    const right = candles.slice(i + 1, i + 1 + radius);
    if (left.every(x => c.high > x.high) && right.every(x => c.high >= x.high)) highs.push(c);
    if (left.every(x => c.low < x.low) && right.every(x => c.low <= x.low)) lows.push(c);
  }
  return { highs, lows };
}

function structure(candles) {
  const p = pivots(candles);
  if (p.highs.length < 2 || p.lows.length < 2) {
    return { state: 'UNAVAILABLE', lastSwingHigh: null, lastSwingLow: null };
  }
  const h1 = p.highs[p.highs.length - 2], h2 = p.highs[p.highs.length - 1];
  const l1 = p.lows[p.lows.length - 2], l2 = p.lows[p.lows.length - 1];
  const higherHigh = h2.high > h1.high;
  const lowerHigh = h2.high < h1.high;
  const higherLow = l2.low > l1.low;
  const lowerLow = l2.low < l1.low;
  const state = higherHigh && higherLow ? 'BULLISH' :
    lowerHigh && lowerLow ? 'BEARISH' : 'MIXED';
  return {
    state,
    lastSwingHigh: round(h2.high),
    previousSwingHigh: round(h1.high),
    lastSwingLow: round(l2.low),
    previousSwingLow: round(l1.low)
  };
}

function levelState(candles, lookback = 12) {
  if (!candles || candles.length < 3) {
    return { state: 'UNAVAILABLE', priorHigh: null, priorLow: null, close: null };
  }
  const last = candles[candles.length - 1];
  const prior = candles.slice(Math.max(0, candles.length - lookback - 1), -1);
  if (!prior.length) return { state: 'UNAVAILABLE', priorHigh: null, priorLow: null, close: round(last.close) };
  const priorHigh = Math.max(...prior.map(c => c.high));
  const priorLow = Math.min(...prior.map(c => c.low));
  const state = last.close > priorHigh ? 'BREAKOUT_ABOVE' :
    last.close < priorLow ? 'BREAKDOWN_BELOW' : 'INSIDE_PRIOR_RANGE';
  return { state, priorHigh: round(priorHigh), priorLow: round(priorLow), close: round(last.close) };
}

function candlePressure(candles) {
  if (!candles || candles.length < 4) return { state: 'UNAVAILABLE' };
  const recent = candles.slice(-3);
  const bullishCloses = recent.filter(c => c.close > c.open).length;
  const bearishCloses = recent.filter(c => c.close < c.open).length;
  const recentRange = recent.reduce((a, c) => a + (c.high - c.low), 0) / recent.length;
  const baselineRows = candles.slice(Math.max(0, candles.length - 13), -3);
  const baselineRange = baselineRows.length
    ? baselineRows.reduce((a, c) => a + (c.high - c.low), 0) / baselineRows.length
    : null;
  const expansionRatio = baselineRange && baselineRange > 0 ? recentRange / baselineRange : null;
  const state = bullishCloses >= 2 ? 'BUYING_PRESSURE' : bearishCloses >= 2 ? 'SELLING_PRESSURE' : 'MIXED';
  return {
    state,
    bullishCloses,
    bearishCloses,
    rangeExpansionRatio: expansionRatio === null ? null : round(expansionRatio, 2)
  };
}

function vwapRead(setupFeatures) {
  const v = setupFeatures?.vwap;
  const distance = n(v?.distancePct);
  const slope = n(v?.slope);
  if (!v?.available || distance === null) {
    return { available: false, side: 'UNAVAILABLE', slope: 'UNAVAILABLE', distancePct: null };
  }
  return {
    available: true,
    side: distance > 0 ? 'ABOVE' : distance < 0 ? 'BELOW' : 'AT',
    slope: slope === null ? 'UNAVAILABLE' : slope > 0 ? 'RISING' : slope < 0 ? 'FALLING' : 'FLAT',
    distancePct: round(distance),
    value: n(v.value)
  };
}

function participation(setupFeatures) {
  const rvol = n(setupFeatures?.volume?.relativeVolume);
  if (rvol === null) return { state: 'UNAVAILABLE', relativeVolume: null };
  return {
    state: rvol >= 1 ? 'ABOVE_RECENT_AVERAGE' : 'BELOW_RECENT_AVERAGE',
    relativeVolume: round(rvol, 2)
  };
}

function buildStory({ verdict, structure5m, structure15m, levels, vwap, pressure, participation: part }) {
  const story = [];
  if (structure5m.state === 'BULLISH') story.push('5-minute price structure is making higher swing highs and higher swing lows.');
  else if (structure5m.state === 'BEARISH') story.push('5-minute price structure is making lower swing highs and lower swing lows.');
  if (structure15m.state === 'BULLISH') story.push('15-minute structure also leans bullish.');
  else if (structure15m.state === 'BEARISH') story.push('15-minute structure also leans bearish.');
  if (levels.state === 'BREAKOUT_ABOVE') story.push('Price has closed above its recent intraday range.');
  else if (levels.state === 'BREAKDOWN_BELOW') story.push('Price has closed below its recent intraday range.');
  if (vwap.side === 'ABOVE' && vwap.slope === 'RISING') story.push('Price is above a rising futures-VWAP proxy.');
  else if (vwap.side === 'BELOW' && vwap.slope === 'FALLING') story.push('Price is below a falling futures-VWAP proxy.');
  if (pressure.state === 'BUYING_PRESSURE') story.push('Recent candles show buying pressure.');
  else if (pressure.state === 'SELLING_PRESSURE') story.push('Recent candles show selling pressure.');
  if (part.state === 'ABOVE_RECENT_AVERAGE') story.push('Futures participation is above its recent intraday average.');
  if (!story.length) story.push('Chart structure is mixed or does not yet provide enough clean confirmation.');
  return {
    headline: verdict === 'BULLISH' ? 'Chart structure leans bullish.' :
      verdict === 'BEARISH' ? 'Chart structure leans bearish.' :
      verdict === 'CONFLICTED' ? 'Chart signals disagree.' :
      verdict === 'NEUTRAL' ? 'Chart structure is balanced.' : 'Chart structure is not yet available.',
    points: story.slice(0, 5)
  };
}

function buildChartIntelligence({ index5m = [], index15m = [], setupFeatures = null } = {}) {
  const five = normalizeCandles(index5m);
  const fifteen = normalizeCandles(index15m);
  const structure5m = structure(five);
  const structure15m = structure(fifteen);
  const trend5m = directionFromCloses(five);
  const trend15m = directionFromCloses(fifteen);
  const levels = levelState(five);
  const vwap = vwapRead(setupFeatures);
  const pressure = candlePressure(five);
  const part = participation(setupFeatures);

  const votes = [];
  const vote = (label, dir) => { if (dir === 'BULLISH' || dir === 'BEARISH') votes.push({ label, direction: dir }); };
  vote('5m structure', structure5m.state);
  vote('15m structure', structure15m.state);
  vote('5m trend', trend5m.direction === 'UP' ? 'BULLISH' : trend5m.direction === 'DOWN' ? 'BEARISH' : null);
  vote('15m trend', trend15m.direction === 'UP' ? 'BULLISH' : trend15m.direction === 'DOWN' ? 'BEARISH' : null);
  vote('range break', levels.state === 'BREAKOUT_ABOVE' ? 'BULLISH' : levels.state === 'BREAKDOWN_BELOW' ? 'BEARISH' : null);
  if (vwap.side === 'ABOVE' && vwap.slope === 'RISING') vote('VWAP', 'BULLISH');
  if (vwap.side === 'BELOW' && vwap.slope === 'FALLING') vote('VWAP', 'BEARISH');
  vote('candle pressure', pressure.state === 'BUYING_PRESSURE' ? 'BULLISH' : pressure.state === 'SELLING_PRESSURE' ? 'BEARISH' : null);

  const bullishVotes = votes.filter(v => v.direction === 'BULLISH').length;
  const bearishVotes = votes.filter(v => v.direction === 'BEARISH').length;
  let verdict = 'UNAVAILABLE';
  if (votes.length) {
    if (bullishVotes && bearishVotes && Math.abs(bullishVotes - bearishVotes) <= 1) verdict = 'CONFLICTED';
    else if (bullishVotes > bearishVotes) verdict = 'BULLISH';
    else if (bearishVotes > bullishVotes) verdict = 'BEARISH';
    else verdict = 'NEUTRAL';
  }

  const result = {
    version: 'CHART_INTELLIGENCE_V1',
    researchOnly: true,
    liveDecisionImpact: false,
    methodology: 'Deterministic OHLCV structure analysis; descriptive research evidence, not a probability of profit.',
    verdict,
    bullishVotes,
    bearishVotes,
    evidenceCount: votes.length,
    structure: { fiveMinute: structure5m, fifteenMinute: structure15m },
    trend: { fiveMinute: trend5m, fifteenMinute: trend15m },
    levels,
    vwap,
    momentum: pressure,
    participation: part,
    votes
  };
  result.story = buildStory({ verdict, structure5m, structure15m, levels, vwap, pressure, participation: part });
  return result;
}

module.exports = { buildChartIntelligence, structure, levelState, candlePressure };
