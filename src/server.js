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

// NEW: Frontend sends raw option chain data, backend analyses and broadcasts
app.post("/push", function(req, res) {
  var chain = req.body;
  if (!chain || !chain.strikes || !Array.isArray(chain.strikes) || chain.strikes.length < 3) {
    return res.status(400).json({ success: false, message: "Invalid chain data" });
  }
  try {
    var result = analyse(chain);
    lastResult = result;
    console.log("PUSH: SPOT:" + result.spot + " BIAS:" + result.sentiment.bias + " PCR:" + result.pcr.overall.oiPCR + " STRIKES:" + chain.strikes.length);
    broadcast({ type: "analysis", spot: result.spot, expiry: result.expiry, sr: result.sr, pcr: result.pcr, sentiment: result.sentiment, alphas: result.alphas, timestamp: result.timestamp });
    res.json({ success: true, spot: result.spot, bias: result.sentiment.bias });
  } catch(e) {
    console.error("Analyse error:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/", function(req, res) { res.json({ status: "EDGE Engine online", phase: 3, clients: clients.length }); });
app.get("/analysis", function(req, res) {
  var r = lastResult || analyse(getMockChain());
  res.json(r);
});

server.listen(PORT, function() {
  console.log("EDGE Engine v3 on port " + PORT);
  console.log("Waiting for chain data from frontend via /push");
});
