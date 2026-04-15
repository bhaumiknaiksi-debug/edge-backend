// src/data/nseChain.js
// Fetches NIFTY option chain from NSE website
// NSE requires: cookies from homepage + gzip decompression

const https = require("https");
const zlib  = require("zlib");

var cookieCache = { value: null, fetchedAt: 0 };

function httpsGet(url, headers) {
  return new Promise(function(resolve, reject) {
    var parsed = require("url").parse(url);
    var opts = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   "GET",
      headers:  headers
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        var buf = Buffer.concat(chunks);
        var encoding = res.headers["content-encoding"] || "";
        if (encoding.indexOf("gzip") >= 0) {
          zlib.gunzip(buf, function(err, decoded) {
            if (err) return reject(new Error("gzip decode failed: " + err.message));
            resolve({ status: res.statusCode, headers: res.headers, body: decoded.toString("utf8") });
          });
        } else if (encoding.indexOf("br") >= 0) {
          zlib.brotliDecompress(buf, function(err, decoded) {
            if (err) return reject(new Error("brotli decode failed: " + err.message));
            resolve({ status: res.statusCode, headers: res.headers, body: decoded.toString("utf8") });
          });
        } else if (encoding.indexOf("deflate") >= 0) {
          zlib.inflate(buf, function(err, decoded) {
            if (err) return reject(new Error("deflate decode failed: " + err.message));
            resolve({ status: res.statusCode, headers: res.headers, body: decoded.toString("utf8") });
          });
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8") });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function() { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

var BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Cache-Control": "no-cache"
};

async function getCookies() {
  var now = Date.now();
  if (cookieCache.value && now - cookieCache.fetchedAt < 300000) {
    return cookieCache.value;
  }
  try {
    var res = await httpsGet("https://www.nseindia.com/", Object.assign({}, BASE_HEADERS, {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1"
    }));
    var setCookie = res.headers["set-cookie"] || [];
    var cookies = setCookie.map(function(c) { return c.split(";")[0]; }).join("; ");
    if (cookies) {
      cookieCache.value = cookies;
      cookieCache.fetchedAt = now;
      console.log("NSE cookies refreshed");
    }
    // Also hit the option-chain page to warm up session
    await httpsGet("https://www.nseindia.com/option-chain", Object.assign({}, BASE_HEADERS, {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": cookies
    }));
    return cookies;
  } catch(e) {
    console.log("Cookie fetch failed:", e.message);
    return cookieCache.value || "";
  }
}

async function fetchNSEChain() {
  var cookies = await getCookies();
  var res = await httpsGet(
    "https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY",
    Object.assign({}, BASE_HEADERS, {
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.nseindia.com/option-chain",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": cookies
    })
  );

  // Log first 200 chars to diagnose format issues
  var preview = res.body.slice(0, 200).replace(/\n/g, " ");
  console.log("NSE response status=" + res.status + " preview=" + preview);

  if (res.status === 401 || res.status === 403) {
    cookieCache.value = null;
    throw new Error("NSE auth failed " + res.status);
  }
  if (res.status !== 200) {
    throw new Error("NSE returned HTTP " + res.status);
  }

  var data;
  try { data = JSON.parse(res.body); }
  catch(e) { throw new Error("NSE JSON parse failed: " + res.body.slice(0, 120)); }

  return data;
}

function parseNSEChain(data) {
  // NSE can return filtered or records format
  var records = data.records || data.filtered;
  if (!records || !records.data) {
    throw new Error("NSE unexpected format: keys=" + Object.keys(data || {}).join(","));
  }

  var spot   = records.underlyingValue || (data.records && data.records.underlyingValue) || 0;
  var expiry = records.expiryDates && records.expiryDates[0];

  // Fallback: use filtered.data if records.data is sparse
  var rows = (data.records && data.records.data) || records.data || [];

  var strikeMap = {};
  rows.forEach(function(row) {
    if (expiry && row.expiryDate !== expiry) return;
    var s = row.strikePrice;
    if (!strikeMap[s]) strikeMap[s] = { strike: s, ce: null, pe: null };
    if (row.CE) strikeMap[s].ce = { ltp: row.CE.lastPrice||0, oi: row.CE.openInterest||0, oiChange: row.CE.changeinOpenInterest||0, volume: row.CE.totalTradedVolume||0 };
    if (row.PE) strikeMap[s].pe = { ltp: row.PE.lastPrice||0, oi: row.PE.openInterest||0, oiChange: row.PE.changeinOpenInterest||0, volume: row.PE.totalTradedVolume||0 };
  });

  var strikes = Object.values(strikeMap)
    .filter(function(r) { return r.ce && r.pe; })
    .sort(function(a, b) { return a.strike - b.strike; })
    .filter(function(r) { return Math.abs(r.strike - spot) <= 500; });

  if (strikes.length < 3) throw new Error("Not enough strikes: " + strikes.length + " spot=" + spot);

  console.log("NSE chain OK: spot=" + spot + " expiry=" + expiry + " strikes=" + strikes.length);
  return { spot: spot, expiry: expiry || "live", strikes: strikes };
}

async function getNSEChain() {
  var data = await fetchNSEChain();
  return parseNSEChain(data);
}

module.exports = { getNSEChain };
