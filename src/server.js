const express = require("express");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR } = require("./engine/pcrEngine");
const { calcSentiment } = require("./engine/sentimentEngine");
const { rankAlphaStrikes, analyseStrike } = require("./engine/strikeEngine");
const { calcOptionIntel } = require("./engine/optionIntelEngine");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

var clients = [];
var session = { jwt: null, clientId: null, apiKey: null };
var pollTimer = null;

// ── FEATURE 1: Last-known-data store ──
var lastKnownChain = null;   // last successful chain snapshot
var lastKnownResult = null;  // last successful analysis result

// ── PAPER TRADE STORE ──
var trades = [];
var tradeIdCounter = 1;
var LOT_SIZE = 50; // NIFTY lot size

function getLTP(chain, strike, side) {
  for (var i = 0; i < chain.strikes.length; i++) {
    var r = chain.strikes[i];
    if (r.strike === strike) {
      return side === "CE" ? r.ce.ltp : r.pe.ltp;
    }
  }
  return 0;
}

function computeTradePnL(chain) {
  // Compute live P&L for all open trades using current chain
  var openPnL = 0;
  trades.forEach(function(t) {
    if (t.status === "OPEN") {
      var currentLTP = getLTP(chain, t.strike, t.side);
      t.currentLTP = currentLTP;
      t.pnl = parseFloat(((currentLTP - t.entryPrice) * LOT_SIZE).toFixed(2));
      t.pnlPct = t.entryPrice > 0 ? parseFloat((((currentLTP - t.entryPrice) / t.entryPrice) * 100).toFixed(2)) : 0;
      openPnL += t.pnl;
    }
  });
  return parseFloat(openPnL.toFixed(2));
}

function getTradesSummary(chain) {
  var openPnL = computeTradePnL(chain);
  var closedPnL = 0;
  var wins = 0, losses = 0;
  trades.forEach(function(t) {
    if (t.status === "CLOSED") {
      closedPnL += t.pnl;
      if (t.pnl >= 0) wins++; else losses++;
    }
  });
  return {
    openTrades: trades.filter(function(t){ return t.status === "OPEN"; }),
    closedTrades: trades.filter(function(t){ return t.status === "CLOSED"; }).slice(-20).reverse(),
    openPnL: parseFloat(openPnL.toFixed(2)),
    closedPnL: parseFloat(closedPnL.toFixed(2)),
    totalPnL: parseFloat((openPnL + closedPnL).toFixed(2)),
    totalTrades: trades.length,
    wins: wins,
    losses: losses,
    winRate: (wins + losses) > 0 ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1)) : 0
  };
}

function getMockChain() {
  return {
    spot: 22143.5,
    expiry: "mock",
    strikes: [
      { strike: 21900, ce: { ltp: 280, oi: 180000, oiChange: 15000, volume: 210000 }, pe: { ltp: 30, oi: 310000, oiChange: 40000, volume: 290000 } },
      { strike: 22000, ce: { ltp: 210, oi: 250000, oiChange: 20000, volume: 320000 }, pe: { ltp: 55, oi: 280000, oiChange: 35000, volume: 270000 } },
      { strike: 22100, ce: { ltp: 145, oi: 200000, oiChange: 25000, volume: 300000 }, pe: { ltp: 80, oi: 150000, oiChange: 10000, volume: 200000 } },
      { strike: 22150, ce: { ltp: 120, oi: 175000, oiChange: 18000, volume: 260000 }, pe: { ltp: 100, oi: 130000, oiChange: 8000, volume: 180000 } },
      { strike: 22200, ce: { ltp: 100, oi: 220000, oiChange: 30000, volume: 350000 }, pe: { ltp: 95, oi: 120000, oiChange: -5000, volume: 150000 } },
      { strike: 22300, ce: { ltp: 60, oi: 190000, oiChange: 12000, volume: 240000 }, pe: { ltp: 140, oi: 90000, oiChange: -8000, volume: 120000 } },
      { strike: 22400, ce: { ltp: 30, oi: 160000, oiChange: 8000, volume: 190000 }, pe: { ltp: 195, oi: 70000, oiChange: -3000, volume: 90000 } },
    ],
  };
}

