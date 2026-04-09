const express = require("express");
const http = require("http");
const crypto = require("crypto");

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR } = require("./engine/pcrEngine");
const { calcSentiment } = require("./engine/sentimentEngine");
const { rankAlphaStrikes } = require("./engine/strikeEngine");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "2mb" }));
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

var clients = [];
var lastResult = null;
var lastPushTime = 0;

// Feature 1: Market hours detection (IST)
function isMarketOpen() {
  var now = new Date();
  var ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var day = ist.getDay();
  if (day === 0 || day === 6) return false;
  var mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930; // 9:15 to 15:30
}

// Feature 5: Option intelligence from existing chain data
function calcOptionIntel(chain) {
  var spot = chain.spot;
  var callZones = [], putZones = [], clusters = [], pcrByStrike = [], totalCE = 0, totalPE = 0;
  var maxPainMap = {};

  chain.strikes.forEach(function(row) {
    totalCE += row.ce.oi;
    totalPE += row.pe.oi;
    pcrByStrike.push({ strike: row.strike, pcr: parseFloat((row.pe.oi / (row.ce.oi || 1)).toFixed(2)) });

    if (row.ce.oiChange > 0 && row.strike > spot) callZones.push({ strike: row.strike, oi: row.ce.oi, oiChange: row.ce.oiChange });
    if (row.pe.oiChange > 0 && row.strike < spot) putZones.push({ strike: row.strike, oi: row.pe.oi, oiChange: row.pe.oiChange });

    var combined = row.ce.oi + row.pe.oi;
    if (combined > 300000) clusters.push({ strike: row.strike, totalOI: combined, dominant: row.ce.oi > row.pe.oi ? "CE" : "PE" });

    // Max pain calculation
    chain.strikes.forEach(function(s) {
      if (!maxPainMap[s.strike]) maxPainMap[s.strike] = 0;
      maxPainMap[s.strike] += Math.max(0, row.strike - s.strike) * row.ce.oi;
      maxPainMap[s.strike] += Math.max(0, s.strike - row.strike) * row.pe.oi;
    });
  });

  var maxPain = Object.keys(maxPainMap).reduce(function(a, b) {
    return maxPainMap[a] < maxPainMap[b] ? a : b;
  });

  callZones.sort(function(a,b) { return b.oi - a.oi; });
  putZones.sort(function(a,b) { return b.oi - a.oi; });
  clusters.sort(function(a,b) { return b.totalOI - a.totalOI; });

  return {
    callWritingZones: callZones.slice(0, 3),
    putWritingZones: putZones.slice(0, 3),
    oiClusters: clusters.slice(0, 3),
    pcrByStrike: pcrByStrike,
    maxPain: parseInt(maxPain),
    overallPCR: parseFloat((totalPE / (totalCE || 1)).toFixed(2))
  };
}

// Feature 3: Strike analyser
function analyseStrike(strikePrice, chain, pcr, sentiment) {
  var spot = chain.spot;
  var row = chain.strikes.find(function(r) { return r.strike === strikePrice; });
  if (!row) return { confidence: 0, action: "WAIT", reasons: ["Strike not found in chain"] };

  var reasons = [];
  var score = 50;
  var action = "WAIT";

  var distPct = Math.abs(strikePrice - spot) / spot * 100;
  if (distPct < 0.5) { reasons.push("ATM strike - high gamma"); score += 10; }
  else if (distPct < 1)  { reasons.push("Near ATM strike"); score += 5; }
  else { reasons.push("OTM strike - lower probability"); score -= 10; }

  if (row.ce.oiChange > 50000) { reasons.push("Strong CE writing (resistance building)"); score -= 8; }
  if (row.pe.oiChange > 50000) { reasons.push("Strong PE writing (support building)"); score += 8; }

  var strikePCR = row.pe.oi / (row.ce.oi || 1);
  if (strikePCR > 1.3) { reasons.push("Bullish PCR at this strike"); score += 10; }
  else if (strikePCR < 0.7) { reasons.push("Bearish PCR at this strike"); score -= 10; }

  if (sentiment.bias === "BULLISH" || sentiment.bias === "STRONGLY BULLISH") { reasons.push("Market bias is bullish"); score += 8; }
  else if (sentiment.bias === "BEARISH" || sentiment.bias === "STRONGLY BEARISH") { reasons.push("Market bias is bearish"); score -= 8; }

  if (row.ce.volume > 200000) { reasons.push("High CE volume - active strike"); score += 5; }
  if (row.pe.volume > 200000) { reasons.push("High PE volume - active strike"); score += 5; }

  score = Math.max(10, Math.min(95, score));

  if (score >= 65) action = "BUY CE";
  else if (score <= 40) action = "BUY PE";
  else action = "WAIT";

  return { strike: strikePrice, confidence: score, action: action, reasons: reasons, strikePCR: parseFloat(strikePCR.toFixed(2)), ceOI: row.ce.oi, peOI: row.pe.oi };
}

