// dhanChain.js - Dhan API option chain fetcher for NIFTY
// Rate limit: 1 request per 3 seconds

var https = require("https");

var CLIENT_ID = process.env.DHAN_CLIENT_ID || "";
var ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || "";

// NIFTY constants
var NIFTY_SECURITY_ID = 13;
var NIFTY_SEGMENT = "IDX_I";

function getDhanChain() {
  return new Promise(function(resolve, reject) {
    if (!CLIENT_ID || !ACCESS_TOKEN) {
      return reject(new Error("Dhan: missing CLIENT_ID or ACCESS_TOKEN"));
    }

    console.log("Dhan: fetching expiry list for NIFTY");

    // Step 1: Fetch expiry list
    fetchExpiryList()
      .then(function(expiries) {
        if (!expiries || expiries.length === 0) {
          throw new Error("Dhan: no expiries found");
        }

        // Pick nearest expiry (first in list or find today/future)
        var expiry = pickNearestExpiry(expiries);
        console.log("Dhan: using expiry=" + expiry);

        // Step 2: Fetch option chain for that expiry
        return fetchOptionChain(expiry);
      })
      .then(function(chainData) {
        // Step 3: Parse to EDGE format
        var parsed = parseDhanChain(chainData);
        console.log("Dhan chain OK: spot=" + parsed.spot + " expiry=" + parsed.expiry + " strikes=" + parsed.strikes.length);
        resolve(parsed);
      })
      .catch(function(err) {
        console.log("Dhan poll failed: " + err.message);
        reject(err);
      });
  });
}

function fetchExpiryList() {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      UnderlyingScrip: NIFTY_SECURITY_ID,
      UnderlyingSeg: NIFTY_SEGMENT
    });

    var options = {
      hostname: "api.dhan.co",
      path: "/v2/optionchain/expirylist",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": ACCESS_TOKEN,
        "client-id": CLIENT_ID,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    makeRequest(options, body)
      .then(function(res) {
        if (res.status !== "success" || !res.data) {
          throw new Error("Dhan expiry list bad response: " + JSON.stringify(res).slice(0, 200));
        }
        resolve(res.data); // Array of dates like ["2026-04-16", "2026-04-23", ...]
      })
      .catch(reject);
  });
}

function fetchOptionChain(expiry) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      UnderlyingScrip: NIFTY_SECURITY_ID,
      UnderlyingSeg: NIFTY_SEGMENT,
      Expiry: expiry
    });

    var options = {
      hostname: "api.dhan.co",
      path: "/v2/optionchain",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": ACCESS_TOKEN,
        "client-id": CLIENT_ID,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    makeRequest(options, body)
      .then(function(res) {
        if (res.status !== "success" || !res.data) {
          throw new Error("Dhan option chain bad response: " + JSON.stringify(res).slice(0, 200));
        }
        resolve({ data: res.data, expiry: expiry });
      })
      .catch(reject);
  });
}

function makeRequest(options, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on("data", function(chunk) { chunks.push(chunk); });
      res.on("end", function() {
        try {
          var data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch (e) {
          reject(new Error("Dhan: JSON parse error"));
        }
      });
    });

    req.on("error", function(err) {
      reject(new Error("Dhan request error: " + err.message));
    });

    req.write(body);
    req.end();
  });
}

function pickNearestExpiry(expiries) {
  // Expiries come as YYYY-MM-DD strings, sorted ascending
  // Pick first expiry >= today
  var now = new Date();
  var today = now.toISOString().split("T")[0]; // YYYY-MM-DD

  for (var i = 0; i < expiries.length; i++) {
    if (expiries[i] >= today) {
      return expiries[i];
    }
  }

  // Fallback: return first expiry if all are in past (shouldn't happen)
  return expiries[0];
}

function parseDhanChain(chainData) {
  var data = chainData.data;
  var expiry = chainData.expiry;

  var spot = data.last_price || 0;
  var oc = data.oc || {};

  if (!spot) throw new Error("Dhan: no spot price in response");

  var strikeKeys = Object.keys(oc);
  if (strikeKeys.length === 0) {
    throw new Error("Dhan: empty option chain");
  }

  var strikes = [];

  strikeKeys.forEach(function(strikeStr) {
    var strike = parseFloat(strikeStr);
    var ce = oc[strikeStr].ce || {};
    var pe = oc[strikeStr].pe || {};

    strikes.push({
      strike: strike,
      ce_ltp: ce.last_price || 0,
      ce_oi: ce.oi || 0,
      ce_volume: ce.volume || 0,
      ce_iv: ce.implied_volatility || 0,
      ce_delta: ce.greeks ? ce.greeks.delta || 0 : 0,
      pe_ltp: pe.last_price || 0,
      pe_oi: pe.oi || 0,
      pe_volume: pe.volume || 0,
      pe_iv: pe.implied_volatility || 0,
      pe_delta: pe.greeks ? pe.greeks.delta || 0 : 0
    });
  });

  // Sort strikes numerically
  strikes.sort(function(a, b) { return a.strike - b.strike; });

  return {
    spot: spot,
    expiry: expiry,
    strikes: strikes
  };
}

module.exports = { getDhanChain: getDhanChain };
