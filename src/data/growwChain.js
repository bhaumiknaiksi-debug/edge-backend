// src/data/growwChain.js
// Fetches NIFTY option chain from Groww API
// Auth: API Key + Secret -> SHA256 checksum -> access token (valid ~24h)

const https  = require("https");
const crypto = require("crypto");

// -- Token cache --
var tokenCache = { value: null, expiry: 0 };

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise(function(resolve, reject) {
    var opts = { hostname: hostname, path: path, method: method, headers: headers };
    var req = https.request(opts, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error("JSON parse failed: " + data.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, function() { req.destroy(new Error("Timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Generate checksum: SHA256(secret + timestamp)
function generateChecksum(secret, timestamp) {
  return crypto.createHash("sha256")
    .update(secret + timestamp)
    .digest("hex");
}

// Get access token (cached until expiry)
async function getAccessToken() {
  var now = Date.now();
  if (tokenCache.value && now < tokenCache.expiry) {
    return tokenCache.value;
  }

  var apiKey    = process.env.GROWW_API_KEY;
  var apiSecret = process.env.GROWW_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("GROWW_API_KEY and GROWW_API_SECRET not set in env");
  }

  var timestamp = String(Math.floor(now / 1000));
  var checksum  = generateChecksum(apiSecret, timestamp);

  var res = await httpsRequest(
    "api.groww.in",
    "/v1/token/api/access",
    "POST",
    {
      "Authorization": "Bearer " + apiKey,
      "Content-Type":  "application/json",
      "X-API-VERSION": "1.0"
    },
    { key_type: "approval", checksum: checksum, timestamp: timestamp }
  );

  if (res.status !== 200 || !res.body.token) {
    throw new Error("Groww auth failed: " + JSON.stringify(res.body));
  }

  // Cache token ? expires at midnight, refresh 5 min early
  var expiry = new Date();
  expiry.setHours(23, 55, 0, 0); // 11:55 PM today
  if (expiry < new Date()) expiry.setDate(expiry.getDate() + 1); // next day

  tokenCache.value  = res.body.token;
  tokenCache.expiry = expiry.getTime();
  console.log("Groww token refreshed, expires at " + expiry.toISOString());

  return tokenCache.value;
}

// Get nearest expiry -- NIFTY weekly expires every Thursday
function getNearestExpiry(skipWeeks) {
  skipWeeks = skipWeeks || 0;
  var now   = new Date();
  var istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  var ist   = new Date(istMs);
  var day   = ist.getUTCDay();
  var mins  = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  var daysToThursday = (4 - day + 7) % 7;

  // On expiry day (Thursday), always move to next week
  // Groww returns empty strikes for settling contracts
  if (daysToThursday === 0) daysToThursday = 7;

  // skipWeeks allows fetching further-dated expiries as fallback
  daysToThursday += skipWeeks * 7;

  var expiry = new Date(istMs + daysToThursday * 86400000);
  var y = expiry.getUTCFullYear();
  var m = String(expiry.getUTCMonth() + 1).padStart(2, "0");
  var d = String(expiry.getUTCDate()).padStart(2, "0");
  var result = y + "-" + m + "-" + d;
  console.log("Expiry calc: IST day=" + day + " daysToThursday=" + daysToThursday + " expiry=" + result);
  return result;
}

// Fetch option chain from Groww ? with fallback to next expiry
async function fetchGrowwChain() {
  var token = await getAccessToken();

  // Try current expiry first, then next week as fallback
  for (var attempt = 0; attempt < 2; attempt++) {
    var expiry = getNearestExpiry(attempt);
    console.log("Groww: fetching NIFTY chain for expiry=" + expiry + (attempt > 0 ? " (fallback)" : ""));

    var res = await httpsRequest(
      "api.groww.in",
      "/v1/option-chain/exchange/NSE/underlying/NIFTY?expiry_date=" + expiry,
      "GET",
      {
        "Authorization": "Bearer " + token,
        "Accept":        "application/json",
        "X-API-VERSION": "1.0"
      },
      null
    );

    if (res.status === 401 || res.status === 403) {
      tokenCache.value = null;
      throw new Error("Groww auth expired - refreshing token");
    }

    if (res.status !== 200) {
      throw new Error("Groww returned HTTP " + res.status + ": " + JSON.stringify(res.body).slice(0, 100));
    }

    if (!res.body || res.body.status !== "SUCCESS" || !res.body.payload) {
      throw new Error("Groww bad response: " + JSON.stringify(res.body).slice(0, 200));
    }

    var payload = res.body.payload;
    var strikeCount = Object.keys(payload.strikes || {}).length;
    console.log("Groww payload: underlying_ltp=" + payload.underlying_ltp + " strikes_count=" + strikeCount);

    if (strikeCount > 0) {
      return { data: payload, expiry: expiry };
    }

    console.log("Groww: empty strikes for " + expiry + " - trying next expiry");
  }

  throw new Error("Groww: no strikes found for any expiry");
}

// Parse Groww response into EDGE chain format
function parseGrowwChain(payload, expiry) {
  var spot = payload.underlying_ltp || 0;
  // Try all possible key names Groww might use
  var strikes = payload.strikes || payload.optionChain || payload.option_chain || payload.data || {};

  if (!spot) throw new Error("Groww: no spot price in payload");

  if (Object.keys(strikes).length === 0) {
    // Log full payload for debugging (truncated)
    console.log("Groww payload dump: " + JSON.stringify(payload).slice(0, 500));
    throw new Error("Groww: empty strikes (keys=" + Object.keys(payload).join(",") + ")");
  }

  var result = [];
  Object.keys(strikes).forEach(function(strikeStr) {
    var s   = parseInt(strikeStr);
    var row = strikes[strikeStr];
    if (!row.CE || !row.PE) return;
    if (Math.abs(s - spot) > 500) return; // only near ATM

    result.push({
      strike: s,
      ce: {
        ltp:      row.CE.ltp            || 0,
        oi:       row.CE.open_interest  || 0,
        oiChange: 0, // Groww doesn't provide OI change in this endpoint
        volume:   row.CE.volume         || 0
      },
      pe: {
        ltp:      row.PE.ltp            || 0,
        oi:       row.PE.open_interest  || 0,
        oiChange: 0,
        volume:   row.PE.volume         || 0
      }
    });
  });

  result.sort(function(a, b) { return a.strike - b.strike; });

  if (result.length < 3) {
    throw new Error("Groww: not enough strikes parsed: " + result.length);
  }

  console.log("Groww chain OK: spot=" + spot + " expiry=" + expiry + " strikes=" + result.length);
  return { spot: spot, expiry: expiry, strikes: result };
}

async function getGrowwChain() {
  var res = await fetchGrowwChain();
  return parseGrowwChain(res.data, res.expiry);
}

module.exports = { getGrowwChain };
