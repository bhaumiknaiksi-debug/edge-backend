// src/engine/sentimentEngine.js
// Combines PCR + OI delta to generate market bias

function calcSentiment({ overall }) {
  const pcr = overall.oiPCR;

  // Base bias from PCR
  let bias, strength, score;

  if (pcr >= 1.5) {
    bias = "STRONGLY BULLISH"; strength = "HIGH";   score = 90;
  } else if (pcr >= 1.2) {
    bias = "BULLISH";          strength = "MEDIUM"; score = 70;
  } else if (pcr >= 0.9) {
    bias = "NEUTRAL";          strength = "LOW";    score = 50;
  } else if (pcr >= 0.7) {
    bias = "BEARISH";          strength = "MEDIUM"; score = 30;
  } else {
    bias = "STRONGLY BEARISH"; strength = "HIGH";   score = 10;
  }

  // Suggested trade direction
  const tradeDir = score >= 60 ? "CE (Buy Calls)"
                 : score <= 40 ? "PE (Buy Puts)"
                 : "WAIT — No clear edge";

  return { bias, strength, score, tradeDir, pcr };
}

module.exports = { calcSentiment };
