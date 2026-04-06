// src/server.js
// PHASE 1 → 3 foundation: Express server + engine runner
// Phase 1: runs engine on start, serves /health and /analysis
// Phase 3: WebSocket will be added on top of this same server

const express = require("express");
const { getOptionChain }        = require("./data/optionChain");
const { findSupportResistance } = require("./engine/oiEngine");
const { fmt }                   = require("./utils/helpers");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Health check (Render pings this to confirm service is up) ──
app.get("/", (req, res) => {
  res.json({ status: "EDGE Engine online", phase: 1 });
});

// ── Analysis endpoint (Phase 2 will expand this) ──
app.get("/analysis", async (req, res) => {
  try {
    const chain = await getOptionChain();
    const sr    = findSupportResistance(chain);
    res.json({ spot: chain.spot, ...sr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──
app.listen(PORT, async () => {
  console.log(`\n🚀 EDGE Engine running on port ${PORT}`);

  // Run engine once on boot so logs show output immediately
  console.log("\n========================================");
  console.log("       EDGE ENGINE — PHASE 1 TEST       ");
  console.log("========================================\n");

  try {
    const chain = await getOptionChain();
    console.log(`SPOT PRICE : ₹${chain.spot}`);
    console.log(`EXPIRY     : ${chain.expiry}`);
    console.log(`STRIKES    : ${chain.strikes.length} loaded\n`);

    const sr = findSupportResistance(chain);
    console.log("--- SUPPORT / RESISTANCE (OI-based) ---");
    console.log(`ATM STRIKE  : ${sr.atmStrike}`);
    console.log(`SUPPORT     : ${sr.support.strike}   (PE OI: ${fmt(sr.support.peOI)}, ΔOI: ${fmt(sr.support.peOIChange)})`);
    console.log(`RESISTANCE  : ${sr.resistance.strike}   (CE OI: ${fmt(sr.resistance.ceOI)}, ΔOI: ${fmt(sr.resistance.ceOIChange)})`);

    console.log("\n========================================");
    console.log("✅ Phase 1 complete. Engine is alive.");
    console.log("========================================\n");
  } catch (err) {
    console.error("❌ Engine crashed:", err.message);
  }
});
