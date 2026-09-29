'use strict';

/**
 * Setup Scanner V1
 *
 * Research observer only. It describes candidate price/volume setups from
 * already-collected market observations. It MUST NOT qualify, block, rank,
 * size, or otherwise alter a live trade.
 */

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function candidate(type, direction, state, evidence, missing = []) {
  return {
    type,
    direction,
    state,
    observed: state !== 'UNAVAILABLE',
    evidence,
    missing
  };
}

function scanSetups({ setupFeatures = null, trend5mPct = null, trend15mPct = null, trend30mPct = null } = {}) {
  const sf = setupFeatures || {};
  const or = sf.openingRange || {};
  const vw = sf.vwap || {};
  const rv = finite(sf.volume?.relativeVolume ?? vw.relativeVolume);
  const vwapDistance = finite(vw.distancePct);
  const vwapSlope = finite(vw.slope);
  const t5 = finite(trend5mPct);
  const t15 = finite(trend15mPct);
  const t30 = finite(trend30mPct);

  const candidates = [];

  if (!or.available || !['ABOVE','BELOW','INSIDE'].includes(or.position)) {
    candidates.push(candidate('OPENING_RANGE_BREAK', 'UNKNOWN', 'UNAVAILABLE', {}, ['OPENING_RANGE']));
  } else {
    const direction = or.position === 'ABOVE' ? 'BULLISH' : or.position === 'BELOW' ? 'BEARISH' : 'NEUTRAL';
    candidates.push(candidate('OPENING_RANGE_BREAK', direction, or.position === 'INSIDE' ? 'INSIDE_RANGE' : 'OUTSIDE_RANGE', {
      position: or.position, high: finite(or.high), low: finite(or.low), width: finite(or.width)
    }));
  }

  if (vwapDistance === null || vwapSlope === null) {
    candidates.push(candidate('VWAP_CONTINUATION', 'UNKNOWN', 'UNAVAILABLE', {}, ['VWAP']));
    candidates.push(candidate('VWAP_PULLBACK', 'UNKNOWN', 'UNAVAILABLE', {}, ['VWAP']));
  } else {
    const side = vwapDistance > 0 ? 'ABOVE' : vwapDistance < 0 ? 'BELOW' : 'AT';
    const slope = vwapSlope > 0 ? 'RISING' : vwapSlope < 0 ? 'FALLING' : 'FLAT';
    const continuationDirection = side === 'ABOVE' && slope === 'RISING' ? 'BULLISH'
      : side === 'BELOW' && slope === 'FALLING' ? 'BEARISH' : 'NEUTRAL';
    candidates.push(candidate('VWAP_CONTINUATION', continuationDirection,
      continuationDirection === 'NEUTRAL' ? 'NOT_ALIGNED' : 'ALIGNED', {
        side, slope, distancePct: vwapDistance, slopePct: vwapSlope, relativeVolume: rv
      }));

    // "Near" is deliberately descriptive, not a trading threshold. We expose
    // raw distance and a coarse observation bin for later outcome research.
    const distanceAbs = Math.abs(vwapDistance);
    const proximity = distanceAbs <= 0.1 ? 'NEAR' : distanceAbs <= 0.3 ? 'MODERATE' : 'FAR';
    const pullbackDirection = side === 'ABOVE' && slope !== 'FALLING' ? 'BULLISH'
      : side === 'BELOW' && slope !== 'RISING' ? 'BEARISH' : 'NEUTRAL';
    candidates.push(candidate('VWAP_PULLBACK', pullbackDirection, proximity, {
      side, slope, distancePct: vwapDistance, proximity
    }));
  }

  if (t5 === null || t15 === null) {
    candidates.push(candidate('MULTI_TIMEFRAME_MOMENTUM', 'UNKNOWN', 'UNAVAILABLE', {}, ['TREND_5M_OR_15M']));
  } else {
    const direction = t5 > 0 && t15 > 0 && (t30 === null || t30 >= 0) ? 'BULLISH'
      : t5 < 0 && t15 < 0 && (t30 === null || t30 <= 0) ? 'BEARISH' : 'NEUTRAL';
    candidates.push(candidate('MULTI_TIMEFRAME_MOMENTUM', direction,
      direction === 'NEUTRAL' ? 'MIXED' : 'ALIGNED', {
        trend5mPct: t5, trend15mPct: t15, trend30mPct: t30, relativeVolume: rv
      }));
  }

  const observed = candidates.filter(x => x.observed);
  return {
    version: 'SETUP_SCANNER_V1',
    researchOnly: true,
    liveDecisionImpact: false,
    generatedAt: new Date().toISOString(),
    candidates,
    summary: {
      observed: observed.length,
      unavailable: candidates.length - observed.length,
      bullish: observed.filter(x => x.direction === 'BULLISH').length,
      bearish: observed.filter(x => x.direction === 'BEARISH').length,
      neutral: observed.filter(x => x.direction === 'NEUTRAL').length
    },
    methodology: {
      purpose: 'Observe candidate setup states for outcome research; not a trade trigger.',
      thresholds: 'Bins are descriptive labels only and are not validated entry rules.',
      volumeSource: 'Nearest NIFTY future proxy when available.'
    }
  };
}

module.exports = { scanSetups };
