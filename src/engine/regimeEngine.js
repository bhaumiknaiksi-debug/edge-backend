'use strict';

/**
 * Regime engine.
 * Direction comes from price/positioning evidence. IV is intentionally excluded
 * from directional scoring; volatility belongs to strategy expression.
 */
function classifyRegime(features) {
  const factors = [];

  // PCR is treated as positioning, not a standalone trade signal.
  const pcrScore = Math.max(-25, Math.min(25, (features.pcr - 1) * 50));
  factors.push({ key: 'PCR_POSITIONING', label: 'PCR positioning', score: pcrScore, available: true });

  // Price vs max pain is deliberately low weight outside expiry context.
  let maxPainScore = 0;
  if (Number.isFinite(features.priceVsMaxPainPct)) {
    const x = features.priceVsMaxPainPct;
    maxPainScore = x > 1 ? 12 : x > 0 ? 5 : x > -1 ? -5 : -12;
  }
  factors.push({ key: 'PRICE_MAX_PAIN', label: 'Price vs max pain', score: maxPainScore, available: Number.isFinite(features.priceVsMaxPainPct) });

  // Net nearby OI change: relative rather than raw absolute thresholds.
  const oiDen = Math.abs(features.ceOIChange) + Math.abs(features.peOIChange);
  const oiImbalance = oiDen ? (features.peOIChange - features.ceOIChange) / oiDen : 0;
  const oiScore = Math.round(oiImbalance * 20);
  factors.push({ key: 'OI_CHANGE', label: 'Nearby OI change', score: oiScore, available: oiDen > 0 });

  // Session trend: price direction is a first-class regime input.
  if (Number.isFinite(features.sessionChangePct)) {
    const s = Math.max(-25, Math.min(25, features.sessionChangePct * 15));
    factors.push({ key: 'SESSION_PRICE', label: 'Session price trend', score: s, available: true });
  } else factors.push({ key: 'SESSION_PRICE', label: 'Session price trend', score: 0, available: false });

  // 30-minute structure adds intraday confirmation without pretending it is a full TA engine.
  if (Number.isFinite(features.trend30mPct)) {
    const t = Math.max(-20, Math.min(20, features.trend30mPct * 20));
    factors.push({ key: 'TREND_30M', label: '30m price trend', score: t, available: true });
  } else factors.push({ key: 'TREND_30M', label: '30m price trend', score: 0, available: false });

  // Option flow is an inferred positioning input: OI + premium movement, not OI alone.
  const flowScore = Number(features.optionFlow?.aggregate?.score);
  const flowAvailable = Number.isFinite(flowScore) && (features.optionFlow?.aggregate?.classifiedContracts || 0) > 0;
  factors.push({
    key: 'OPTION_FLOW',
    label: features.optionFlow?.aggregate?.label || 'Option flow',
    score: flowAvailable ? Math.max(-25, Math.min(25, flowScore)) : 0,
    available: flowAvailable
  });

  // Futures price/OI relationship is a first-class positioning regime input.
  if (Number.isFinite(features.futuresPriceChangePct) && Number.isFinite(features.futuresOIChangePct)) {
    const p = features.futuresPriceChangePct;
    const o = features.futuresOIChangePct;
    let s = 0, build = 'MIXED';
    if (p > 0 && o > 0) { s = 25; build = 'LONG_BUILDUP'; }
    else if (p < 0 && o > 0) { s = -25; build = 'SHORT_BUILDUP'; }
    else if (p < 0 && o < 0) { s = -12; build = 'LONG_UNWINDING'; }
    else if (p > 0 && o < 0) { s = 12; build = 'SHORT_COVERING'; }
    factors.push({ key: 'FUTURES_BUILDUP', label: 'Futures ' + build, score: s, available: true });
  } else factors.push({ key: 'FUTURES_BUILDUP', label: 'Futures build-up', score: 0, available: false });

  const available = factors.filter(f => f.available);
  const rawScore = Math.round(available.reduce((n,f) => n + f.score, 0));
  const directional = available.filter(f => Math.abs(f.score) >= 3);
  const aligned = directional.length >= 2 && directional.every(f => Math.sign(f.score) === Math.sign(rawScore));
  const disagreement = directional.filter(f => Math.sign(f.score) !== Math.sign(rawScore || 1)).length;

  // Confidence describes evidence quality + agreement, not certainty of profit.
  const coverage = available.length / factors.length;
  let confidence = Math.abs(rawScore) + Math.round(coverage * 20);
  if (aligned) confidence += 12;
  if (disagreement) confidence -= disagreement * 8;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  let direction, label;
  if (rawScore >= 45) { direction='STRONG_BULLISH'; label='Strong Bullish'; }
  else if (rawScore >= 25) { direction='BULLISH'; label='Bullish'; }
  else if (rawScore >= 10) { direction='MILD_BULLISH'; label='Mild Bullish'; }
  else if (rawScore > -10) { direction='NEUTRAL'; label='Neutral'; }
  else if (rawScore > -25) { direction='MILD_BEARISH'; label='Mild Bearish'; }
  else if (rawScore > -45) { direction='BEARISH'; label='Bearish'; }
  else { direction='STRONG_BEARISH'; label='Strong Bearish'; }

  return {
    direction, label, score: rawScore, confidence,
    factors,
    evidenceCoverage: Math.round(coverage * 100),
    missing: factors.filter(f => !f.available).map(f => f.key)
  };
}

module.exports = { classifyRegime };
