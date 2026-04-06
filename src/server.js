// src/server.js
// PHASE 2 — PCR + Sentiment + Alpha Strike Ranking
// Phase 3: WebSocket layer goes on top of this

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
  console.log("\n========================================");
  console.log("      EDGE ENGINE — PHASE 2 BOOT        ");
  console.log("========================================\n");

  try {
    const { spot, expiry, sr, pcr, sentiment, alphas } = await runAnalysis();

    console.log(`SPOT PRICE : ₹${spot}`);
    console.log(`EXPIRY     : ${expiry}`);

    console.log("\n--- SUPPORT / RESISTANCE ---");
    console.log(`ATM        : ${sr.atmStrike}`);
    console.log(`SUPPORT    : ${sr.support.strike}   (PE OI: ${fmt(sr.support.peOI)})`);
    console.log(`RESISTANCE : ${sr.resistance.strike}   (CE OI: ${fmt(sr.resistance.ceOI)})`);

    console.log("\n--- PCR ANALYSIS ---");
    console.log(`OI PCR     : ${pcr.overall.oiPCR}`);
    console.log(`VOL PCR    : ${pcr.overall.volPCR}`);
    console.log(`TOTAL CE OI: ${fmt(pcr.overall.totalCeOI)}`);
    console.log(`TOTAL PE OI: ${fmt(pcr.overall.totalPeOI)}`);

    console.log("\n--- MARKET SENTIMENT ---");
    console.log(`BIAS       : ${sentiment.bias}`);
    console.log(`STRENGTH   : ${sentiment.strength}`);
    console.log(`SCORE      : ${sentiment.score}/100`);
    console.log(`TRADE DIR  : ${sentiment.tradeDir}`);

    console.log("\n--- ALPHA STRIKES (Top 3) ---");
    alphas.forEach(a => {
      console.log(`#${a.rank} STRIKE ${a.strike} | Score: ${a.totalScore} | Dominant: ${a.dominant} | CE OI: ${fmt(a.ceOI)} | PE OI: ${fmt(a.peOI)}`);
    });

    console.log("\n========================================");
    console.log("✅ Phase 2 complete. Full engine online.");
    console.log("========================================\n");

  } catch (err) {
    console.error("❌ Engine crashed:", err.message);
  }
});
