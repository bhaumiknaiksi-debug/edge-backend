'use strict';

/**
 * Volatility intelligence.
 * Descriptive only: compares option-chain IV, India VIX, ATM skew and the
 * market-priced ATM straddle move. It does not infer an IV percentile/rank
 * without historical IV observations.
 */
function n(v){ const x=Number(v); return Number.isFinite(x)?x:null; }
function round(v,dp=2){ return Number(v.toFixed(dp)); }

function buildVolatilityContext({ avgIV, atm, spot, dte, indiaVix, expectedMovePoints }) {
  const iv=n(avgIV), vix=n(indiaVix), s=n(spot), days=Math.max(1,n(dte) ?? 1);
  const ceIV=n(atm?.ceIV), peIV=n(atm?.peIV), move=n(expectedMovePoints);
  const skew = ceIV!==null && peIV!==null ? peIV-ceIV : null;
  const ivVixSpread = iv!==null && vix!==null ? iv-vix : null;
  const straddleMovePct = move!==null && s ? move/s*100 : null;
  const vixMovePct = vix!==null ? vix/Math.sqrt(365)*Math.sqrt(days) : null;
  const moveRatio = straddleMovePct!==null && vixMovePct ? straddleMovePct/vixMovePct : null;

  let richness='UNAVAILABLE';
  if (ivVixSpread!==null || moveRatio!==null) {
    const score=(ivVixSpread===null?0:ivVixSpread)+(moveRatio===null?0:(moveRatio-1)*10);
    richness=score>=4?'RICH':score<=-4?'CHEAP':'FAIR';
  }

  let skewLabel='UNAVAILABLE';
  if (skew!==null) skewLabel=skew>=2?'PUT_RICH':skew<=-2?'CALL_RICH':'BALANCED';

  return {
    nearAtmIV: iv, ivBasis:'NEAR_ATM_MEDIAN_PM2', indiaVix:vix, ivVixSpread:ivVixSpread===null?null:round(ivVixSpread),
    atmSkew:skew===null?null:round(skew), skewLabel,
    straddleMovePct:straddleMovePct===null?null:round(straddleMovePct),
    vixExpectedMovePct:vixMovePct===null?null:round(vixMovePct),
    pricedMoveRatio:moveRatio===null?null:round(moveRatio),
    richness,
    ivRank:null,
    ivRankStatus:'UNAVAILABLE_WITHOUT_HISTORICAL_IV_SERIES',
    note:'Richness compares robust near-ATM IV and priced move with India VIX; it is not IV rank or a forecast.'
  };
}
module.exports={buildVolatilityContext};
