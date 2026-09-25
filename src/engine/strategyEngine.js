'use strict';

/**
 * Strategy expression engine.
 * Direction chooses the side; volatility chooses the structure.
 * HIGH/rich -> defined-risk credit, NORMAL/fair -> vertical debit spread,
 * LOW/cheap -> outright long premium. Neutral/high remains a range thesis.
 */
function selectStrategy(regime, ivRegime, volatility = null) {
  const d=regime?.direction || 'NEUTRAL';
  const bull=['STRONG_BULLISH','BULLISH','MILD_BULLISH'].includes(d);
  const bear=['STRONG_BEARISH','BEARISH','MILD_BEARISH'].includes(d);
  const rich=volatility?.richness === 'RICH' || ivRegime === 'HIGH';
  const cheap=volatility?.richness === 'CHEAP' || ivRegime === 'LOW';

  if (bull) {
    if (rich) return {name:'BULL_PUT_SPREAD',candidates:['BULL_PUT_SPREAD','BULL_CALL_SPREAD','WAIT'],reason:'Bullish direction with rich/high volatility; defined-risk credit expression.'};
    if (cheap) return {name:'LONG_CALL',candidates:['LONG_CALL','BULL_CALL_SPREAD','WAIT'],reason:'Bullish direction with cheap/low volatility; outright long premium expression.'};
    return {name:'BULL_CALL_SPREAD',candidates:['BULL_CALL_SPREAD','LONG_CALL','WAIT'],reason:'Bullish direction with fair/normal volatility; defined-risk debit spread limits premium outlay.'};
  }
  if (bear) {
    if (rich) return {name:'BEAR_CALL_SPREAD',candidates:['BEAR_CALL_SPREAD','BEAR_PUT_SPREAD','WAIT'],reason:'Bearish direction with rich/high volatility; defined-risk credit expression.'};
    if (cheap) return {name:'LONG_PUT',candidates:['LONG_PUT','BEAR_PUT_SPREAD','WAIT'],reason:'Bearish direction with cheap/low volatility; outright long premium expression.'};
    return {name:'BEAR_PUT_SPREAD',candidates:['BEAR_PUT_SPREAD','LONG_PUT','WAIT'],reason:'Bearish direction with fair/normal volatility; defined-risk debit spread limits premium outlay.'};
  }
  if (rich) return {name:'IRON_CONDOR',candidates:['IRON_CONDOR','IRON_BUTTERFLY','WAIT'],reason:'Neutral regime with rich/high volatility; defined-risk range expression.'};
  return {name:'WAIT',candidates:cheap?['LONG_STRADDLE','LONG_STRANGLE','WAIT']:['WAIT'],reason:'Neutral regime without a qualified volatility-expansion model; stand aside.'};
}
module.exports={selectStrategy};
