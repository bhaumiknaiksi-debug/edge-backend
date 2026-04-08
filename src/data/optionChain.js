// src/data/optionChain.js
// Phase 3: Live Angel One fetch with mock fallback

const https = require("https");

// ── Angel One login ──
async function angelLogin() {
  const body = JSON.stringify({
    clientcode: process.env.ANGEL_CLIENT_ID,
    password:   process.env.ANGEL_PASSWORD,
    totp:       process.env.ANGEL_TOTP_SECRET
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "apiconnect.angelone.in",
      path:     "/rest/auth/angelbroking/user/v1/loginByPassword",
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "X-API-KEY":     process.env.ANGEL_API_KEY,
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress":  "00:00:00:00:00:00",
        "X-SourceID": "WEB",
        "X-PrivateKey":  process.env.ANGEL_API_KEY,
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Fetch live option chain ──
async function fetchLiveChain(token) {
  const params = new URLSearchParams({
    exchange: "NFO",
    symboltoken: "99926000",
    expiry: "",
    strike: "-1",
    optiontype: "CE"
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "apiconnect.angelone.in",
      path:     `/rest/secure/angelbroking/market/v1/optionGreek?${params}`,
      method:   "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "X-API-KEY":     process.env.ANGEL_API_KEY,
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress":  "00:00:00:00:00:00",
        "X-PrivateKey":  process.env.ANGEL_API_KEY,
        "Accept":        "application/json"
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Parse Angel One response into our format ──
function parseChain(raw) {
  if (!raw?.data || !Array.isArray(raw.data)) return null;

  const strikeMap = {};
  let spot = 0;

  for (const row of raw.data) {
    const s = row.strikePrice;
    if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };
    if (row.optionType === "CE") {
      spot = row.underlyingValue || spot;
      strikeMap[s].ce = {
        ltp: row.ltp || 0,
        oi:  row.openInterest || 0,
        oiChange: row.changeinOpenInterest || 0,
        volume: row.tradedVolume || 0
      };
    } else if (row.optionType === "PE") {
      strikeMap[s].pe = {
        ltp: row.ltp || 0,
        oi:  row.openInterest || 0,
        oiChange: row.changeinOpenInterest || 0,
        volume: row.tradedVolume || 0
      };
    }
  }

  // Only keep strikes with both CE and PE
  const strikes = Object.values(strikeMap)
    .filter(r => r.ce && r.pe)
    .sort((a, b) => a.strike - b.strike)
    // Keep 7 strikes around ATM
    .filter(r => Math.abs(r.strike - spot) <= 350);

  return { spot, expiry: "live", strikes };
}

// ── Mock fallback ──
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

// ── Main export ──
async function getOptionChain() {
  const hasCredentials = process.env.ANGEL_API_KEY &&
                         process.env.ANGEL_CLIENT_ID &&
                         process.env.ANGEL_PASSWORD;

  if (!hasCredentials) {
    console.log("⚠️  No Angel One credentials — using mock data");
    return getMockChain();
  }

  try {
    console.log("🔄 Fetching live Angel One data...");
    const loginRes = await angelLogin();
    const token    = loginRes?.data?.jwtToken;
    if (!token) throw new Error("Login failed: " + JSON.stringify(loginRes));

    const raw    = await fetchLiveChain(token);
    const chain  = parseChain(raw);
    if (!chain || chain.strikes.length < 3) throw new Error("Empty option chain response");

    console.log(`✅ Live data: spot ₹${chain.spot}, ${chain.strikes.length} strikes`);
    return chain;

  } catch (err) {
    console.log(`⚠️  Live fetch failed, using mock: ${err.message}`);
    return getMockChain();
  }
}

module.exports = { getOptionChain };
