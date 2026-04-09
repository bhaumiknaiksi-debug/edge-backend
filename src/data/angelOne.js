// src/data/angelOne.js
// Live Angel One SmartAPI option chain fetcher
// Replaces mock optionChain.js in Phase 3

const axios = require("axios");
const crypto = require("crypto");
const subtle = (crypto.webcrypto && crypto.webcrypto.subtle) || crypto.subtle;

// ── Angel One SmartAPI endpoints ──
const BASE_URL   = "https://apiconnect.angelone.in";
const LOGIN_URL  = `${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`;
const CHAIN_URL  = `${BASE_URL}/rest/secure/angelbroking/marketData/v1/optionChain`;

let authToken  = null;
let tokenExpiry = 0;

// ── Login and get auth token ──
async function getAuthToken() {
  const now = Date.now();
  if (authToken && now < tokenExpiry) return authToken; // reuse if valid

  const payload = {
    clientcode: process.env.ANGEL_CLIENT_ID,
    password:   process.env.ANGEL_PASSWORD,
    totp:       await generateTOTP(process.env.ANGEL_TOTP_SECRET)
  };

  const res = await axios.post(LOGIN_URL, payload, {
    headers: {
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "X-UserType":    "USER",
      "X-SourceID":    "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress":  "00:00:00:00:00:00",
      "X-PrivateKey":  process.env.ANGEL_API_KEY
    }
  });

  if (!res.data?.data?.jwtToken) {
    throw new Error("Angel One login failed: " + JSON.stringify(res.data));
  }

  authToken  = res.data.data.jwtToken;
  tokenExpiry = now + (3 * 60 * 60 * 1000); // token valid ~3 hours
  console.log("✅ Angel One auth token refreshed");
  return authToken;
}

// ── Simple TOTP generator (RFC 6238) ──
async function generateTOTP(secret) {
  if (!subtle) {
    throw new Error("WebCrypto API not available in this Node runtime");
  }
  // Using a minimal TOTP implementation without extra deps
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleanSecret = secret.toUpperCase().replace(/\s/g, "");

  // Decode base32
  let bits = "";
  for (const ch of cleanSecret) {
    const val = base32Chars.indexOf(ch);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const key = new Uint8Array(bytes);

  // Time counter (30s window)
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new Uint8Array(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = tmp & 0xff;
    tmp >>= 8;
  }

  // HMAC-SHA1
  const cryptoKey = await subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = await subtle.sign("HMAC", cryptoKey, counterBytes);
  const hash   = new Uint8Array(sig);
  const offset = hash[19] & 0xf;
  const code   = (
    ((hash[offset]     & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8)  |
     (hash[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, "0");
}

// ── Fetch live NIFTY option chain ──
async function getLiveOptionChain() {
  const token = await getAuthToken();

  const res = await axios.get(CHAIN_URL, {
    params: {
      name:       "NIFTY",
      expirydate: getNearestExpiry()
    },
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "X-UserType":    "USER",
      "X-SourceID":    "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress":  "00:00:00:00:00:00",
      "X-PrivateKey":  process.env.ANGEL_API_KEY
    }
  });

  const data = res.data?.data;
  if (!data) throw new Error("Empty option chain response");

  return transformChain(data);
}

// ── Transform Angel One response → engine format ──
function transformChain(data) {
  const spot    = data.underlyingValue || data.ltp || 0;
  const expiry  = data.expiryDate || getNearestExpiry();
  const strikes = [];

  for (const row of (data.optionChainData || [])) {
    const ce = row.CE || {};
    const pe = row.PE || {};

    strikes.push({
      strike: row.strikePrice,
      ce: {
        ltp:      ce.lastPrice       || 0,
        oi:       ce.openInterest    || 0,
        oiChange: ce.changeinOpenInterest || 0,
        volume:   ce.totalTradedVolume || 0
      },
      pe: {
        ltp:      pe.lastPrice       || 0,
        oi:       pe.openInterest    || 0,
        oiChange: pe.changeinOpenInterest || 0,
        volume:   pe.totalTradedVolume || 0
      }
    });
  }

  // Sort by strike ascending
  strikes.sort((a, b) => a.strike - b.strike);

  return { spot, expiry, strikes };
}

// ── Get nearest weekly expiry (Thursday) ──
function getNearestExpiry() {
  // Use IST for expiry logic so Thursday-evening calls don't return the expired series
  const now    = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day    = istNow.getDay(); // 0=Sun, 4=Thu
  let diff     = (4 - day + 7) % 7; // days until Thursday; 0 means "today"
  // If it's already Thursday and market has closed (after 15:30 IST), advance to next Thursday
  if (diff === 0) {
    const totalMin = istNow.getHours() * 60 + istNow.getMinutes();
    if (totalMin >= 15 * 60 + 30) diff = 7;
  }
  const exp = new Date(now);
  exp.setDate(now.getDate() + diff);

  const dd  = String(exp.getDate()).padStart(2, "0");
  const mm  = ["JAN","FEB","MAR","APR","MAY","JUN",
               "JUL","AUG","SEP","OCT","NOV","DEC"][exp.getMonth()];
  const yy  = exp.getFullYear();
  return `${dd}${mm}${yy}`; // e.g. "10APR2026"
}

module.exports = { getLiveOptionChain };
