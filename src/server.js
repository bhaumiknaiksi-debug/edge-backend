// src/server.js
// PHASE 3 — Live Angel One data + WebSocket broadcasting

const express = require("express");
const http    = require("http");
const { WebSocketServer } = require("ws");

const { getOptionChain }        = require("./data/optionChain");
const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3001;
const POLL_MS = 30000; // broadcast every 30 seconds

// ── Run all engines ──
async function runAnalysis() {
  const chain     = await getOptionChain();
  const sr        = findSupportResistance(chain);
  const pcr       = calcPCR(chain);
  const sentiment = calcSentiment(pcr);
  const alphas    = rankAlphaStrikes(chain);
  return {
    timestamp: new Date().toISOString(),
    spot:      chain.spot,
    expiry:    chain.expiry,
    sr, pcr, sentiment, alphas
  };
}

// ── Broadcast to all connected WebSocket clients ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  let count = 0;
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
      count++;
    }
  });
  if (count > 0) console.log(`📡 Broadcast to ${count} client(s)`);
}

// ── WebSocket connection handler ──
wss.on("connection", async (ws) => {
  console.log("🔌 Client connected");

  // Send latest analysis immediately on connect
  try {
    const result = await runAnalysis();
    ws.send(JSON.stringify({ type: "analysis", ...result }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }

  ws.on("close", () => console.log("🔌 Client disconnected"));
});

// ── Poll engine every 30s, broadcast to all clients ──
async function pollAndBroadcast() {
  try {
    const result = await runAnalysis();
    console.log(`📊 SPOT: ₹${result.spot} | BIAS: ${result.sentiment.bias} | PCR: ${result.pcr.overall.oiPCR}`);
    broadcast({ type: "analysis", ...result });
  } catch (err) {
    console.error("❌ Poll error:", err.message);
    broadcast({ type: "error", message: err.message });
  }
}

// ── REST endpoints ──
app.get("/", (req, res) => {
  res.json({
    status:  "EDGE Engine online",
    phase:   3,
    clients: wss.clients.size,
    ws:      `wss://${req.headers.host}`
  });
});

app.get("/analysis", async (req, res) => {
  try {
    const result = await runAnalysis();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──
server.listen(PORT, async () => {
  console.log(`\n🚀 EDGE Engine v3 on port ${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`🔄 Polling every ${POLL_MS / 1000}s\n`);

  // Run once on boot
  await pollAndBroadcast();

  // Then every 30s
  setInterval(pollAndBroadcast, POLL_MS);
});
