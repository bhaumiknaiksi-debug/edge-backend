// src/server.js
// PHASE 1 — Console output only. No API, no WebSocket, no UI yet.
// Run: node src/server.js

const { getOptionChain }        = require("./data/optionChain");
const { findSupportResistance } = require("./engine/oiEngine");
const { fmt }                   = require("./utils/helpers");

async function run() {
  console.log("\n========================================");
  console.log("       EDGE ENGINE — PHASE 1 TEST       ");
  console.log("========================================\n");

  // Step 1: Fetch chain
  const chain = await getOptionChain();
  console.log(`SPOT PRICE : ₹${chain.spot}`);
  console.log(`EXPIRY     : ${chain.expiry}`);
  console.log(`STRIKES    : ${chain.strikes.length} loaded\n`);

  // Step 2: OI Engine
  const sr = findSupportResistance(chain);

  console.log("--- SUPPORT / RESISTANCE (OI-based) ---");
  console.log(`ATM STRIKE  : ${sr.atmStrike}`);
  console.log(`SUPPORT     : ${sr.support.strike}   (PE OI: ${fmt(sr.support.peOI)}, ΔOI: ${fmt(sr.support.peOIChange)})`);
  console.log(`RESISTANCE  : ${sr.resistance.strike}   (CE OI: ${fmt(sr.resistance.ceOI)}, ΔOI: ${fmt(sr.resistance.ceOIChange)})`);

  console.log("\n========================================");
  console.log("✅ Phase 1 complete. Engine is alive.");
  console.log("========================================\n");
}

run().catch(err => {
  console.error("❌ Engine crashed:", err.message);
  process.exit(1);
});
