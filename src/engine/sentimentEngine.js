function calcSentiment(pcr) {
  const v = pcr.overall.oiPCR;
  if (v >= 1.5) return { bias: "STRONGLY BULLISH", score: 90, tradeDir: "CE (Buy Calls)" };
  if (v >= 1.2) return { bias: "BULLISH", score: 70, tradeDir: "CE (Buy Calls)" };
  if (v >= 0.9) return { bias: "NEUTRAL", score: 50, tradeDir: "WAIT" };
  if (v >= 0.7) return { bias: "BEARISH", score: 30, tradeDir: "PE (Buy Puts)" };
  return { bias: "STRONGLY BEARISH", score: 10, tradeDir: "PE (Buy Puts)" };
}
module.exports = { calcSentiment };
