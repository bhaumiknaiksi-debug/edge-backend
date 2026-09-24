'use strict';

/**
 * EDGE market feature engine.
 * Pure transformation layer: no strategy selection and no trade recommendation.
 * Missing inputs stay null rather than being invented.
 */
function buildMarketFeatures(input) {
  const {
    spot, strikes, maxPain, avgIV, ivRegime, atmIndex, windowSize = 7,
    sessionChangePct = null, trend30mPct = null, futures = null, optionFlow = null
  } = input;
  if (!spot || !Array.isArray(strikes) || !strikes.length) throw new Error('Invalid market feature input');

  const lo = Math.max(0, atmIndex - windowSize);
  const hi = Math.min(strikes.length - 1, atmIndex + windowSize);
  const window = strikes.slice(lo, hi + 1);

  const sum = (arr, key) => arr.reduce((n, x) => n + (Number(x[key]) || 0), 0);
  const ceOI = sum(window, 'ceOI');
  const peOI = sum(window, 'peOI');
  const ceOIChange = window.reduce((n, x) => n + (Number(x.ceOIChange) || 0), 0);
  const peOIChange = window.reduce((n, x) => n + (Number(x.peOIChange) || 0), 0);

  const pcr = peOI / (ceOI || 1);
  const pcrChangeRatio = peOIChange / (Math.abs(ceOIChange) || 1);
  const priceVsMaxPainPct = maxPain ? ((spot - maxPain) / maxPain) * 100 : null;

  const ceWallRow = window.filter(x => x.strike >= spot).sort((a,b) => b.ceOI - a.ceOI)[0] || null;
  const peWallRow = window.filter(x => x.strike <= spot).sort((a,b) => b.peOI - a.peOI)[0] || null;

  return {
    spot,
    sessionChangePct,
    trend30mPct,
    futuresPriceChangePct: futures?.priceChangePct ?? null,
    futuresOIChangePct: futures?.oiChangePct ?? null,
    futuresBuildUp: futures?.buildup || 'UNAVAILABLE',
    optionFlow: optionFlow || { aggregate: { score: 0, label: 'UNAVAILABLE', classifiedContracts: 0 } },
    pcr,
    pcrChangeRatio,
    ceOI,
    peOI,
    ceOIChange,
    peOIChange,
    priceVsMaxPainPct,
    maxPain,
    avgIV,
    ivRegime,
    ceWall: ceWallRow ? ceWallRow.strike : null,
    peWall: peWallRow ? peWallRow.strike : null,
    dataCompleteness: {
      optionChain: true,
      priceTrend: Number.isFinite(sessionChangePct) || Number.isFinite(trend30mPct),
      futures: !!futures && Number.isFinite(futures.priceChangePct) && Number.isFinite(futures.oiChangePct)
    }
  };
}

module.exports = { buildMarketFeatures };
