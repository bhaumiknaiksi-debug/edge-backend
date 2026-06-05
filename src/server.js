'use strict';

const http = require('http');
const https = require('https');
const express = require('express');

const app = express();
app.use(express.json());

const ALLOWED_ORIGINS = [
  'https://edge-backend-mbcs.vercel.app',
  'http://localhost:3000'
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 10000;
const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || '';
let tokenExpired = false;

// --- In-memory state ---
let lastResult = null;
let lastFetchTime = null;
let fetchErrorCount = 0;
let lastError = null;

// --- Market hours ---
function getMarketPhase() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const h = ist.getHours();
  const m = ist.getMinutes();
  const mins = h * 60 + m;
  if (day === 0 || day === 6) return 'CLOSED';
  if (mins >= 555 && mins < 570) return 'PRE_OPEN';
  if (mins >= 570 && mins < 930) return 'OPEN';
  return 'CLOSED';
}

function getNextOpenIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  let daysAhead = 1;
  if (day === 5) daysAhead = 3;
  if (day === 6) daysAhead = 2;
  const next = new Date(ist);
  next.setDate(ist.getDate() + daysAhead);
  next.setHours(9, 15, 0, 0);
  return next;
}

// --- Upstox: get nearest expiry ---
function fetchUpstoxExpiries() {
  return new Promise((resolve, reject) => {
    const url = new URL('https://api.upstox.com/v2/option/contract');
    url.searchParams.set('instrument_key', 'NSE_INDEX|Nifty 50');
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + UPSTOX_TOKEN,
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401) { tokenExpired = true; return reject(new Error('TOKEN_EXPIRED')); }
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'error') return reject(new Error(JSON.stringify(parsed.errors)));
          tokenExpired = false;
          const expiries = parsed.data || [];
          expiries.sort();
          resolve(expiries);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('Upstox expiry request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// --- Upstox: fetch option chain ---
function fetchUpstoxChain(expiryDate) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://api.upstox.com/v2/option/chain');
    url.searchParams.set('instrument_key', 'NSE_INDEX|Nifty 50');
    url.searchParams.set('expiry_date', expiryDate);
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + UPSTOX_TOKEN,
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401) { tokenExpired = true; return reject(new Error('TOKEN_EXPIRED')); }
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'error') return reject(new Error(JSON.stringify(parsed.errors)));
          tokenExpired = false;
          resolve(parsed.data || []);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('Upstox chain request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// --- IV regime ---
function classifyIV(avgIV) {
  if (avgIV < 12) return 'LOW';
  if (avgIV <= 20) return 'NORMAL';
  return 'HIGH';
}

// --- Decision engine ---
function analyse(chain, expiryDate) {
  if (!chain || chain.length === 0) return null;

  // spot price: Upstox returns underlying_spot_price on each row; fallback to LTP-parity ATM
  let spot = chain[0]?.underlying_spot_price || 0;
  if (!spot) {
    const atmByParity = chain.reduce((best, s) => {
      const diff = Math.abs((s.call_options?.market_data?.ltp || 0) - (s.put_options?.market_data?.ltp || 0));
      return (!best || diff < best.diff) ? { strike: s.strike_price, diff } : best;
    }, null);
    spot = atmByParity?.strike || chain[Math.floor(chain.length / 2)].strike_price;
  }

  // totals
  let totalCEOI = 0, totalPEOI = 0;
  let ivSum = 0, ivCount = 0;
  const strikes = [];

  for (const s of chain) {
    const ce = s.call_options;
    const pe = s.put_options;
    const ceOI = ce?.market_data?.oi || 0;
    const peOI = pe?.market_data?.oi || 0;
    const ceLTP = ce?.market_data?.ltp || 0;
    const peLTP = pe?.market_data?.ltp || 0;
    const ceDelta = ce?.option_greeks?.delta || 0;
    const peDelta = pe?.option_greeks?.delta || 0;
    const ceIV = ce?.option_greeks?.iv || 0;
    const peIV = pe?.option_greeks?.iv || 0;
    const ceTheta = ce?.option_greeks?.theta || 0;
    const peTheta = pe?.option_greeks?.theta || 0;
    const ceVega = ce?.option_greeks?.vega || 0;
    const ceGamma = ce?.option_greeks?.gamma || 0;
    const ceBid = ce?.market_data?.bid_price || 0;
    const ceAsk = ce?.market_data?.ask_price || 0;
    const peBid = pe?.market_data?.bid_price || 0;
    const peAsk = pe?.market_data?.ask_price || 0;
    const ceSpread = ceAsk - ceBid;
    const peSpread = peAsk - peBid;

    totalCEOI += ceOI;
    totalPEOI += peOI;
    if (ceIV > 0) { ivSum += ceIV; ivCount++; }
    if (peIV > 0) { ivSum += peIV; ivCount++; }

    strikes.push({
      strike: s.strike_price,
      pcr: s.pcr || (peOI / (ceOI || 1)),
      ceOI, peOI, ceLTP, peLTP,
      ceDelta, peDelta,
      ceIV, peIV, ceTheta, peTheta,
      ceVega, ceGamma,
      ceSpread, peSpread,
      cePrevOI: ce?.market_data?.prev_oi || 0,
      pePrevOI: pe?.market_data?.prev_oi || 0,
      ceVolume: ce?.market_data?.volume || 0,
      peVolume: pe?.market_data?.volume || 0,
    });
  }

  // Full-chain OI totals retained for display
  const avgIV = ivCount > 0 ? ivSum / ivCount : 15;
  const ivRegime = classifyIV(avgIV);

  // ATM index
  const atmIndex = strikes.reduce((best, s, i) => {
    const d = Math.abs(s.strike - spot);
    return d < best.d ? { i, d } : best;
  }, { i: 0, d: Infinity }).i;

  // Smart PCR --- ATM +/- 7 strikes only (filters deep-OTM hedging noise)
  const WINDOW = 7;
  const lo = Math.max(0, atmIndex - WINDOW);
  const hi = Math.min(strikes.length - 1, atmIndex + WINDOW);
  let windowCEOI = 0, windowPEOI = 0;
  for (let i = lo; i <= hi; i++) { windowCEOI += strikes[i].ceOI; windowPEOI += strikes[i].peOI; }
  const pcr = windowPEOI / (windowCEOI || 1);

  const atm = strikes[atmIndex];
  const support = strikes[Math.max(0, atmIndex - 3)];
  const resistance = strikes[Math.min(strikes.length - 1, atmIndex + 3)];

  // Alpha strikes --- top 3 by combined OI
  const alphas = [...strikes]
    .sort((a, b) => (b.ceOI + b.peOI) - (a.ceOI + a.peOI))
    .slice(0, 3);

  // Max pain
  let maxPain = atm.strike;
  let minLoss = Infinity;
  for (const pivot of strikes) {
    let totalLoss = 0;
    for (const s of strikes) {
      if (pivot.strike > s.strike) totalLoss += (pivot.strike - s.strike) * s.ceOI;
      if (pivot.strike < s.strike) totalLoss += (s.strike - pivot.strike) * s.peOI;
    }
    if (totalLoss < minLoss) { minLoss = totalLoss; maxPain = pivot.strike; }
  }

  // OI change (buildup detection)
  const ceBuildup = strikes.filter(s => s.ceOI > s.cePrevOI && s.ceLTP > 0);
  const peBuildup = strikes.filter(s => s.peOI > s.pePrevOI && s.peLTP > 0);

  // --- Weighted bias scoring ---
  // OI structure (30%): PE > CE = bullish
  const oiScore = pcr > 1.3 ? 30 : pcr > 1.0 ? 15 : pcr > 0.7 ? 0 : pcr > 0.5 ? -15 : -30;

  // PCR (25%): scale -25 to +25
  const pcrScore = Math.max(-25, Math.min(25, (pcr - 1.0) * 50));

  // Price action vs max pain (25%)
  const pricePct = (spot - maxPain) / maxPain * 100;
  const priceScore = pricePct > 1 ? 25 : pricePct > 0 ? 10 : pricePct > -1 ? -10 : -25;

  // IV context (20%): high IV = fear = bearish lean, low IV = complacent = bullish
  const ivScore = ivRegime === 'HIGH' ? -20 : ivRegime === 'LOW' ? 20 : 0;

  const totalScore = oiScore + pcrScore + priceScore + ivScore;
  // normalise to 0-100 confidence
  const confidence = Math.round(Math.min(100, Math.max(0, (totalScore + 100) / 2)));

  let bias, biasLabel;
  if (totalScore >= 30) { bias = 'BULLISH'; biasLabel = 'Bullish'; }
  else if (totalScore >= 10) { bias = 'MILD_BULLISH'; biasLabel = 'Mild Bullish'; }
  else if (totalScore > -10) { bias = 'NEUTRAL'; biasLabel = 'Neutral'; }
  else if (totalScore > -30) { bias = 'MILD_BEARISH'; biasLabel = 'Mild Bearish'; }
  else { bias = 'BEARISH'; biasLabel = 'Bearish'; }

  // --- Strategy mapping (IV-aware, signal-consistent) ---
  let strategy, strategyReason;
  const isBullish = bias === 'BULLISH' || bias === 'MILD_BULLISH';
  const isBearish = bias === 'BEARISH' || bias === 'MILD_BEARISH';
  const isNeutral = bias === 'NEUTRAL';

  if (isBullish && ivRegime === 'HIGH') {
    strategy = 'BULL_PUT_SPREAD';
    strategyReason = 'Bullish bias + High IV favours selling premium via Bull Put Spread';
  } else if (isBullish && ivRegime !== 'HIGH') {
    strategy = 'LONG_CALL';
    strategyReason = 'Bullish bias + Low/Normal IV favours directional Long Call';
  } else if (isBearish && ivRegime === 'HIGH') {
    strategy = 'BEAR_CALL_SPREAD';
    strategyReason = 'Bearish bias + High IV favours selling premium via Bear Call Spread';
  } else if (isBearish && ivRegime !== 'HIGH') {
    strategy = 'LONG_PUT';
    strategyReason = 'Bearish bias + Low/Normal IV favours directional Long Put';
  } else if (isNeutral && ivRegime === 'HIGH') {
    strategy = 'IRON_CONDOR';
    strategyReason = 'Neutral market + High IV - ideal for Iron Condor premium collection';
  } else {
    strategy = 'WAIT';
    strategyReason = 'No clear edge - low IV + neutral bias, wait for setup';
  }

  // --- Delta-based strike selection ---
  // Selling: delta 0.20-0.35 | Buying: delta 0.40-0.60
  const sellCEStrikes = strikes.filter(s => s.ceDelta >= 0.20 && s.ceDelta <= 0.35 && s.ceSpread < 5);
  const buyCEStrikes = strikes.filter(s => s.ceDelta >= 0.40 && s.ceDelta <= 0.60 && s.ceSpread < 5);
  const sellPEStrikes = strikes.filter(s => Math.abs(s.peDelta) >= 0.20 && Math.abs(s.peDelta) <= 0.35 && s.peSpread < 5);
  const buyPEStrikes = strikes.filter(s => Math.abs(s.peDelta) >= 0.40 && Math.abs(s.peDelta) <= 0.60 && s.peSpread < 5);

  // --- Risk metrics per strategy ---
  let tradeLegs = null;

  if (strategy === 'BEAR_CALL_SPREAD' && sellCEStrikes.length && buyCEStrikes.length) {
    // CORRECT: SELL lower CE + BUY higher CE
    const sellLeg = sellCEStrikes.sort((a, b) => a.strike - b.strike)[0];
    const buyLeg = buyCEStrikes.filter(s => s.strike > sellLeg.strike).sort((a, b) => a.strike - b.strike)[0];
    if (buyLeg) {
      const netCredit = sellLeg.ceLTP - buyLeg.ceLTP;
      const maxProfit = netCredit;
      const maxLoss = (buyLeg.strike - sellLeg.strike) - netCredit;
      const breakeven = sellLeg.strike + netCredit;
      const rrr = maxLoss > 0 ? (maxProfit / maxLoss).toFixed(2) : 'N/A';
      const pop = Math.round((1 - sellLeg.ceDelta) * 100);
      tradeLegs = { sellLeg: { strike: sellLeg.strike, premium: sellLeg.ceLTP.toFixed(2), type: 'CE' },
        buyLeg: { strike: buyLeg.strike, premium: buyLeg.ceLTP.toFixed(2), type: 'CE' },
        netCredit: netCredit.toFixed(2), maxProfit: maxProfit.toFixed(2),
        maxLoss: maxLoss.toFixed(2), breakeven: breakeven.toFixed(0),
        rrr, pop };
    }
  } else if (strategy === 'BULL_PUT_SPREAD' && sellPEStrikes.length && buyPEStrikes.length) {
    const sellLeg = sellPEStrikes.sort((a, b) => b.strike - a.strike)[0];
    const buyLeg = buyPEStrikes.filter(s => s.strike < sellLeg.strike).sort((a, b) => b.strike - a.strike)[0];
    if (buyLeg) {
      const netCredit = sellLeg.peLTP - buyLeg.peLTP;
      const maxProfit = netCredit;
      const maxLoss = (sellLeg.strike - buyLeg.strike) - netCredit;
      const breakeven = sellLeg.strike - netCredit;
      const rrr = maxLoss > 0 ? (maxProfit / maxLoss).toFixed(2) : 'N/A';
      const pop = Math.round((1 - Math.abs(sellLeg.peDelta)) * 100);
      tradeLegs = { sellLeg: { strike: sellLeg.strike, premium: sellLeg.peLTP.toFixed(2), type: 'PE' },
        buyLeg: { strike: buyLeg.strike, premium: buyLeg.peLTP.toFixed(2), type: 'PE' },
        netCredit: netCredit.toFixed(2), maxProfit: maxProfit.toFixed(2),
        maxLoss: maxLoss.toFixed(2), breakeven: breakeven.toFixed(0),
        rrr, pop };
    }
  } else if (strategy === 'LONG_CALL' && buyCEStrikes.length) {
    const leg = buyCEStrikes.sort((a, b) => Math.abs(a.ceDelta - 0.50) - Math.abs(b.ceDelta - 0.50))[0];
    tradeLegs = { buyLeg: { strike: leg.strike, premium: leg.ceLTP.toFixed(2), type: 'CE' },
      maxProfit: 'Unlimited', maxLoss: leg.ceLTP.toFixed(2),
      breakeven: (leg.strike + leg.ceLTP).toFixed(0),
      rrr: 'Unlimited', pop: Math.round(leg.ceDelta * 100) };
  } else if (strategy === 'LONG_PUT' && buyPEStrikes.length) {
    const leg = buyPEStrikes.sort((a, b) => Math.abs(Math.abs(a.peDelta) - 0.50) - Math.abs(Math.abs(b.peDelta) - 0.50))[0];
    tradeLegs = { buyLeg: { strike: leg.strike, premium: leg.peLTP.toFixed(2), type: 'PE' },
      maxProfit: (leg.strike - leg.peLTP).toFixed(2), maxLoss: leg.peLTP.toFixed(2),
      breakeven: (leg.strike - leg.peLTP).toFixed(0),
      rrr: 'High', pop: Math.round(Math.abs(leg.peDelta) * 100) };
  }

  // --- Smart warnings ---
  const warnings = [];
  if (pcr < 0.5) warnings.push('PCR < 0.5 - possible reversal, avoid fresh shorts');
  if (pcr > 1.5) warnings.push('PCR > 1.5 - extreme bullish positioning, watch for unwinding');
  if (ivRegime === 'HIGH') warnings.push('High IV - prefer selling strategies');
  if (ivRegime === 'LOW') warnings.push('Low IV - prefer buying strategies');
  const distToSupport = ((spot - support.strike) / spot * 100).toFixed(1);
  if (parseFloat(distToSupport) < 0.5) warnings.push('Near support - avoid fresh shorts');
  const distToResistance = ((resistance.strike - spot) / spot * 100).toFixed(1);
  if (parseFloat(distToResistance) < 0.5) warnings.push('Near resistance - avoid fresh longs');

  // DTE
  const today = new Date();
  const expiry = new Date(expiryDate);
  const dte = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

  // Max pain advisory
  const spotToMaxPain = Math.abs(spot - maxPain) / spot * 100;
  const useMaxPain = dte <= 2 && spotToMaxPain < 1;

  // OI writing zones
  const ceWritingZone = strikes.filter(s => s.strike > spot).sort((a, b) => b.ceOI - a.ceOI).slice(0, 2).map(s => s.strike);
  const peWritingZone = strikes.filter(s => s.strike < spot).sort((a, b) => b.peOI - a.peOI).slice(0, 2).map(s => s.strike);

  return {
    timestamp: new Date().toISOString(),
    spot,
    expiry: expiryDate,
    dte,
    pcr: parseFloat(pcr.toFixed(3)),
    totalCEOI,
    totalPEOI,
    avgIV: parseFloat(avgIV.toFixed(2)),
    ivRegime,
    bias,
    biasLabel,
    confidence,
    atm: { strike: atm.strike, ceLTP: atm.ceLTP, peLTP: atm.peLTP,
      ceDelta: atm.ceDelta, peDelta: atm.peDelta, ceIV: atm.ceIV, peIV: atm.peIV,
      ceTheta: atm.ceTheta, peTheta: atm.peTheta },
    support: { strike: support.strike, peOI: support.peOI },
    resistance: { strike: resistance.strike, ceOI: resistance.ceOI },
    maxPain,
    useMaxPain,
    alphas: alphas.map(s => ({
      strike: s.strike,
      ceOI: s.ceOI, peOI: s.peOI,
      ceLTP: s.ceLTP, peLTP: s.peLTP,
      ceDelta: s.ceDelta, ceIV: s.ceIV,
      ceTheta: s.ceTheta, ceVega: s.ceVega
    })),
    decision: { strategy, reason: strategyReason, tradeLegs },
    intel: { maxPain, ceWritingZone, peWritingZone, ceBuildup: ceBuildup.length, peBuildup: peBuildup.length,
      oiClusters: alphas.map(s => s.strike) },
    warnings,
    market: { phase: getMarketPhase() }
  };
}

// --- Polling loop ---
let pollTimer = null;
let backoffMs = 30000;

async function poll() {
  try {
    const phase = getMarketPhase();
    // Skip polling when closed ONLY if we already have data (startup fetch always runs once)
    if (phase === 'CLOSED' && lastResult !== null) {
      backoffMs = 60000;
      pollTimer = setTimeout(poll, backoffMs);
      return;
    }
    const expiries = await fetchUpstoxExpiries();
    if (!expiries.length) throw new Error('No expiries returned');
    const nearestExpiry = expiries[0];
    const chain = await fetchUpstoxChain(nearestExpiry);
    const result = analyse(chain, nearestExpiry);
    if (result) {
      lastResult = result;
      lastFetchTime = Date.now();
      fetchErrorCount = 0;
      lastError = null;
    }
    backoffMs = 30000;
  } catch (err) {
    fetchErrorCount++;
    lastError = { message: err.message, time: new Date().toISOString() };
    backoffMs = Math.min(backoffMs * 2, 300000);
    console.error('[poll error]', err.message, '- next in', backoffMs / 1000, 's');
  }
  pollTimer = setTimeout(poll, backoffMs);
}

// --- HTTP routes ---
app.get('/', (req, res) => {
  res.json({ status: 'EDGE online',
    phase: getMarketPhase(), lastFetch: lastFetchTime,
    errors: fetchErrorCount, tokenExpired, lastError });
});

const dataHandler = (req, res) => {
  if (!lastResult) return res.status(503).json({ error: 'No data yet', phase: getMarketPhase(), tokenExpired, lastError });
  res.json(lastResult);
};
app.get('/data', dataHandler);
app.get('/analysis', dataHandler);
app.get('/api/v1/dashboard', dataHandler);
app.get('/api/v1/market/status', (req, res) => res.json({ phase: getMarketPhase(), tokenExpired }));

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log('EDGE backend on port', PORT);
  const probeUrl = new URL('https://api.upstox.com/v2/option/contract');
  probeUrl.searchParams.set('instrument_key', 'NSE_INDEX|Nifty 50');
  console.log('[upstox] expiry URL constructed:', probeUrl.toString());
  poll();
});
