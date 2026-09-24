'use strict';

/**
 * Strategy expression layer.
 * Direction comes from the regime engine. IV only changes how the view is expressed.
 */
function selectStrategy(regime, ivRegime) {
  const d = regime?.direction || 'NEUTRAL';
  if (d === 'STRONG_BULLISH' || d === 'BULLISH' || d === 'MILD_BULLISH') {
    return ivRegime === 'HIGH'
      ? { name: 'BULL_PUT_SPREAD', reason: 'Bullish regime + elevated IV; defined-risk credit expression.' }
      : { name: 'LONG_CALL', reason: 'Bullish regime + low/normal IV; directional debit expression.' };
  }
  if (d === 'STRONG_BEARISH' || d === 'BEARISH' || d === 'MILD_BEARISH') {
    return ivRegime === 'HIGH'
      ? { name: 'BEAR_CALL_SPREAD', reason: 'Bearish regime + elevated IV; defined-risk credit expression.' }
      : { name: 'LONG_PUT', reason: 'Bearish regime + low/normal IV; directional debit expression.' };
  }
  return ivRegime === 'HIGH'
    ? { name: 'IRON_CONDOR', reason: 'Neutral regime + elevated IV; defined-risk range expression, subject to setup qualification.' }
    : { name: 'WAIT', reason: 'Neutral regime without elevated IV; no defined setup.' };
}

module.exports = { selectStrategy };
