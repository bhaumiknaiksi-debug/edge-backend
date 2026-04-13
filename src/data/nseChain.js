// src/data/nseChain.js
// Fetches NIFTY option chain from NSE website (no auth, no IP restrictions)
// NSE requires: 1) visit homepage to get cookies, 2) use cookies on API call

const https = require("https");

var cookieCache = { value: null, fetchedAt: 0 };

function httpsGet(url, headers) {
  return new Promise(function(resolve, reject) {
    var opts = Object.assign({ method: "GET" }, require("url").parse(url));
    opts.headers = headers;
    var req = https.request(opts, function(res) {
      var body = "";
      res.on("data", function(c) { body += c; });
      res.on("end", function() { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    });
    req.on("error", reject);
    req.setTimeout(10000, function() { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

// Step 1: Hit NSE homepage to get session cookies
async function getCookies() {
  var now = Date.now();
  if (cookieCache.value && now - cookieCache.fetchedAt < 300000) {
    return cookieCache.value; // reuse cookies for 5 minutes
  }
  try {
    var res = await httpsGet("https://www.nseindia.com/", {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive"
    });
    var setCookie = res.headers["set-cookie"] || [];
    var cookies = setCookie.map(function(c) { return c.split(";")[0]; }).join("; ");
    if (cookies) {
      cookieCache.value = cookies;
      cookieCache.fetchedAt = now;
      console.log("NSE cookies refreshed");
    }
    return cookies;
  } catch(e) {
    console.log("Cookie fetch failed:", e.message);
    return cookieCache.value || "";
  }
}

// Step 2: Fetch option chain with cookies
async function fetchNSEChain() {
  var cookies = await getCookies();
  var res = await httpsGet("https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY", {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.nseindia.com/option-chain",
    "X-Requested-With": "XMLHttpRequest",
    "Connection": "keep-alive",
    "Cookie": cookies
  });

  if (res.status === 401 || res.status === 403) {
    cookieCache.value = null; // force refresh next time
    throw new Error("NSE auth failed " + res.status + " - cookies expired");
  }

  if (res.status !== 200) {
    throw new Error("NSE returned " + res.status);
  }

  var data;
  try { data = JSON.parse(res.body); }
  catch(e) { throw new Error("NSE bad JSON: " + res.body.slice(0, 80)); }

  return data;
}

// Step 3: Parse NSE response into EDGE chain format
function parseNSEChain(data) {
  if (!data || !data.records || !data.records.data) {
    throw new Error("NSE unexpected format");
  }

  var spot = data.records.underlyingValue || 0;
  var expiry = data.records.expiryDates && data.records.expiryDates[0];

  var strikeMap = {};
  data.records.data.forEach(function(row) {
    if (row.expiryDate !== expiry) return; // only nearest expiry
    var s = row.strikePrice;
    if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };

    if (row.CE) {
      strikeMap[s].ce = {
        ltp:       row.CE.lastPrice     || 0,
        oi:        row.CE.openInterest  || 0,
        oiChange:  row.CE.changeinOpenInterest || 0,
        volume:    row.CE.totalTradedVolume    || 0
      };
    }
    if (row.PE) {
      strikeMap[s].pe = {
        ltp:       row.PE.lastPrice     || 0,
        oi:        row.PE.openInterest  || 0,
        oiChange:  row.PE.changeinOpenInterest || 0,
        volume:    row.PE.totalTradedVolume    || 0
      };
    }
  });

  var strikes = Object.values(strikeMap)
    .filter(function(r) { return r.ce && r.pe; })
    .sort(function(a, b) { return a.strike - b.strike; })
    .filter(function(r) { return Math.abs(r.strike - spot) <= 500; });

  if (strikes.length < 3) throw new Error("Not enough strikes parsed: " + strikes.length);

  console.log("NSE chain: spot=" + spot + " expiry=" + expiry + " strikes=" + strikes.length);
  return { spot: spot, expiry: expiry || "live", strikes: strikes };
}

async function getNSEChain() {
  var data = await fetchNSEChain();
  return parseNSEChain(data);
}

module.exports = { getNSEChain };