// Fetch option chain using JWT
function fetchLiveChain(jwt, apiKey) {
  return new Promise(function (resolve, reject) {
    var headers = {
      Authorization: "Bearer " + jwt,
      "Content-Type": "application/json",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": apiKey,
      "X-SourceID": "WEB",
      Accept: "application/json",
    };
    var req = https.request(
      {
        hostname: "apiconnect.angelone.in",
        path: "/rest/secure/angelbroking/market/v1/optionGreek?exchange=NFO&symboltoken=99926000&expiry=&strike=-1&optiontype=CE",
        method: "GET",
        headers: headers,
      },
      function (res) {
        var data = "";
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          try {
            var parsed = JSON.parse(data);
            if (!parsed || !parsed.data || !Array.isArray(parsed.data)) {
              return reject(new Error("Empty chain: " + data.slice(0, 100)));
            }
            var strikeMap = {},
              spot = 0;
            parsed.data.forEach(function (row) {
              var s = row.strikePrice;
              if (!strikeMap[s])
                strikeMap[s] = { strike: s, ce: null, pe: null };
              spot = row.underlyingValue || spot;
              var side = {
                ltp: row.ltp || 0,
                oi: row.openInterest || 0,
                oiChange: row.changeinOpenInterest || 0,
                volume: row.tradedVolume || 0,
              };
              if (row.optionType === "CE") strikeMap[s].ce = side;
              else if (row.optionType === "PE") strikeMap[s].pe = side;
            });
            var strikes = Object.values(strikeMap)
              .filter(function (r) {
                return r.ce && r.pe;
              })
              .sort(function (a, b) {
                return a.strike - b.strike;
              })
              .filter(function (r) {
                return Math.abs(r.strike - spot) <= 350;
              });
            if (strikes.length < 3)
              return reject(new Error("Not enough strikes"));
            resolve({ spot: spot, expiry: "live", strikes: strikes });
          } catch (e) {
            reject(new Error("Bad JSON: " + data.slice(0, 80)));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function runAnalysis() {
  var p;
  var isLive = false;

  if (session.jwt && session.apiKey) {
    p = fetchLiveChain(session.jwt, session.apiKey)
      .then(function (chain) {
        isLive = true;
        // Save last known good data
        lastKnownChain = chain;
        return chain;
      })
      .catch(function (e) {
        console.log("Live failed:", e.message);
        // FEATURE 1: Use last known data instead of mock
        if (lastKnownChain) {
          console.log("Using last known data (spot:" + lastKnownChain.spot + ")");
          isLive = false;
          return lastKnownChain;
        }
        console.log("No last known data, using mock");
        isLive = false;
        return getMockChain();
      });
  } else {
    // No session — use last known if available, else mock
    if (lastKnownChain) {
      isLive = false;
      p = Promise.resolve(lastKnownChain);
    } else {
      isLive = false;
      p = Promise.resolve(getMockChain());
    }
  }

  return p.then(function (chain) {
    var pcr = calcPCR(chain);
    var result = {
      timestamp: new Date().toISOString(),
      spot: chain.spot,
      expiry: chain.expiry,
      isLive: isLive,
      sr: findSupportResistance(chain),
      pcr: pcr,
      sentiment: calcSentiment(pcr),
      alphas: rankAlphaStrikes(chain),
      optionIntel: calcOptionIntel(chain, pcr),
      trades: getTradesSummary(chain),
    };
    // Cache the result
    lastKnownResult = result;
    return result;
  });
}

// ── WebSocket ──
function wsHandshake(req, socket) {
  var key = req.headers["sec-websocket-key"];
  var accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );
}

function wsEncode(data) {
  var msg = Buffer.from(data);
  var len = msg.length;
  var buf =
    len < 126
      ? Buffer.allocUnsafe(2 + len)
      : Buffer.allocUnsafe(4 + len);
  buf[0] = 0x81;
  if (len < 126) {
    buf[1] = len;
    msg.copy(buf, 2);
  } else {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    msg.copy(buf, 4);
  }
  return buf;
}

function wsSend(socket, obj) {
  try {
    socket.write(wsEncode(JSON.stringify(obj)));
  } catch (e) {}
}

function broadcast(obj) {
  clients.forEach(function (s) {
    wsSend(s, obj);
  });
}

server.on("upgrade", function (req, socket) {
  if (req.headers["upgrade"] !== "websocket") {
    socket.destroy();
    return;
  }
  wsHandshake(req, socket);
  clients.push(socket);
  console.log("WS connected, clients:", clients.length);
  runAnalysis().then(function (r) {
    wsSend(socket, { type: "analysis", ...r });
  });
  socket.on("close", function () {
    clients = clients.filter(function (s) {
      return s !== socket;
    });
  });
  socket.on("error", function () {
    clients = clients.filter(function (s) {
      return s !== socket;
    });
  });
});

function pollAndBroadcast() {
  runAnalysis()
    .then(function (r) {
      console.log(
        "SPOT:" +
          r.spot +
          " BIAS:" +
          r.sentiment.bias +
          " PCR:" +
          r.pcr.overall.oiPCR +
          " LIVE:" +
          r.isLive
      );
      broadcast({ type: "analysis", ...r });
    })
    .catch(function (e) {
      console.error("Poll error:", e.message);
    });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAndBroadcast();
  pollTimer = setInterval(pollAndBroadcast, 30000);
}

// ── ROUTES ──

// Session endpoint (frontend sends JWT)
app.post("/session", function (req, res) {
  var jwt = req.body.jwt;
  var apiKey = req.body.apiKey;
  var clientId = req.body.clientId;
  if (!jwt || !apiKey)
    return res
      .status(400)
      .json({ success: false, message: "jwt and apiKey required" });
  session.jwt = jwt;
  session.apiKey = apiKey;
  session.clientId = clientId || "unknown";
  console.log("Session set for:", session.clientId);
  startPolling();
  res.json({ success: true, message: "Session active. Live data starting." });
});

// FEATURE 3: Strike Analysis endpoint
app.post("/analyse-strike", function (req, res) {
  var strikePrice = parseFloat(req.body.strike);
  if (!strikePrice || isNaN(strikePrice))
    return res.status(400).json({ error: "Valid strike price required" });

  // Use last known chain or mock
  var chain = lastKnownChain || getMockChain();
  var pcr = calcPCR(chain);
  var sentiment = calcSentiment(pcr);
  var result = analyseStrike(chain, strikePrice, pcr, sentiment);
  res.json(result);
});

// Option Intelligence endpoint
app.get("/option-intel", function (req, res) {
  var chain = lastKnownChain || getMockChain();
  var pcr = calcPCR(chain);
  res.json(calcOptionIntel(chain, pcr));
});

// ── PAPER TRADE ENDPOINTS ──

// Open a new paper trade
app.post("/trade/open", function (req, res) {
  var strike = parseFloat(req.body.strike);
  var side = (req.body.side || "").toUpperCase();
  var entryPrice = parseFloat(req.body.entryPrice);

  if (!strike || !side || !entryPrice || isNaN(entryPrice)) {
    return res.status(400).json({ error: "strike, side (CE/PE), and entryPrice required" });
  }
  if (side !== "CE" && side !== "PE") {
    return res.status(400).json({ error: "side must be CE or PE" });
  }

  var trade = {
    id: tradeIdCounter++,
    strike: strike,
    side: side,
    entryPrice: entryPrice,
    currentLTP: entryPrice,
    entryTime: new Date().toISOString(),
    status: "OPEN",
    pnl: 0,
    pnlPct: 0,
    exitPrice: null,
    exitTime: null,
    holdDuration: null,
  };
  trades.push(trade);
  console.log("TRADE OPENED: #" + trade.id + " " + side + " " + strike + " @ " + entryPrice);

  // Immediately broadcast updated trades
  var chain = lastKnownChain || getMockChain();
  var summary = getTradesSummary(chain);
  broadcast({ type: "trades-update", trades: summary });

  res.json({ success: true, trade: trade });
});

// Close an open paper trade
app.post("/trade/close", function (req, res) {
  var tradeId = parseInt(req.body.tradeId);
  if (!tradeId) return res.status(400).json({ error: "tradeId required" });

  var trade = null;
  for (var i = 0; i < trades.length; i++) {
    if (trades[i].id === tradeId && trades[i].status === "OPEN") {
      trade = trades[i];
      break;
    }
  }
  if (!trade) return res.status(404).json({ error: "Open trade not found" });

  var chain = lastKnownChain || getMockChain();
  var exitPrice = getLTP(chain, trade.strike, trade.side);

  trade.status = "CLOSED";
  trade.exitPrice = exitPrice;
  trade.exitTime = new Date().toISOString();
  trade.pnl = parseFloat(((exitPrice - trade.entryPrice) * LOT_SIZE).toFixed(2));
  trade.pnlPct = trade.entryPrice > 0 ? parseFloat((((exitPrice - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2)) : 0;

  // Calculate hold duration
  var ms = new Date(trade.exitTime) - new Date(trade.entryTime);
  var mins = Math.floor(ms / 60000);
  trade.holdDuration = mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m";

  console.log("TRADE CLOSED: #" + trade.id + " P&L: " + trade.pnl + " (" + trade.holdDuration + ")");

  var summary = getTradesSummary(chain);
  broadcast({ type: "trades-update", trades: summary });

  res.json({ success: true, trade: trade, summary: summary });
});

// Get all trades
app.get("/trades", function (req, res) {
  var chain = lastKnownChain || getMockChain();
  res.json(getTradesSummary(chain));
});

app.get("/", function (req, res) {
  res.json({
    status: "EDGE Engine online",
    phase: 4,
    live: !!session.jwt,
    hasLastKnown: !!lastKnownChain,
    clients: clients.length,
  });
});

app.get("/analysis", function (req, res) {
  runAnalysis()
    .then(function (r) {
      res.json(r);
    })
    .catch(function (e) {
      res.status(500).json({ error: e.message });
    });
});

server.listen(PORT, function () {
  console.log("EDGE Engine v5 on port " + PORT);
  startPolling();
});
