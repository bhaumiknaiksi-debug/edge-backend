// src/server.js
// PHASE 3 — Live Angel One data + WebSocket broadcast
// Falls back to mock data outside market hours or if API fails

const express   = require("express");
const { WebSocketServer } = require("ws");
const http      = require("http");

const { getOptionChain }        = require("./data/optionChain");   // mock fallback
const { getLiveOptionChain }    = require("./data/angelOne");       // live data
const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");
const { fmt }                   = require("./utils/helpers");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3001;

// ── Market hours check (IST = UTC+5:30) ──
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const h   = ist.getUTCHours();
  const m   = ist.getUTCMinutes();
  const min = h * 60 + m;
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  return min >= 555 && min <= 930; // 9:15 AM to 3:30 PM IST
}

// ── Fetch chain: live during market hours, mock otherwise ──
async function getChain() {
  const useEnv = process.env.ANGEL_API_KEY && process.env.ANGEL_CLIENT_ID;

  if (useEnv && isMarketOpen()) {
    try {
      console.log("📡 Fetching live Angel One data...");
      return await getLiveOptionChain();
    } catch (err) {
      console.warn("⚠️  Live fetch failed, falling back to mock:", err.message);
    }
  } else {
    console.log(useEnv ? "🕐 Market closed — using mock data" : "🔧 No API keys — using mock data");
  }

  return await getOptionChain(); // fallback
}

// ── Run full analysis ──
async function runAnalysis() {
  const chain     = await getChain();
  const sr        = findSupportResistance(chain);
  const pcr       = calcPCR(chain);
  const sentiment = calcSentiment(pcr);
  const alphas    = rankAlphaStrikes(chain);
  const live      = isMarketOpen() && !!process.env.ANGEL_API_KEY;

  return {
    timestamp: new Date().toISOString(),
    live,
    spot:   chain.spot,
    expiry: chain.expiry,
    sr, pcr, sentiment, alphas
  };
}

// ── Cache last result ──
let lastResult = null;

// ── Broadcast to all WebSocket clients ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ── WebSocket connection handler ──
wss.on("connection", (ws) => {
  console.log("🔌 Client connected via WebSocket");

  // Send last known result immediately on connect
  if (lastResult) ws.send(JSON.stringify(lastResult));

  ws.on("close", () => console.log("🔌 Client disconnected"));
});

// ── Polling loop: refresh every 30s ──
async function poll() {
  try {
    lastResult = await runAnalysis();
    broadcast(lastResult);
    logResult(lastResult);
  } catch (err) {
    console.error("❌ Poll error:", err.message);
  }
}

function logResult(r) {
  console.log(`\n[${new Date().toLocaleTimeString("en-IN")}] SPOT: ₹${r.spot} | ${r.live ? "🟢 LIVE" : "🟡 MOCK"}`);
  console.log(`  BIAS: ${r.sentiment.bias} (${r.sentiment.score}/100) → ${r.sentiment.tradeDir}`);
  console.log(`  S: ${r.sr.support.strike} | R: ${r.sr.resistance.strike} | PCR: ${r.pcr.overall.oiPCR}`);
  console.log(`  #1 Alpha: ${r.alphas[0]?.strike} | #2: ${r.alphas[1]?.strike} | #3: ${r.alphas[2]?.strike}`);
}

// ── HTTP endpoints ──
app.get("/", (req, res) => {
  res.json({ status: "EDGE Engine online", phase: 3, live: isMarketOpen() });
});

app.get("/analysis", async (req, res) => {
  try {
    const result = lastResult || await runAnalysis();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──
server.listen(PORT, async () => {
  console.log(`\n🚀 EDGE Engine v3 running on port ${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`🌐 HTTP: /analysis`);
  console.log(`⏰ Market open: ${isMarketOpen() ? "YES 🟢" : "NO 🟡"}\n`);

  // Run immediately on boot
  await poll();

  // Then every 30 seconds
  setInterval(poll, 30 * 1000);
});
