// src/server.js - EDGE Phase 3 - self-contained, no external data imports

const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server;

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3001;

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -- In-memory session --
var session = { jwt: null, clientId: null };
var pollTimer = null;

// -- Mock data (inline, no import needed) --
function getMockChain() {
  return {
    spot: 22143.5,
    expiry: "mock",
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

// -- Angel One API helper --
function angelRequest(path, method, body, jwt) {
  return new Promise(function(resolve, reject) {
    var payload = body ? JSON.stringify(body) : null;
    var headers = {
      "Content-Type":     "application/json",
      "X-ClientLocalIP":  "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress":     "00:00:00:00:00:00",
      "X-PrivateKey":     process.env.ANGEL_API_KEY || "key",
      "X-SourceID":       "WEB",
      "Accept":           "application/json"
    };
    if (jwt) headers["Authorization"] = "Bearer " + jwt;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    var req = https.request({
      hostname: "apiconnect.angelone.in",
      path: path, method: method, headers: headers
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error("Bad JSON: " + data.slice(0, 80))); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// -- Fetch live option chain --
function fetchLiveChain(jwt) {
  return angelRequest(
    "/rest/secure/angelbroking/market/v1/optionGreek?exchange=NFO&symboltoken=99926000&expiry=&strike=-1&optiontype=CE",
    "GET", null, jwt
  ).then(function(res) {
    if (!res || !res.data || !Array.isArray(res.data)) {
      throw new Error("Empty chain");
    }
    var strikeMap = {};
    var spot = 0;
    res.data.forEach(function(row) {
      var s = row.strikePrice;
      if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };
      spot = row.underlyingValue || spot;
      var side = { ltp: row.ltp||0, oi: row.openInterest||0, oiChange: row.changeinOpenInterest||0, volume: row.tradedVolume||0 };
      if (row.optionType === "CE") strikeMap[s].ce = side;
      else if (row.optionType === "PE") strikeMap[s].pe = side;
    });
    var strikes = Object.values(strikeMap)
      .filter(function(r) { return r.ce && r.pe; })
      .sort(function(a,b) { return a.strike - b.strike; })
      .filter(function(r) { return Math.abs(r.strike - spot) <= 350; });
    if (strikes.length < 3) throw new Error("Not enough strikes");
    return { spot: spot, expiry: "live", strikes: strikes };
  });
}

// -- Run analysis --
function runAnalysis() {
  var chainPromise;
  if (session.jwt) {
    chainPromise = fetchLiveChain(session.jwt).catch(function(err) {
      console.log("Live fetch failed, using mock:", err.message);
      return getMockChain();
    });
  } else {
    chainPromise = Promise.resolve(getMockChain());
  }
  return chainPromise.then(function(chain) {
    var sr        = findSupportResistance(chain);
    var pcr       = calcPCR(chain);
    var sentiment = calcSentiment(pcr);
    var alphas    = rankAlphaStrikes(chain);
    return { timestamp: new Date().toISOString(), spot: chain.spot, expiry: chain.expiry, sr: sr, pcr: pcr, sentiment: sentiment, alphas: alphas };
  });
}

// -- Broadcast --
function broadcast(data) {
  var msg = JSON.stringify(data);
  wss.clients.forEach(function(ws) { if (ws.readyState === 1) ws.send(msg); });
}

function pollAndBroadcast() {
  runAnalysis().then(function(result) {
    console.log("SPOT: " + result.spot + " | BIAS: " + result.sentiment.bias + " | PCR: " + result.pcr.overall.oiPCR);
    broadcast({ type: "analysis", spot: result.spot, expiry: result.expiry, sr: result.sr, pcr: result.pcr, sentiment: result.sentiment, alphas: result.alphas, timestamp: result.timestamp });
  }).catch(function(err) {
    console.error("Poll error:", err.message);
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAndBroadcast();
  pollTimer = setInterval(pollAndBroadcast, 30000);
}

// -- LOGIN --
app.post("/login", function(req, res) {
  var clientId = req.body.clientId;
  var pin      = req.body.pin;
  var totp     = req.body.totp;
  if (!clientId || !pin || !totp) {
    return res.status(400).json({ success: false, message: "clientId, pin and totp required" });
  }
  angelRequest(
    "/rest/auth/angelbroking/user/v1/loginByPassword",
    "POST",
    { clientcode: clientId, password: pin, totp: totp }
  ).then(function(loginRes) {
    if (!loginRes || !loginRes.data || !loginRes.data.jwtToken) {
      return res.status(401).json({ success: false, message: (loginRes && loginRes.message) || "Login failed" });
    }
    session.jwt      = loginRes.data.jwtToken;
    session.clientId = clientId;
    console.log("Logged in:", clientId);
    startPolling();
    res.json({ success: true, message: "Logged in. Live data active." });
  }).catch(function(err) {
    res.status(500).json({ success: false, message: err.message });
  });
});

// -- WebSocket --
wss.on("connection", function(ws) {
  console.log("Client connected");
  runAnalysis().then(function(result) {
    ws.send(JSON.stringify({ type: "analysis", spot: result.spot, expiry: result.expiry, sr: result.sr, pcr: result.pcr, sentiment: result.sentiment, alphas: result.alphas, timestamp: result.timestamp }));
  }).catch(function(err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  });
  ws.on("close", function() { console.log("Client disconnected"); });
});

// -- REST --
app.get("/", function(req, res) {
  res.json({ status: "EDGE Engine online", phase: 3, live: !!session.jwt });
});

app.get("/analysis", function(req, res) {
  runAnalysis().then(function(result) { res.json(result); }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

// -- Start --
server.listen(PORT, function() {
  console.log("EDGE Engine v3 on port " + PORT);
  console.log("WebSocket ready");
  console.log("Polling every 30s");
  startPolling();
});
