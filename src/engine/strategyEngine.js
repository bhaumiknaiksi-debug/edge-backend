'use strict';

/**
 * Strategy candidate layer.
 * Direction is only one dimension. The selected strategy remains restricted
 * to structures that the execution/risk engines fully support today.
 * candidates exposes the broader defined-risk set for progressive qualification.
 */
function selectStrategy(regime, ivRegime) {
  const d = regime?.direction || 'NEUTRAL';
  const strongBull = d === 'STRONG_BULLISH' || d === 'BULLISH';
  const mildBull = d === 'MILD_BULLISH';
  const strongBear = d === 'STRONG_BEARISH' || d === 'BEARISH';
  const mildBear = d === 'MILD_BEARISH';

  if (strongBull || mildBull) {
    const candidates = ivRegime === 'HIGH'
      ? ['BULL_PUT_SPREAD', 'BULL_CALL_SPREAD', 'WAIT']
      : ['BULL_CALL_SPREAD', 'LONG_CALL', 'WAIT'];
    const name = ivRegime === 'HIGH' ? 'BULL_PUT_SPREAD' : 'LONG_CALL';
    return {
      name, candidates,
      reason: ivRegime === 'HIGH'
        ? 'Bullish regime + elevated IV; defined-risk credit spread is currently executable.'
        : 'Bullish regime + low/normal IV; long call is currently executable while debit-spread qualification is pending.'
    };
  }

  if (strongBear || mildBear) {
    const candidates = ivRegime === 'HIGH'
      ? ['BEAR_CALL_SPREAD', 'BEAR_PUT_SPREAD', 'WAIT']
      : ['BEAR_PUT_SPREAD', 'LONG_PUT', 'WAIT'];
    const name = ivRegime === 'HIGH' ? 'BEAR_CALL_SPREAD' : 'LONG_PUT';
    return {
      name, candidates,
      reason: ivRegime === 'HIGH'
        ? 'Bearish regime + elevated IV; defined-risk credit spread is currently executable.'
        : 'Bearish regime + low/normal IV; long put is currently executable while debit-spread qualification is pending.'
    };
  }

  if (ivRegime === 'HIGH') {
    return {
      name: 'IRON_CONDOR',
      candidates: ['IRON_CONDOR', 'IRON_BUTTERFLY', 'WAIT'],
      reason: 'Neutral regime + elevated IV; range structures are candidates and neutral direction is the thesis, not a blocker.'
    };
  }

  return {
    name: 'WAIT',
    candidates: ivRegime === 'LOW' ? ['LONG_STRADDLE', 'LONG_STRANGLE', 'WAIT'] : ['WAIT'],
    reason: 'Neutral regime without a qualified volatility-expansion model; stand aside.'
  };
}

module.exports = { selectStrategy };
