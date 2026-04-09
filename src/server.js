const express = require("express");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR } = require("./engine/pcrEngine");
const { calcSentiment } = require("./engine/sentimentEngine");
const { rankAlphaStrikes } = require("./engine/strikeEngine");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

var clients = [];
var session = { jwt: null, clientId: null };
var pollTimer = null;

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

// Fetch option chain using JWT (called from backend after receiving JWT from frontend)
function fetchLiveChain(jwt, apiKey) {
  var headers = {
    "Authorization": "Bearer " + jwt,
    "Content-Type": "application/json",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    "X-SourceID": "WEB",
    "Accept": "application/json"
  };

  function fetchType(optionType) {
    return new Promise(function(resolve, reject) {
      var req = https.request({
        hostname: "apiconnect.angelone.in",
        path: "/rest/secure/angelbroking/market/v1/optionGreek?exchange=NFO&symboltoken=99926000&expiry=&strike=-1&optiontype=" + optionType,
        method: "GET",
        headers: headers
      }, function(res) {
        var data = "";
        res.on("data", function(c) { data += c; });
        res.on("end", function() {
          try {
            var parsed = JSON.parse(data);
            if (!parsed || !parsed.data || !Array.isArray(parsed.data)) {
              return reject(new Error("Empty " + optionType + ": " + data.slice(0, 100)));
            }
            resolve(parsed.data);
          } catch(e) { reject(new Error("Bad JSON (" + optionType + "): " + data.slice(0, 80))); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  return Promise.all([fetchType("CE"), fetchType("PE")]).then(function(results) {
    var strikeMap = {}, spot = 0;
    results[0].concat(results[1]).forEach(function(row) {
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

function runAnalysis() {
  var p;
  if (session.jwt && session.apiKey) {
    p = fetchLiveChain(session.jwt, session.apiKey).catch(function(e) {
      console.log("Live failed, mock:", e.message);
      return getMockChain();
    });
  } else {
    p = Promise.resolve(getMockChain());
  }
  return p.then(function(chain) {
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
  });
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
  console.log("WS connected, clients:", clients.length);
  runAnalysis().then(function(r) { wsSend(socket, { type: "analysis", spot: r.spot, expiry: r.expiry, sr: r.sr, pcr: r.pcr, sentiment: r.sentiment, alphas: r.alphas, timestamp: r.timestamp }); });
  socket.on("close", function() { clients = clients.filter(function(s) { return s !== socket; }); });
  socket.on("error", function() { clients = clients.filter(function(s) { return s !== socket; }); });
});

function pollAndBroadcast() {
  runAnalysis().then(function(r) {
    console.log("SPOT:" + r.spot + " BIAS:" + r.sentiment.bias + " PCR:" + r.pcr.overall.oiPCR + " LIVE:" + (r.expiry === "live"));
    broadcast({ type: "analysis", spot: r.spot, expiry: r.expiry, sr: r.sr, pcr: r.pcr, sentiment: r.sentiment, alphas: r.alphas, timestamp: r.timestamp });
  }).catch(function(e) { console.error("Poll error:", e.message); });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAndBroadcast();
  pollTimer = setInterval(pollAndBroadcast, 30000);
}

// NEW: Frontend sends JWT directly - no Angel One call from backend on login
app.post("/session", function(req, res) {
  var jwt = req.body.jwt;
  var apiKey = req.body.apiKey;
  var clientId = req.body.clientId;
  if (!jwt || !apiKey) return res.status(400).json({ success: false, message: "jwt and apiKey required" });
  session.jwt = jwt;
  session.apiKey = apiKey;
  session.clientId = clientId || "unknown";
  console.log("Session set for:", session.clientId);
  startPolling();
  res.json({ success: true, message: "Session active. Live data starting." });
});

app.get("/", function(req, res) { res.json({ status: "EDGE Engine online", phase: 3, live: !!session.jwt, clients: clients.length }); });
app.get("/analysis", function(req, res) { runAnalysis().then(function(r) { res.json(r); }).catch(function(e) { res.status(500).json({ error: e.message }); }); });

server.listen(PORT, function() {
  console.log("EDGE Engine v3 on port " + PORT);
  startPolling();
});
