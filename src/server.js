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
var sessionOwner = null;
var sessionValidationInFlight = false;
var sessionValidationOwner = null;
var pollTimer = null;
var TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || "900000", 10); // 15m default
var lastActivity = Date.now();
var lastLiveSpot = null;
var dailyClose = { date: null, spot: null };

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

function markActivity() {
  lastActivity = Date.now();
}

function clearActiveSession(reason) {
  session = { jwt: null, clientId: null, apiKey: null };
  sessionOwner = null;
  sessionValidationInFlight = false;
  sessionValidationOwner = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (reason) console.log("Session cleared:", reason);
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

function getNearestExpiry() {
  // Angel One expects expiry in DDMMMYYYY format (e.g. 10APR2026)
  var now = new Date();
  var istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  var day = istNow.getDay(); // 0=Sun, 4=Thu
  var diff = (4 - day + 7) % 7;
  if (diff === 0) {
    var totalMin = istNow.getHours() * 60 + istNow.getMinutes();
    if (totalMin >= 15 * 60 + 30) diff = 7;
  }

  var exp = new Date(now);
  exp.setDate(now.getDate() + diff);
  var dd = String(exp.getDate()).padStart(2, "0");
  var mm = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][exp.getMonth()];
  var yyyy = exp.getFullYear();
  return dd + mm + yyyy;
}

function buildBrokerHeaders(jwt, apiKey) {
  return {
    Authorization: "Bearer " + String(jwt || "").trim(),
    "Content-Type": "application/json",
    "X-ClientLocalIP": process.env.ANGEL_CLIENT_LOCAL_IP || "127.0.0.1",
    "X-ClientPublicIP": process.env.ANGEL_CLIENT_PUBLIC_IP || "127.0.0.1",
    "X-MACAddress": process.env.ANGEL_MAC_ADDRESS || "02:00:00:00:00:01",
    "X-PrivateKey": String(apiKey || "").trim(),
    "X-SourceID": "WEB",
    Accept: "application/json",
  };
}

