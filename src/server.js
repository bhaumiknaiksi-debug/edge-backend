// src/server.js - EDGE Phase 3 with login endpoint

const express = require("express");
const http    = require("http");
const https   = require("https");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server;

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");
const { getMockChain }          = require("./data/optionChain");

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
let session = { jwt: null, feedToken: null, clientId: null };
let pollTimer = null;

// -- Angel One API call helper --
function angelRequest(path, method, body, jwt) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
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

    const req = https.request({
      hostname: "apiconnect.angelone.in",
      path, method, headers
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// -- Fetch live option chain --
async function fetchLiveChain(jwt) {
  const res = await angelRequest(
    "/rest/secure/angelbroking/market/v1/optionGreek?exchange=NFO&symboltoken=99926000&expiry=&strike=-1&optiontype=CE",
    "GET", null, jwt
  );

  if (!res?.data || !Array.isArray(res.data)) throw new Error("Empty chain: " + JSON.stringify(res).slice(0, 100));

  const strikeMap = {};
  let spot = 0;

  for (const row of res.data) {
    const s = row.strikePrice;
    if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };
    spot = row.underlyingValue || spot;
    const side = {
      ltp: row.ltp || 0,
      oi: row.openInterest || 0,
      oiChange: row.changeinOpenInterest || 0,
      volume: row.tradedVolume || 0
    };
    if (row.optionType === "CE") strikeMap[s].ce = side;
    else if (row.optionType === "PE") strikeMap[s].pe = side;
  }

  const strikes = Object.values(strikeMap)
    .filter(r => r.ce && r.pe)
    .sort((a, b) => a.strike - b.strike)
    .filter(r => Math.abs(r.strike - spot) <= 350);

  if (strikes.length < 3) throw new Error("Not enough strikes");
  return { spot, expiry: "live", strikes };
}

// -- Run analysis --
async function runAnalysis() {
  let chain;
  if (session.jwt) {
    try {
      chain = await fetchLiveChain(session.jwt);
    } catch(err) {
      console.log("Live fetch failed, using mock:", err.message);
      chain = getMockChain();
    }
  } else {
    chain = getMockChain();
  }
  const sr        = findSupportResistance(chain);
  const pcr       = calcPCR(chain);
  const sentiment = calcSentiment(pcr);
  const alphas    = rankAlphaStrikes(chain);
  return { timestamp: new Date().toISOString(), spot: chain.spot, expiry: chain.expiry, sr, pcr, sentiment, alphas };
}

// -- Broadcast --
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

async function pollAndBroadcast() {
  try {
    const result = await runAnalysis();
    console.log(`SPOT: ${result.spot} | BIAS: ${result.sentiment.bias} | PCR: ${result.pcr.overall.oiPCR}`);
    broadcast({ type: "analysis", ...result });
  } catch(err) {
    console.error("Poll error:", err.message);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAndBroadcast();
  pollTimer = setInterval(pollAndBroadcast, 30000);
}

// -- LOGIN endpoint --
app.post("/login", async (req, res) => {
  const { clientId, pin, totp } = req.body;
  if (!clientId || !pin || !totp) {
    return res.status(400).json({ success: false, message: "clientId, pin and totp required" });
  }

  try {
    const loginRes = await angelRequest(
      "/rest/auth/angelbroking/user/v1/loginByPassword",
      "POST",
      { clientcode: clientId, password: pin, totp }
    );

    if (!loginRes?.data?.jwtToken) {
      return res.status(401).json({ success: false, message: loginRes?.message || "Login failed" });
    }

    session.jwt       = loginRes.data.jwtToken;
    session.feedToken = loginRes.data.feedToken;
    session.clientId  = clientId;

    console.log("? Logged in:", clientId);
    startPolling();

    res.json({ success: true, message: "Logged in. Live data active." });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -- WebSocket --
wss.on("connection", async (ws) => {
  console.log("Client connected");
  try {
    const result = await runAnalysis();
    ws.send(JSON.stringify({ type: "analysis", ...result }));
  } catch(err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
  ws.on("close", () => console.log("Client disconnected"));
});

// -- REST --
app.get("/", (req, res) => res.json({ status: "EDGE Engine online", phase: 3, live: !!session.jwt }));
app.get("/analysis", async (req, res) => {
  try { res.json(await runAnalysis()); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// -- Start --
server.listen(PORT, () => {
  console.log(`EDGE Engine v3 on port ${PORT}`);
  startPolling();
});
