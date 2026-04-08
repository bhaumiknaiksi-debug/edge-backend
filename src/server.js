const express = require("express");
const { getOptionChain }        = require("./data/optionChain");
const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");
const { fmt }                   = require("./utils/helpers");

const app  = express();
const PORT = process.env.PORT || 3001;

async function runAnalysis() {
  const chain     = await getOptionChain();
  const sr        = findSupportResistance(chain);
  const pcr       = calcPCR(chain);
  const sentiment = calcSentiment(pcr);
  const alphas    = rankAlphaStrikes(chain);
  return { spot: chain.spot, expiry: chain.expiry, sr, pcr, sentiment, alphas };
}

app.get("/", (req, res) => {
  res.json({ status: "EDGE Engine online", phase: 2 });
});

app.get("/analysis", async (req, res) => {
  try {
    const result = await runAnalysis();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`\n🚀 EDGE Engine v2 running on port ${PORT}`);
  try {
    const { spot, sr, pcr, sentiment, alphas } = await runAnalysis();
    console.log(`SPOT: ₹${spot}`);
    console.log(`SUPPORT: ${sr.support.strike} | RESISTANCE: ${sr.resistance.strike}`);
    console.log(`PCR: ${pcr.overall.oiPCR} | BIAS: ${sentiment.bias} | SCORE: ${sentiment.score}/100`);
    console.log(`TRADE: ${sentiment.tradeDir}`);
    alphas.forEach(a => console.log(`#${a.rank} ${a.strike} | ${a.dominant} | Score: ${a.totalScore}`));
    console.log("✅ Phase 2 complete.");
  } catch (err) {
    console.error("❌ Engine crashed:", err.message);
  }
});
