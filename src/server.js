// src/server.js — PHASE 4
// Login endpoint + WebSocket streaming + HTTP analysis

const express   = require(“express”);
const { WebSocketServer } = require(“ws”);
const http      = require(“http”);
const axios     = require(“axios”);

const { getOptionChain }        = require(”./data/optionChain”);
const { getLiveOptionChain }    = require(”./data/angelOne”);
const { findSupportResistance } = require(”./engine/oiEngine”);
const { calcPCR }               = require(”./engine/pcrEngine”);
const { calcSentiment }         = require(”./engine/sentimentEngine”);
const { rankAlphaStrikes }      = require(”./engine/strikeEngine”);

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3001;

app.use(express.json());
app.use((req, res, next) => {
res.header(“Access-Control-Allow-Origin”, “*”);
res.header(“Access-Control-Allow-Headers”, “Content-Type”);
res.header(“Access-Control-Allow-Methods”, “GET,POST,OPTIONS”);
if (req.method === “OPTIONS”) return res.sendStatus(200);
next();
});

// ── In-memory session store ──
// { token, clientId, expiresAt }
let session = null;
let pollTimer = null;
let lastResult = null;

// ── Market hours (IST) ──
function isMarketOpen() {
const now = new Date();
const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
const day = ist.getUTCDay();
if (day === 0 || day === 6) return false;
return min >= 555 && min <= 930;
}

// ── TOTP generator ──
async function generateTOTP(secret) {
const base32Chars = “ABCDEFGHIJKLMNOPQRSTUVWXYZ234567”;
const cleanSecret = secret.toUpperCase().replace(/\s/g, “”);
let bits = “”;
for (const ch of cleanSecret) {
bits += base32Chars.indexOf(ch).toString(2).padStart(5, “0”);
}
const bytes = [];
for (let i = 0; i + 8 <= bits.length; i += 8)
bytes.push(parseInt(bits.slice(i, i + 8), 2));
const key     = new Uint8Array(bytes);
const counter = Math.floor(Date.now() / 1000 / 30);
const cb      = new Uint8Array(8);
let tmp = counter;
for (let i = 7; i >= 0; i–) { cb[i] = tmp & 0xff; tmp >>= 8; }
const ck   = await crypto.subtle.importKey(“raw”, key, { name:“HMAC”, hash:“SHA-1” }, false, [“sign”]);
const sig  = new Uint8Array(await crypto.subtle.sign(“HMAC”, ck, cb));
const off  = sig[19] & 0xf;
const code = (((sig[off]&0x7f)<<24)|((sig[off+1]&0xff)<<16)|((sig[off+2]&0xff)<<8)|(sig[off+3]&0xff)) % 1000000;
return code.toString().padStart(6, “0”);
}

// ── Angel One login ──
async function angelLogin(clientId, mpin, totpSecret) {
const totp = await generateTOTP(totpSecret);
const res  = await axios.post(
“https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword”,
{ clientcode: clientId, password: mpin, totp },
{ headers: {
“Content-Type”: “application/json”,
“Accept”:       “application/json”,
“X-UserType”:   “USER”,
“X-SourceID”:   “WEB”,
“X-ClientLocalIP”:  “127.0.0.1”,
“X-ClientPublicIP”: “127.0.0.1”,
“X-MACAddress”: “00:00:00:00:00:00”,
“X-PrivateKey”: process.env.ANGEL_API_KEY || clientId
}}
);
if (!res.data?.data?.jwtToken)
throw new Error(res.data?.message || “Login failed”);
return res.data.data.jwtToken;
}

// ── Run full analysis ──
async function runAnalysis() {
let chain;
let live = false;
if (session && isMarketOpen()) {
try {
chain = await getLiveOptionChain(session.token);
live  = true;
} catch (e) {
console.warn(“⚠️  Live fetch failed:”, e.message);
chain = await getOptionChain();
}
} else {
chain = await getOptionChain();
}

const sr        = findSupportResistance(chain);
const pcr       = calcPCR(chain);
const sentiment = calcSentiment(pcr);
const alphas    = rankAlphaStrikes(chain);

return { timestamp: new Date().toISOString(), live, spot: chain.spot, expiry: chain.expiry, sr, pcr, sentiment, alphas };
}

// ── Broadcast to all WS clients ──
function broadcast(data) {
const msg = JSON.stringify(data);
wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Poll every 30s ──
async function poll() {
try {
lastResult = await runAnalysis();
broadcast(lastResult);
const r = lastResult;
console.log(`[${new Date().toLocaleTimeString("en-IN")}] ₹${r.spot} | ${r.live?"🟢 LIVE":"🟡 MOCK"} | ${r.sentiment.bias} ${r.sentiment.score}/100`);
} catch (e) {
console.error(“❌ Poll:”, e.message);
}
}

function startPolling() {
if (pollTimer) clearInterval(pollTimer);
poll();
pollTimer = setInterval(poll, 30000);
}

// ── POST /login ──
app.post(”/login”, async (req, res) => {
const { clientId, mpin, totpSecret } = req.body;
if (!clientId || !mpin || !totpSecret)
return res.status(400).json({ error: “clientId, mpin, totpSecret required” });
try {
const token = await angelLogin(clientId, mpin, totpSecret);
session = { token, clientId, expiresAt: Date.now() + 3 * 60 * 60 * 1000 };
console.log(`✅ Logged in: ${clientId}`);
// Restart polling with live data
startPolling();
res.json({ success: true, message: “Logged in to Angel One” });
} catch (e) {
console.error(“❌ Login:”, e.message);
res.status(401).json({ error: e.message });
}
});

// ── GET /analysis ──
app.get(”/analysis”, async (req, res) => {
try {
res.json(lastResult || await runAnalysis());
} catch (e) {
res.status(500).json({ error: e.message });
}
});

// ── GET / ──
app.get(”/”, (req, res) => {
res.json({ status: “EDGE Engine online”, phase: 4, loggedIn: !!session, market: isMarketOpen() });
});

// ── WebSocket ──
wss.on(“connection”, ws => {
console.log(“🔌 WS client connected”);
if (lastResult) ws.send(JSON.stringify(lastResult));
ws.on(“close”, () => console.log(“🔌 WS client disconnected”));
});

// ── Boot ──
server.listen(PORT, () => {
console.log(`\n🚀 EDGE Engine v4 on port ${PORT}`);
console.log(`📡 WebSocket + HTTP ready`);
console.log(`⏰ Market: ${isMarketOpen() ? "OPEN 🟢" : "CLOSED 🟡"}\n`);
startPolling(); // starts with mock, goes live after login
});