// Fetch option chain using JWT
function fetchGreekSide(jwt, apiKey, optionType) {
  return new Promise(function (resolve, reject) {
    var headers = buildBrokerHeaders(jwt, apiKey);
    var expiry = getNearestExpiry();
    var req = https.request(
      {
        hostname: "apiconnect.angelone.in",
        path:
          "/rest/secure/angelbroking/market/v1/optionGreek?exchange=NFO&symboltoken=99926000&expiry=" +
          encodeURIComponent(expiry) +
          "&strike=-1&optiontype=" +
          optionType,
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
              var brokerMessage =
                (parsed && (parsed.message || parsed.errorcode || parsed.status)) ||
                "Unknown upstream error";
              return reject(
                new Error(
                  "Live " +
                    optionType +
                    " fetch failed: " +
                    brokerMessage +
                    " | " +
                    data.slice(0, 100)
                )
              );
            }
            resolve(parsed.data);
          } catch (e) {
            reject(new Error("Bad " + optionType + " JSON: " + data.slice(0, 80)));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function fetchLiveChain(jwt, apiKey) {
  return Promise.all([
    fetchGreekSide(jwt, apiKey, "CE"),
    fetchGreekSide(jwt, apiKey, "PE"),
  ]).then(function (parts) {
    var allRows = parts[0].concat(parts[1]);
    var strikeMap = {},
      spot = 0;
    allRows.forEach(function (row) {
      var s = row.strikePrice;
      if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };
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
    if (strikes.length < 3) throw new Error("Not enough strikes");
    return { spot: spot, expiry: "live", strikes: strikes };
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
        // Prefer last known live data. Do not switch to mock while authenticated.
        if (lastKnownChain) {
          console.log("Using last known data (spot:" + lastKnownChain.spot + ")");
          isLive = false;
          return lastKnownChain;
        }
        throw new Error(
          "Live session active but no valid chain available. " +
            "Please re-authenticate. Root cause: " +
            e.message
        );
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
    if (isLive && chain && typeof chain.spot === "number") {
      lastLiveSpot = chain.spot;
    }

    var marketState = getMarketStateIST();
    if (marketState.isClosed) {
      if (
        marketState.isAfterClose &&
        dailyClose.date !== marketState.tradingDate &&
        typeof lastLiveSpot === "number"
      ) {
        dailyClose = { date: marketState.tradingDate, spot: lastLiveSpot };
      }
    } else if (dailyClose.date !== marketState.tradingDate) {
      // New trading day opened; reset stored close.
      dailyClose = { date: marketState.tradingDate, spot: null };
    }

    var marketClosePoint =
      typeof dailyClose.spot === "number"
        ? dailyClose.spot
        : (lastKnownResult && lastKnownResult.marketClosePoint) || chain.spot;

    var pcr = calcPCR(chain);
    var result = {
      timestamp: new Date().toISOString(),
      spot: chain.spot,
      expiry: chain.expiry,
      isLive: isLive,
      market: {
        isOpen: marketState.isOpen,
        isClosed: marketState.isClosed,
        session: marketState.session,
        tradingDate: marketState.tradingDate,
      },
      marketClosePoint: marketClosePoint,
      closePoint: marketClosePoint,
      closingPoint: marketClosePoint,
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

function getMarketStateIST(nowUtc) {
  var now = nowUtc ? new Date(nowUtc) : new Date();
  // IST = UTC + 5:30 (330 minutes). Compute directly — avoids toLocaleString parsing bugs.
  var istMs = now.getTime() + (330 * 60 * 1000);
  var istNow = new Date(istMs);
  var day = istNow.getUTCDay(); // 0 Sun, 6 Sat
  var hour = istNow.getUTCHours();
  var min = istNow.getUTCMinutes();
  var totalMin = hour * 60 + min;
  var openMin = 9 * 60 + 15;
  var closeMin = 15 * 60 + 30;
  var isWeekend = day === 0 || day === 6;
  var isOpen = !isWeekend && totalMin >= openMin && totalMin <= closeMin;
  var isAfterClose = !isWeekend && totalMin > closeMin;
  var session = isWeekend
    ? "WEEKEND"
    : isOpen
      ? "OPEN"
      : isAfterClose
        ? "POST_CLOSE"
        : "PRE_OPEN";

  var yyyy = istNow.getUTCFullYear();
  var mm = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  var dd = String(istNow.getUTCDate()).padStart(2, "0");
  return {
    isOpen: isOpen,
    isClosed: !isOpen,
    isAfterClose: isAfterClose,
    session: session,
    tradingDate: yyyy + "-" + mm + "-" + dd,
  };
}

// ── WebSocket ──
function wsHandshake(req, socket) {
  var key = req.headers["sec-websocket-key"];
  if (!key) return false;
  var accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );
  return true;
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

function pruneSocket(socket) {
  clients = clients.filter(function (s) {
    return s !== socket;
  });
  if (clients.length === 0) {
    clearActiveSession("all websocket clients disconnected");
  }
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
  if (!wsHandshake(req, socket)) {
    socket.destroy();
    return;
  }
  markActivity();
  clients.push(socket);
  console.log("WS connected, clients:", clients.length);
  runAnalysis().then(function (r) {
    wsSend(socket, { type: "analysis", ...r });
  });
  socket.on("close", function () {
    pruneSocket(socket);
  });
  socket.on("error", function () {
    pruneSocket(socket);
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
  markActivity();
  var jwt = String(req.body.jwt || "").trim();
  var apiKey = String(req.body.apiKey || "").trim();
  var clientId = req.body.clientId;
  if (!jwt || !apiKey)
    return res
      .status(400)
      .json({ success: false, message: "jwt and apiKey required" });
  var incomingClientId = clientId || "unknown";
  if (sessionValidationInFlight && sessionValidationOwner !== incomingClientId) {
    return res.status(409).json({
      success: false,
      message:
        "Session validation is in progress for another client. Retry after it completes.",
    });
  }
  if (sessionOwner && sessionOwner !== incomingClientId) {
    return res.status(409).json({
      success: false,
      message:
        "A session is already active for another client. Reuse the same clientId to rotate credentials.",
    });
  }

  // Validate credentials immediately to avoid false-success + mock fallback.
  sessionValidationInFlight = true;
  sessionValidationOwner = incomingClientId;
  fetchLiveChain(jwt, apiKey)
    .then(function (chain) {
      session.clientId = incomingClientId;
      sessionOwner = incomingClientId;
      session.jwt = jwt;
      session.apiKey = apiKey;
      lastKnownChain = chain;
      lastLiveSpot = chain.spot;
      console.log("Session validated for:", session.clientId);
      startPolling();
      res.json({
        success: true,
        message: "Session active. Live data connected.",
        spot: chain.spot,
      });
    })
    .catch(function (e) {
      res.status(401).json({
        success: false,
        message: "Broker authentication failed. Check API key/JWT/TOTP setup.",
        details: e.message,
      });
    })
    .finally(function () {
      if (sessionValidationOwner === incomingClientId) {
        sessionValidationInFlight = false;
        sessionValidationOwner = null;
      }
    });
});

app.delete("/session", function (req, res) {
  markActivity();
  var clientId = (req.body && req.body.clientId) || req.query.clientId;
  if (!clientId) {
    return res.status(400).json({ success: false, message: "clientId required" });
  }
  if (!sessionOwner || sessionOwner !== clientId) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: only active session owner can clear the session",
    });
  }
  clearActiveSession("deleted by session owner");
  res.json({ success: true, message: "Session cleared" });
});

// FEATURE 3: Strike Analysis endpoint
app.post("/analyse-strike", function (req, res) {
  markActivity();
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
  markActivity();
  var chain = lastKnownChain || getMockChain();
  var pcr = calcPCR(chain);
  res.json(calcOptionIntel(chain, pcr));
});

// ── PAPER TRADE ENDPOINTS ──

// Open a new paper trade
app.post("/trade/open", function (req, res) {
  markActivity();
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
  markActivity();
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
  markActivity();
  var chain = lastKnownChain || getMockChain();
  res.json(getTradesSummary(chain));
});

app.get("/", function (req, res) {
  markActivity();
  res.json({
    status: "EDGE Engine online",
    phase: 4,
    live: !!session.jwt,
    hasLastKnown: !!lastKnownChain,
    clients: clients.length,
  });
});

app.get("/analysis", function (req, res) {
  markActivity();
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

setInterval(function () {
  if (!sessionOwner) return;
  var idleMs = Date.now() - lastActivity;
  if (idleMs > TIMEOUT_MS) {
    clearActiveSession("inactivity timeout (" + idleMs + "ms)");
  }
}, 60000);
