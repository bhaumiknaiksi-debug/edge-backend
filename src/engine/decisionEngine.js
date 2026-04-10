// decisionEngine.js
// Converts PDF theory into real-time trade decisions
// Source: Zerodha Varsity Module 5 & 6

// -- Feature 1: Market Regime Classification --
// Based on: PCR contrarian logic (M6 Ch13), OI writing zones, sentiment
function getMarketRegime(chain, pcr, sentiment) {
  var oiPCR = pcr.overall.oiPCR;
  var score = sentiment.score;
  var spot = chain.spot;

  // Detect OI-based range: heavy writing on both sides = rangebound
  var sr = null;
  try {
    var { findSupportResistance } = require("./oiEngine");
    sr = findSupportResistance(chain);
  } catch(e) {}

  var supportDist = sr ? Math.abs(spot - sr.support.strike) : 999;
  var resistDist  = sr ? Math.abs(sr.resistance.strike - spot) : 999;
  var range = sr ? (sr.resistance.strike - sr.support.strike) : 0;
  var midRange = range > 0 ? range / 2 : 999;

  // Volatility: large OI change spikes = breakout brewing
  var totalOIChange = chain.strikes.reduce(function(sum, r) {
    return sum + Math.abs(r.ce.oiChange) + Math.abs(r.pe.oiChange);
  }, 0);
  var avgOI = (pcr.overall.totalCeOI + pcr.overall.totalPeOI) / chain.strikes.length;
  var volatilityFlag = totalOIChange > avgOI * 0.15;

  // PCR contrarian logic (M6: PCR > 1.3 = oversold/reversal expected bullish)
  // PCR < 0.5 = overbought/reversal expected bearish
  var pcrContrarianBull = oiPCR > 1.3;  // extreme put buying = expect bounce
  var pcrContrarianBear = oiPCR < 0.5;  // extreme call buying = expect decline

  // Regime logic
  if (volatilityFlag && (supportDist < 50 || resistDist < 50)) {
    return { regime: "BREAKOUT SETUP", detail: "Price near S/R with OI shift", volatility: "HIGH" };
  }

  if (pcrContrarianBull && score < 45) {
    return { regime: "TRENDING BULLISH", detail: "Extreme put writing = reversal expected", volatility: volatilityFlag ? "HIGH" : "NORMAL" };
  }

  if (pcrContrarianBear && score > 55) {
    return { regime: "TRENDING BEARISH", detail: "Extreme call writing = reversal expected", volatility: volatilityFlag ? "HIGH" : "NORMAL" };
  }

  if (score >= 60) {
    return { regime: "TRENDING BULLISH", detail: "Strong bullish OI sentiment", volatility: volatilityFlag ? "HIGH" : "NORMAL" };
  }

  if (score <= 40) {
    return { regime: "TRENDING BEARISH", detail: "Strong bearish OI sentiment", volatility: volatilityFlag ? "HIGH" : "NORMAL" };
  }

  if (supportDist < midRange * 0.4 && resistDist < midRange * 0.4) {
    return { regime: "RANGE-BOUND", detail: "Price stuck between S/R walls", volatility: volatilityFlag ? "HIGH" : "LOW" };
  }

  return { regime: "LOW EDGE", detail: "No clear signal - avoid", volatility: volatilityFlag ? "HIGH" : "LOW" };
}