function getMockChain() {
  return {
    spot: 22143.5, expiry: "mock",
    strikes: [
      { strike: 21900, ce: { ltp: 280, oi: 180000, oiChange: 15000, volume: 210000 }, pe: { ltp: 30,  oi: 310000, oiChange: 40000, volume: 290000 } },
      { strike: 22000, ce: { ltp: 210, oi: 250000, oiChange: 20000, volume: 320000 }, pe: { ltp: 55,  oi: 280000, oiChange: 35000, volume: 270000 } },
      { strike: 22100, ce: { ltp: 145, oi: 200000, oiChange: 25000, volume: 300000 }, pe: { ltp: 80,  oi: 150000, oiChange: 10000, volume: 200000 } },
      { strike: 22150, ce: { ltp: 120, oi: 175000, oiChange: 18000, volume: 260000 }, pe: { ltp: 100, oi: 130000, oiChange:  8000, volume: 180000 } },
      { strike: 22200, ce: { ltp: 100, oi: 220000, oiChange: 30000, volume: 350000 }, pe: { ltp: 95,  oi: 120000, oiChange: -5000, volume: 150000 } },
      { strike: 22300, ce: { ltp: 60,  oi: 190000, oiChange: 12000, volume: 240000 }, pe: { ltp: 140, oi:  90000, oiChange: -8000, volume: 120000 } },
      { strike: 22400, ce: { ltp: 30,  oi: 160000, oiChange:  8000, volume: 190000 }, pe: { ltp: 195, oi:  70000, oiChange: -3000, volume:  90000 } }
    ]
  };
}

function analyse(chain) {
  var pcr = calcPCR(chain);
  return {
    timestamp: new Date().toISOString(),
    spot: chain.spot,
    expiry: chain.expiry,
    sr: findSupportResistance(chain),
    pcr: pcr,
    sentiment: calcSentiment(pcr),
    alphas: rankAlphaStrikes(chain)
  };
}

// Built-in WebSocket
function wsHandshake(req, socket) {
  var key = req.headers["sec-websocket-key"];
  var accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
}

function wsEncode(data) {
  var msg = Buffer.from(data);
  var len = msg.length;
  var buf = len < 126 ? Buffer.allocUnsafe(2 + len) : Buffer.allocUnsafe(4 + len);
  buf[0] = 0x81;
  if (len < 126) { buf[1] = len; msg.copy(buf, 2); }
  else { buf[1] = 126; buf.writeUInt16BE(len, 2); msg.copy(buf, 4); }
  return buf;
}

function wsSend(socket, obj) {
  try { socket.write(wsEncode(JSON.stringify(obj))); } catch(e) {}
}

function broadcast(obj) {
  clients.forEach(function(s) { wsSend(s, obj); });
}

server.on("upgrade", function(req, socket) {
  if (req.headers["upgrade"] !== "websocket") { socket.destroy(); return; }
  wsHandshake(req, socket);
  clients.push(socket);
  console.log("WS connected, clients:" + clients.length);
  // Send last known result immediately
  if (lastResult) {
    wsSend(socket, { type: "analysis", spot: lastResult.spot, expiry: lastResult.expiry, sr: lastResult.sr, pcr: lastResult.pcr, sentiment: lastResult.sentiment, alphas: lastResult.alphas, timestamp: lastResult.timestamp });
  } else {
    var mock = analyse(getMockChain());
    wsSend(socket, { type: "analysis", spot: mock.spot, expiry: mock.expiry, sr: mock.sr, pcr: mock.pcr, sentiment: mock.sentiment, alphas: mock.alphas, timestamp: mock.timestamp });
  }
  socket.on("close", function() { clients = clients.filter(function(s) { return s !== socket; }); });
  socket.on("error", function() { clients = clients.filter(function(s) { return s !== socket; }); });
});

// /push - rate limited + market hours aware
app.post("/push", function(req, res) {
  var now = Date.now();
  if (now - lastPushTime < 5000) {
    return res.json({ success: true, cached: true, spot: lastResult && lastResult.spot });
  }
  if (!isMarketOpen() && lastResult) {
    return res.json({ success: true, closed: true, spot: lastResult.spot, message: "Market closed, using last known data" });
  }
  var chain = req.body;
  if (!chain || !chain.strikes || !Array.isArray(chain.strikes) || chain.strikes.length < 3) {
    return res.status(400).json({ success: false, message: "Invalid chain data" });
  }
  try {
    var result = analyse(chain);
    result.intel = calcOptionIntel(chain);
    result.marketOpen = isMarketOpen();
    lastResult = result;
    lastPushTime = now;
    console.log("PUSH: SPOT:" + result.spot + " BIAS:" + result.sentiment.bias + " PCR:" + result.pcr.overall.oiPCR + " OPEN:" + result.marketOpen);
    broadcast({ type: "analysis", spot: result.spot, expiry: result.expiry, sr: result.sr, pcr: result.pcr, sentiment: result.sentiment, alphas: result.alphas, intel: result.intel, marketOpen: result.marketOpen, timestamp: result.timestamp });
    res.json({ success: true, spot: result.spot, bias: result.sentiment.bias });
  } catch(e) {
    console.error("Analyse error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// /analyse-strike - Feature 3
app.post("/analyse-strike", function(req, res) {
  var strike = parseInt(req.body.strike);
  if (!strike || !lastResult) return res.status(400).json({ error: "No chain data available yet" });
  try {
    var chain = req.body.chain || null;
    if (!chain) return res.status(400).json({ error: "Chain required" });
    var result = analyseStrike(strike, chain, lastResult.pcr, lastResult.sentiment);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", function(req, res) { res.json({ status: "EDGE Engine online", phase: 3, clients: clients.length, marketOpen: isMarketOpen() }); });
app.get("/analysis", function(req, res) {
  var base = lastResult || analyse(getMockChain());
  res.json(Object.assign({}, base, { marketOpen: isMarketOpen() }));
});

server.listen(PORT, function() {
  console.log("EDGE Engine v3 on port " + PORT);
  console.log("Waiting for chain data from frontend via /push");
});
