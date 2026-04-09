function rankAlphaStrikes(chain) {
  return chain.strikes
    .map(function (row) {
      var prox = 1 / (1 + Math.abs(row.strike - chain.spot) / 100);
      return {
        strike: row.strike,
        totalScore: Math.round((row.ce.oi + row.pe.oi) * prox),
        dominant: row.ce.oi > row.pe.oi ? "CE" : "PE",
        ceOI: row.ce.oi,
        peOI: row.pe.oi,
        ceLTP: row.ce.ltp,
        peLTP: row.pe.ltp,
      };
    })
    .sort(function (a, b) {
      return b.totalScore - a.totalScore;
    })
    .slice(0, 3)
    .map(function (r, i) {
      return Object.assign({ rank: i + 1 }, r);
    });
}

// FEATURE 3: Deep strike analysis
function analyseStrike(chain, strikePrice, pcr, sentiment) {
  // Find the exact or nearest strike row
  var row = null;
  var minDist = Infinity;
  chain.strikes.forEach(function (r) {
    var d = Math.abs(r.strike - strikePrice);
    if (d < minDist) {
      minDist = d;
      row = r;
    }
  });

  if (!row) {
    return {
      strike: strikePrice,
      confidence: 0,
      action: "UNAVAILABLE",
      sentiment: "N/A",
      reasoning: "Strike not found in option chain data.",
    };
  }

  var spot = chain.spot;
  var distance = Math.abs(row.strike - spot);
  var distPct = (distance / spot) * 100;
  var isATM = distPct < 0.3;
  var isITM_CE = row.strike < spot;
  var isITM_PE = row.strike > spot;
  var totalOI = row.ce.oi + row.pe.oi;
  var oiRatio = row.pe.oi / (row.ce.oi || 1);
  var volumeTotal = row.ce.volume + row.pe.volume;
  var oiChangeNet = row.pe.oiChange - row.ce.oiChange;

  // Scoring system (0-100)
  var score = 50; // base
  var reasons = [];

  // 1. Proximity to spot (closer = higher conviction)
  if (isATM) {
    score += 15;
    reasons.push("ATM strike — highest gamma and liquidity");
  } else if (distPct < 1) {
    score += 8;
    reasons.push("Near-the-money — good liquidity zone");
  } else if (distPct < 2) {
    score += 2;
    reasons.push("Slightly OTM — moderate risk/reward");
  } else {
    score -= 10;
    reasons.push("Deep OTM (" + distPct.toFixed(1) + "% away) — higher risk");
  }

  // 2. OI concentration
  if (totalOI > 200000) {
    score += 10;
    reasons.push("High OI concentration (" + fmt(totalOI) + ") — strong institutional interest");
  } else if (totalOI > 100000) {
    score += 5;
    reasons.push("Moderate OI — decent participation");
  } else {
    score -= 5;
    reasons.push("Low OI — thin interest, wider spreads likely");
  }

  // 3. OI change momentum
  if (oiChangeNet > 20000) {
    score += 10;
    reasons.push("Strong PE OI buildup — bullish support forming");
  } else if (oiChangeNet < -20000) {
    score -= 5;
    reasons.push("CE OI buildup dominant — resistance zone");
  } else {
    reasons.push("Balanced OI change — no strong momentum signal");
  }

  // 4. Volume activity
  if (volumeTotal > 300000) {
    score += 8;
    reasons.push("Very high volume — active trading zone");
  } else if (volumeTotal > 150000) {
    score += 4;
    reasons.push("Good volume activity");
  }

  // 5. PCR alignment
  var pcrVal = pcr.overall.oiPCR;
  if (pcrVal > 1.2 && isITM_CE) {
    score += 8;
    reasons.push("Bullish PCR (" + pcrVal + ") favours CE at this strike");
  } else if (pcrVal < 0.8 && isITM_PE) {
    score += 8;
    reasons.push("Bearish PCR (" + pcrVal + ") favours PE at this strike");
  }

  // Clamp score
  score = Math.max(5, Math.min(95, score));

  // Determine action
  var action;
  if (score >= 70) action = "BUY";
  else if (score >= 50) action = "WATCH";
  else action = "AVOID";

  // Determine strike-level sentiment
  var strikeSentiment;
  if (oiRatio > 1.3) strikeSentiment = "BULLISH";
  else if (oiRatio < 0.7) strikeSentiment = "BEARISH";
  else strikeSentiment = "NEUTRAL";

  return {
    strike: row.strike,
    matchedExact: row.strike === strikePrice,
    spot: spot,
    confidence: score,
    action: action,
    sentiment: strikeSentiment,
    marketBias: sentiment.bias,
    ceOI: row.ce.oi,
    peOI: row.pe.oi,
    ceLTP: row.ce.ltp,
    peLTP: row.pe.ltp,
    ceOIChange: row.ce.oiChange,
    peOIChange: row.pe.oiChange,
    reasoning: reasons.join(" • "),
  };
}

function fmt(n) {
  if (n >= 1e7) return (n / 1e7).toFixed(1) + "Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(1) + "L";
  return n.toLocaleString("en-IN");
}

module.exports = { rankAlphaStrikes, analyseStrike };