// -- Feature 2: Strategy Mapping --
// Based on: M6 strategy conditions for each strategy
function getStrategySuggestion(regime, chain, pcr, sentiment) {
  var oiPCR = pcr.overall.oiPCR;
  var score = sentiment.score;
  var vol = regime.volatility;

  // High volatility + no direction = straddle/strangle (M6 Ch10/12)
  if (vol === "HIGH" && regime.regime === "BREAKOUT SETUP") {
    return {
      strategy: "Long Straddle",
      type: "VOLATILITY",
      reason: [
        "Large OI shifts detected - breakout imminent",
        "Direction unknown - straddle captures both sides",
        "High volatility favors long premium strategies (M6 Ch10)"
      ],
      expectedOutcome: "Profit if market moves 2%+ either side"
    };
  }

  // Range-bound with low vol = Short Straddle/Iron Condor (M6 Ch11)
  if (regime.regime === "RANGE-BOUND" && vol !== "HIGH") {
    if (score > 45 && score < 55) {
      return {
        strategy: "Short Strangle",
        type: "NEUTRAL",
        reason: [
          "Price rangebound between S/R",
          "Low volatility favors premium selling (M6 Ch12)",
          "PCR neutral - no directional bias",
          "Short strangle profits from time decay"
        ],
        expectedOutcome: "Profit if market stays in range till expiry"
      };
    }
    return {
      strategy: "Iron Condor",
      type: "NEUTRAL",
      reason: [
        "Strong range-bound structure",
        "Defined risk with 4-leg structure",
        "Collect premium on both sides (M6 Ch13)"
      ],
      expectedOutcome: "Profit if market stays within strikes"
    };
  }

  // Moderately bullish = Bull Call Spread (M6 Ch2) or Bull Put Spread (M6 Ch3)
  if (regime.regime === "TRENDING BULLISH") {
    // If PCR is high (put premiums swelled) = Bull Put Spread preferred (net credit)
    if (oiPCR > 1.0) {
      return {
        strategy: "Bull Put Spread",
        type: "BULLISH",
        reason: [
          "Moderately bullish outlook from OI data",
          "High PCR = put premiums swelled = credit spread preferred (M6 Ch3)",
          "Net credit strategy - collect premium upfront",
          "Limited risk if wrong"
        ],
        expectedOutcome: "Max profit if NIFTY stays above sell strike at expiry"
      };
    }
    return {
      strategy: "Bull Call Spread",
      type: "BULLISH",
      reason: [
        "Moderately bullish outlook from OI + sentiment",
        "ATM call buy + OTM call sell reduces cost (M6 Ch2)",
        "Capped profit with defined downside risk",
        "Best when expecting limited upside"
      ],
      expectedOutcome: "Profit if NIFTY moves moderately higher"
    };
  }

  // Moderately bearish = Bear Put Spread or Bear Call Spread (M6 Ch7/8)
  if (regime.regime === "TRENDING BEARISH") {
    // If PCR low (call premiums swelled) = Bear Call Spread preferred (net credit)
    if (oiPCR < 0.8) {
      return {
        strategy: "Bear Call Spread",
        type: "BEARISH",
        reason: [
          "Moderately bearish outlook from OI",
          "Low PCR = call premiums swelled = credit spread preferred (M6 Ch8)",
          "Net credit - collect premium, profit if market stays flat/down",
          "Lower capital requirement vs long put"
        ],
        expectedOutcome: "Max profit if NIFTY stays below sell strike at expiry"
      };
    }
    return {
      strategy: "Bear Put Spread",
      type: "BEARISH",
      reason: [
        "Moderately bearish outlook from OI + sentiment",
        "ITM put buy + OTM put sell (M6 Ch7)",
        "Defined max loss vs naked put",
        "4-5% downside capture with limited risk"
      ],
      expectedOutcome: "Profit if NIFTY moves moderately lower"
    };
  }

  return {
    strategy: "WAIT - NO TRADE",
    type: "NONE",
    reason: ["No clear market structure detected", "Low edge - preserve capital"],
    expectedOutcome: "Stand aside"
  };
}

// -- Feature 3: Strike Selection --
// Based on: ATM/OTM logic (M5), OI clusters, max pain as magnet (M6 Ch13)
function selectStrikes(strategy, chain, sr, maxPain) {
  var spot = chain.spot;
  var step = 50; // NIFTY strike step

  var atm  = Math.round(spot / step) * step;
  var otm1 = atm + step;   // 1 step OTM CE
  var otm2 = atm + step*2; // 2 steps OTM CE
  var otm1pe = atm - step;
  var otm2pe = atm - step*2;

  // Use max pain as magnet - strikes near max pain have higher probability of expiry
  var mpLevel = maxPain || atm;
  var mpAdjust = mpLevel > spot ? step : mpLevel < spot ? -step : 0;

  var strikes = {};

  switch(strategy) {
    case "Bull Call Spread":
      // Buy ATM CE, Sell OTM CE (M6 Ch2: ATM + OTM traditional setup)
      strikes = { buy: atm, sell: otm2, type: "CE", note: "Buy ATM, Sell +2 OTM" };
      break;

    case "Bull Put Spread":
      // Buy OTM PE, Sell ITM PE (M6 Ch3)
      strikes = { buy: otm2pe, sell: atm, type: "PE", note: "Sell ATM PE, Buy OTM PE" };
      break;

    case "Bear Put Spread":
      // Buy ITM PE, Sell OTM PE (M6 Ch7)
      strikes = { buy: atm + step, sell: atm - step, type: "PE", note: "Buy ITM PE, Sell OTM PE" };
      break;

    case "Bear Call Spread":
      // Sell ATM CE, Buy OTM CE (M6 Ch8)
      strikes = { buy: otm2, sell: atm, type: "CE", note: "Sell ATM CE, Buy OTM CE" };
      break;

    case "Long Straddle":
      // Buy ATM CE + ATM PE (M6 Ch10)
      strikes = { buy: atm, sell: null, type: "BOTH", note: "Buy ATM CE + ATM PE" };
      break;

    case "Short Strangle":
      // Sell OTM CE + OTM PE beyond S/R (M6 Ch12)
      var sellCE = sr ? sr.resistance.strike : otm2;
      var sellPE = sr ? sr.support.strike   : otm2pe;
      strikes = { buy: null, sell: sellCE + "/" + sellPE, type: "BOTH", note: "Sell beyond S/R levels" };
      break;

    case "Iron Condor":
      strikes = { buy: otm2pe + "/" + otm2, sell: otm1pe + "/" + otm1, type: "BOTH", note: "Sell inner, Buy outer strikes" };
      break;

    default:
      strikes = { buy: null, sell: null, type: "NONE", note: "No trade" };
  }

  // Apply max pain magnetic adjustment hint
  strikes.maxPainNote = mpLevel !== atm
    ? "Max pain at " + mpLevel + " - expiry likely near this level"
    : "Max pain at ATM - neutral expiry expected";

  return strikes;
}

// -- Feature 4: Strategy Confidence Score --
function getConfidence(regime, pcr, sentiment, chain) {
  var score = 50;
  var oiPCR = pcr.overall.oiPCR;

  // PCR contribution (M6: extremes = higher confidence in reversal)
  if (oiPCR >= 1.3 || oiPCR <= 0.5) score += 15; // extreme = high confidence
  else if (oiPCR >= 1.1 || oiPCR <= 0.7) score += 8;
  else score += 2;

  // Sentiment score contribution
  score += (sentiment.score - 50) * 0.3;

  // Regime clarity
  if (regime.regime === "TRENDING BULLISH" || regime.regime === "TRENDING BEARISH") score += 10;
  if (regime.regime === "RANGE-BOUND") score += 8;
  if (regime.regime === "BREAKOUT SETUP") score += 12;
  if (regime.regime === "LOW EDGE") score -= 20;

  // Volume spike bonus
  var totalVol = chain.strikes.reduce(function(s, r) { return s + r.ce.volume + r.pe.volume; }, 0);
  var avgVol = totalVol / chain.strikes.length;
  if (avgVol > 300000) score += 5;

  // OI strength
  var totalOI = pcr.overall.totalCeOI + pcr.overall.totalPeOI;
  if (totalOI > 2000000) score += 5;

  return Math.round(Math.max(10, Math.min(95, score)));
}

// -- Feature 5+6: Main Trade Decision Block --
function getTradeDecision(chain, pcr, sentiment) {
  if (!chain || !chain.strikes || chain.strikes.length < 3) {
    return { action: "WAIT", strategy: "NO DATA", confidence: 0, reasons: ["Insufficient chain data"] };
  }

  var { findSupportResistance } = require("./oiEngine");
  var sr = findSupportResistance(chain);

  // Calc max pain inline
  var maxPainMap = {};
  chain.strikes.forEach(function(row) {
    chain.strikes.forEach(function(s) {
      if (!maxPainMap[s.strike]) maxPainMap[s.strike] = 0;
      maxPainMap[s.strike] += Math.max(0, row.strike - s.strike) * row.ce.oi;
      maxPainMap[s.strike] += Math.max(0, s.strike - row.strike) * row.pe.oi;
    });
  });
  var maxPain = parseInt(Object.keys(maxPainMap).reduce(function(a, b) {
    return maxPainMap[a] < maxPainMap[b] ? a : b;
  }));

  var regime     = getMarketRegime(chain, pcr, sentiment);
  var suggestion = getStrategySuggestion(regime, chain, pcr, sentiment);
  var strikes    = selectStrikes(suggestion.strategy, chain, sr, maxPain);
  var confidence = getConfidence(regime, pcr, sentiment, chain);

  // Feature 6: No-trade filter (45-60 = low edge)
  var action;
  if (confidence >= 65) action = "EXECUTE";
  else if (confidence >= 45) action = "NO EDGE";
  else action = "AVOID";

  // Build strike display string
  var strikeDisplay = "--";
  if (strikes.type !== "NONE" && (strikes.buy || strikes.sell)) {
    if (strikes.type === "CE" || strikes.type === "PE") {
      strikeDisplay = (strikes.buy ? "Buy " + strikes.buy + " " + strikes.type : "") +
                      (strikes.sell ? "  |  Sell " + strikes.sell + " " + strikes.type : "");
    } else {
      strikeDisplay = strikes.note;
    }
  }

  var reasons = suggestion.reason.slice();
  reasons.push(regime.detail);
  reasons.push(strikes.maxPainNote);

  return {
    action:     action,
    strategy:   suggestion.strategy,
    type:       suggestion.type,
    regime:     regime.regime,
    confidence: confidence,
    strikes:    strikeDisplay,
    strikeData: strikes,
    reasons:    reasons,
    outcome:    suggestion.expectedOutcome,
    maxPain:    maxPain,
    volatility: regime.volatility
  };
}

module.exports = { getTradeDecision, getMarketRegime, getStrategySuggestion, selectStrikes, getConfidence };
