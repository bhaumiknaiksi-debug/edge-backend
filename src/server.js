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

// NIFTY 50 lot size (Sept 2024 onward). Update here if NSE changes it.
const NIFTY_LOT_SIZE = 75;
const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Format "2026-06-09" -> "09 JUN" (broker display style)
function formatExpiryShort(isoDate) {
  if (!isoDate || isoDate.length < 10) return '';
  const yyyy = isoDate.slice(0, 4);
  const mm = parseInt(isoDate.slice(5, 7), 10);
  const dd = isoDate.slice(8, 10);
  if (!mm || mm < 1 || mm > 12) return '';
  return dd + ' ' + MONTHS_SHORT[mm - 1];
}

// Build broker-style contract ID, e.g. "NIFTY 09 JUN 23600 PE"
function buildContractId(expiryDate, strike, optionType) {
  return 'NIFTY ' + formatExpiryShort(expiryDate) + ' ' + strike + ' ' + optionType;
}

// Convert NIFTY points to rupees per lot
function pointsToRupees(points) {
  return Math.round(parseFloat(points) * NIFTY_LOT_SIZE);
}

const STRATEGY_NAMES = {
  BEAR_CALL_SPREAD: 'Bear Call Spread',
  BULL_PUT_SPREAD: 'Bull Put Spread',
  LONG_CALL: 'Long Call',
  LONG_PUT: 'Long Put',
  IRON_CONDOR: 'Iron Condor',
  WAIT: 'standing aside'
};

// --- In-memory state ---
let lastResult = null;
let lastFetchTime = null;
let fetchErrorCount = 0;
let lastError = null;

// History ring buffer - last N successful polls for session grading
const HISTORY_LIMIT = 500;
const history = [];

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
          const contracts = parsed.data || [];
          const expiries = [...new Set(contracts.map(c => c.expiry).filter(Boolean))];
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
  // Step 1: directional sub-scores (range roughly -80..+80 combined)
  const oiScore = pcr > 1.3 ? 30 : pcr > 1.0 ? 15 : pcr > 0.7 ? 0 : pcr > 0.5 ? -15 : -30;
  const pcrScore = Math.max(-25, Math.min(25, (pcr - 1.0) * 50));
  const pricePct = (spot - maxPain) / maxPain * 100;
  const priceScore = pricePct > 1 ? 25 : pricePct > 0 ? 10 : pricePct > -1 ? -10 : -25;

  const directionalScore = oiScore + pcrScore + priceScore;

  // Step 2: IV state - does the regime CONFIRM, CONTRADICT, or stay NEUTRAL to direction?
  //   HIGH IV + bearish lean -> CONFIRMS (fear validates bearish)
  //   HIGH IV + bullish lean -> CONTRADICTS (rally into fear is suspect)
  //   LOW IV  + bullish lean -> CONFIRMS (calm validates bullish)
  //   LOW IV  + bearish lean -> CONTRADICTS (selling into calm is suspect)
  //   Otherwise NEUTRAL
  let ivState = 'NEUTRAL';
  if (ivRegime === 'HIGH' && directionalScore <= -5) ivState = 'CONFIRMS';
  else if (ivRegime === 'HIGH' && directionalScore >= 5) ivState = 'CONTRADICTS';
  else if (ivRegime === 'LOW'  && directionalScore >= 5) ivState = 'CONFIRMS';
  else if (ivRegime === 'LOW'  && directionalScore <= -5) ivState = 'CONTRADICTS';

  // Step 3: coherence - how many of the active sub-signals agree on direction?
  const subSignals = [oiScore, pcrScore, priceScore];
  const activeSubs = subSignals.filter(s => Math.abs(s) > 2);
  const allAligned = activeSubs.length > 0 &&
    activeSubs.every(s => Math.sign(s) === Math.sign(directionalScore));

  // Confidence (0..100): magnitude + coherence bonus + IV alignment bonus
  let confidence = Math.abs(directionalScore);
  if (allAligned && activeSubs.length >= 2) confidence += 15;
  if (allAligned && activeSubs.length === 3) confidence += 10;
  if (ivState === 'CONFIRMS') confidence += 15;
  if (ivState === 'CONTRADICTS') confidence -= 15;
  confidence = Math.round(Math.max(0, Math.min(100, confidence)));

  // Bias direction: directionalScore scaled by IV state (confirm boosts, contradict dampens)
  const biasScore = ivState === 'CONFIRMS' ? directionalScore * 1.3
                  : ivState === 'CONTRADICTS' ? directionalScore * 0.7
                  : directionalScore;
  const totalScore = biasScore;

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

  // --- Delta-based strike selection (with tiered fallback for low liquidity / high IV) ---
  // SELL leg: near-OTM, delta 0.20-0.35 (collects meaningful premium)
  // BUY leg for credit spreads: deeper OTM, delta 0.05-0.20 (cheap protection further from spot)
  // BUY leg for debit (long) strategies: near-ATM, delta 0.40-0.60 (directional bet)
  function spreadOk(spread, ltp, tier) {
    if (tier === 1) return spread < 5;
    if (tier === 2) return spread < Math.max(15, ltp * 0.02);
    return true; // tier 3
  }
  function selectStrikes(role /* 'sell' | 'protect' | 'directional' */, optionType /* 'CE' | 'PE' */) {
    const bandsByRole = {
      sell:        [[0.20, 0.35], [0.15, 0.40], [0.10, 0.45]],
      protect:     [[0.05, 0.20], [0.03, 0.25], [0.01, 0.30]],
      directional: [[0.40, 0.60], [0.35, 0.65], [0.30, 0.70]],
    };
    const bands = bandsByRole[role];
    for (let tier = 1; tier <= 3; tier++) {
      const [lo, hi] = bands[tier - 1];
      const matches = strikes.filter(s => {
        const delta = optionType === 'CE' ? s.ceDelta : Math.abs(s.peDelta);
        const spread = optionType === 'CE' ? s.ceSpread : s.peSpread;
        const ltp = optionType === 'CE' ? s.ceLTP : s.peLTP;
        return delta >= lo && delta <= hi && ltp > 0 && spreadOk(spread, ltp, tier);
      });
      if (matches.length) return { matches, tier };
    }
    return { matches: [], tier: 0 };
  }
  const sellCESel    = selectStrikes('sell',        'CE'); // bear call spread short leg
  const protectCESel = selectStrikes('protect',     'CE'); // bear call spread long leg
  const sellPESel    = selectStrikes('sell',        'PE'); // bull put spread short leg
  const protectPESel = selectStrikes('protect',     'PE'); // bull put spread long leg
  const buyCESel     = selectStrikes('directional', 'CE'); // long call
  const buyPESel     = selectStrikes('directional', 'PE'); // long put
  const sellCEStrikes    = sellCESel.matches;
  const protectCEStrikes = protectCESel.matches;
  const sellPEStrikes    = sellPESel.matches;
  const protectPEStrikes = protectPESel.matches;
  const buyCEStrikes     = buyCESel.matches;
  const buyPEStrikes     = buyPESel.matches;
  function liquidityTagFor(tiers) {
    const worst = Math.max(...tiers.filter(t => t > 0));
    if (worst === 1) return 'TIGHT';
    if (worst === 2) return 'ACCEPTABLE';
    return 'LIMITED';
  }

  // --- Risk metrics per strategy ---
  let tradeLegs = null;

  if (strategy === 'BEAR_CALL_SPREAD' && sellCEStrikes.length && protectCEStrikes.length) {
    // SELL near-OTM CE + BUY further-OTM CE for protection
    const sellLeg = sellCEStrikes.sort((a, b) => a.strike - b.strike)[0];
    const buyLeg = protectCEStrikes.filter(s => s.strike > sellLeg.strike).sort((a, b) => a.strike - b.strike)[0];
    if (buyLeg) {
      const netCredit = sellLeg.ceLTP - buyLeg.ceLTP;
      const maxProfit = netCredit;
      const maxLoss = (buyLeg.strike - sellLeg.strike) - netCredit;
      const breakeven = sellLeg.strike + netCredit;
      const rrr = maxLoss > 0 ? (maxProfit / maxLoss).toFixed(2) : 'N/A';
      const pop = Math.round((1 - sellLeg.ceDelta) * 100);
      tradeLegs = {
        sellLeg: { contractId: buildContractId(expiryDate, sellLeg.strike, 'CE'), strike: sellLeg.strike, premium: sellLeg.ceLTP.toFixed(2), type: 'CE' },
        buyLeg:  { contractId: buildContractId(expiryDate, buyLeg.strike,  'CE'), strike: buyLeg.strike,  premium: buyLeg.ceLTP.toFixed(2),  type: 'CE' },
        netCredit: netCredit.toFixed(2),     netCreditRupees: pointsToRupees(netCredit),
        maxProfit: maxProfit.toFixed(2),     maxProfitRupees: pointsToRupees(maxProfit),
        maxLoss:   maxLoss.toFixed(2),       maxLossRupees:   pointsToRupees(maxLoss),
        breakeven: breakeven.toFixed(0),
        rrr, pop,
        lotSize: NIFTY_LOT_SIZE,
        liquidity: liquidityTagFor([sellCESel.tier, protectCESel.tier])
      };
    }
  } else if (strategy === 'BULL_PUT_SPREAD' && sellPEStrikes.length && protectPEStrikes.length) {
    // SELL near-OTM PE + BUY further-OTM PE for protection
    const sellLeg = sellPEStrikes.sort((a, b) => b.strike - a.strike)[0];
    const buyLeg = protectPEStrikes.filter(s => s.strike < sellLeg.strike).sort((a, b) => b.strike - a.strike)[0];
    if (buyLeg) {
      const netCredit = sellLeg.peLTP - buyLeg.peLTP;
      const maxProfit = netCredit;
      const maxLoss = (sellLeg.strike - buyLeg.strike) - netCredit;
      const breakeven = sellLeg.strike - netCredit;
      const rrr = maxLoss > 0 ? (maxProfit / maxLoss).toFixed(2) : 'N/A';
      const pop = Math.round((1 - Math.abs(sellLeg.peDelta)) * 100);
      tradeLegs = {
        sellLeg: { contractId: buildContractId(expiryDate, sellLeg.strike, 'PE'), strike: sellLeg.strike, premium: sellLeg.peLTP.toFixed(2), type: 'PE' },
        buyLeg:  { contractId: buildContractId(expiryDate, buyLeg.strike,  'PE'), strike: buyLeg.strike,  premium: buyLeg.peLTP.toFixed(2),  type: 'PE' },
        netCredit: netCredit.toFixed(2),     netCreditRupees: pointsToRupees(netCredit),
        maxProfit: maxProfit.toFixed(2),     maxProfitRupees: pointsToRupees(maxProfit),
        maxLoss:   maxLoss.toFixed(2),       maxLossRupees:   pointsToRupees(maxLoss),
        breakeven: breakeven.toFixed(0),
        rrr, pop,
        lotSize: NIFTY_LOT_SIZE,
        liquidity: liquidityTagFor([sellPESel.tier, protectPESel.tier])
      };
    }
  } else if (strategy === 'LONG_CALL' && buyCEStrikes.length) {
    const leg = buyCEStrikes.sort((a, b) => Math.abs(a.ceDelta - 0.50) - Math.abs(b.ceDelta - 0.50))[0];
    tradeLegs = {
      buyLeg: { contractId: buildContractId(expiryDate, leg.strike, 'CE'), strike: leg.strike, premium: leg.ceLTP.toFixed(2), type: 'CE' },
      maxProfit: 'Unlimited',  maxProfitRupees: 'Unlimited',
      maxLoss: leg.ceLTP.toFixed(2),  maxLossRupees: pointsToRupees(leg.ceLTP),
      breakeven: (leg.strike + leg.ceLTP).toFixed(0),
      rrr: 'Unlimited', pop: Math.round(leg.ceDelta * 100),
      lotSize: NIFTY_LOT_SIZE,
      liquidity: liquidityTagFor([buyCESel.tier])
    };
  } else if (strategy === 'LONG_PUT' && buyPEStrikes.length) {
    const leg = buyPEStrikes.sort((a, b) => Math.abs(Math.abs(a.peDelta) - 0.50) - Math.abs(Math.abs(b.peDelta) - 0.50))[0];
    tradeLegs = {
      buyLeg: { contractId: buildContractId(expiryDate, leg.strike, 'PE'), strike: leg.strike, premium: leg.peLTP.toFixed(2), type: 'PE' },
      maxProfit: (leg.strike - leg.peLTP).toFixed(2),  maxProfitRupees: pointsToRupees(leg.strike - leg.peLTP),
      maxLoss: leg.peLTP.toFixed(2),                   maxLossRupees: pointsToRupees(leg.peLTP),
      breakeven: (leg.strike - leg.peLTP).toFixed(0),
      rrr: 'High', pop: Math.round(Math.abs(leg.peDelta) * 100),
      lotSize: NIFTY_LOT_SIZE,
      liquidity: liquidityTagFor([buyPESel.tier])
    };
  } else if (strategy === 'IRON_CONDOR' && sellCEStrikes.length && protectCEStrikes.length && sellPEStrikes.length && protectPEStrikes.length) {
    const ceShort = sellCEStrikes.sort((a, b) => a.strike - b.strike)[0];
    const ceLong  = protectCEStrikes.filter(s => s.strike > ceShort.strike).sort((a, b) => a.strike - b.strike)[0];
    const peShort = sellPEStrikes.sort((a, b) => b.strike - a.strike)[0];
    const peLong  = protectPEStrikes.filter(s => s.strike < peShort.strike).sort((a, b) => b.strike - a.strike)[0];
    if (ceLong && peLong) {
      const callCredit = ceShort.ceLTP - ceLong.ceLTP;
      const putCredit  = peShort.peLTP - peLong.peLTP;
      const netCredit  = callCredit + putCredit;
      const callWidth  = ceLong.strike - ceShort.strike;
      const putWidth   = peShort.strike - peLong.strike;
      const maxLoss    = Math.max(callWidth, putWidth) - netCredit;
      const breakevenHigh = ceShort.strike + netCredit;
      const breakevenLow  = peShort.strike - netCredit;
      const rrr = maxLoss > 0 ? (netCredit / maxLoss).toFixed(2) : 'N/A';
      const pop = Math.round(Math.max(0, Math.min(100, (1 - ceShort.ceDelta - Math.abs(peShort.peDelta)) * 100)));
      tradeLegs = {
        ceShort: { contractId: buildContractId(expiryDate, ceShort.strike, 'CE'), strike: ceShort.strike, premium: ceShort.ceLTP.toFixed(2), type: 'CE' },
        ceLong:  { contractId: buildContractId(expiryDate, ceLong.strike,  'CE'), strike: ceLong.strike,  premium: ceLong.ceLTP.toFixed(2),  type: 'CE' },
        peShort: { contractId: buildContractId(expiryDate, peShort.strike, 'PE'), strike: peShort.strike, premium: peShort.peLTP.toFixed(2), type: 'PE' },
        peLong:  { contractId: buildContractId(expiryDate, peLong.strike,  'PE'), strike: peLong.strike,  premium: peLong.peLTP.toFixed(2),  type: 'PE' },
        netCredit: netCredit.toFixed(2),  netCreditRupees: pointsToRupees(netCredit),
        maxProfit: netCredit.toFixed(2),  maxProfitRupees: pointsToRupees(netCredit),
        maxLoss:   maxLoss.toFixed(2),    maxLossRupees:   pointsToRupees(maxLoss),
        breakevenLow:  breakevenLow.toFixed(0),
        breakevenHigh: breakevenHigh.toFixed(0),
        rrr, pop,
        lotSize: NIFTY_LOT_SIZE,
        liquidity: liquidityTagFor([sellCESel.tier, protectCESel.tier, sellPESel.tier, protectPESel.tier])
      };
    }
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

  // --- Expected move (approx 1 SD to expiry, from ATM straddle price) ---
  const expectedMovePts = Math.round(atm.ceLTP + atm.peLTP);
  const emLow = Math.round(spot - expectedMovePts);
  const emHigh = Math.round(spot + expectedMovePts);
  let strikeSafety = null;
  if (tradeLegs) {
    if (tradeLegs.ceShort && tradeLegs.peShort) {
      strikeSafety = {
        ceShort: { strike: tradeLegs.ceShort.strike, outsideEM: tradeLegs.ceShort.strike >= emHigh },
        peShort: { strike: tradeLegs.peShort.strike, outsideEM: tradeLegs.peShort.strike <= emLow }
      };
    } else if (tradeLegs.sellLeg) {
      const sl = tradeLegs.sellLeg;
      strikeSafety = { sellLeg: { strike: sl.strike, outsideEM: sl.type === 'CE' ? sl.strike >= emHigh : sl.strike <= emLow } };
    }
  }

  // --- Writer dominance (windowed OI ratio - replaces raw buildup counts) ---
  const domRatio = windowPEOI / (windowCEOI || 1);
  const writerDominance =
    domRatio > 1.5  ? { label: 'PUT WRITERS LEADING',  strength: 'STRONG',   lean: 'BULLISH' } :
    domRatio > 1.2  ? { label: 'PUT WRITERS LEADING',  strength: 'MODERATE', lean: 'BULLISH' } :
    domRatio < 0.67 ? { label: 'CALL WRITERS LEADING', strength: 'STRONG',   lean: 'BEARISH' } :
    domRatio < 0.83 ? { label: 'CALL WRITERS LEADING', strength: 'MODERATE', lean: 'BEARISH' } :
                      { label: 'BALANCED POSITIONING', strength: 'EVEN',     lean: 'NEUTRAL' };

  // --- Market structure (walls from real OI maxima, not symmetric offsets) ---
  const ceWall = ceWritingZone.length ? ceWritingZone[0] : resistance.strike;
  const peWall = peWritingZone.length ? peWritingZone[0] : support.strike;
  const rangeWidth = ceWall - peWall;
  const rangePct = parseFloat((rangeWidth / spot * 100).toFixed(2));
  // Heuristic bands for NIFTY weeklies; revisit after more sessions
  const compression = rangePct < 2 ? 'COMPRESSED' : rangePct <= 4 ? 'NORMAL' : 'WIDE';
  const nearWall = Math.min(Math.abs(spot - peWall), Math.abs(ceWall - spot)) / spot * 100 < 0.4;
  const breakoutRisk = compression === 'COMPRESSED' ? (ivRegime === 'HIGH' ? 'ELEVATED' : 'MODERATE')
                     : nearWall ? 'MODERATE' : 'LOW';
  const premiumSelling = ivRegime === 'HIGH' ? 'FAVOURABLE' : ivRegime === 'NORMAL' ? 'NEUTRAL' : 'UNFAVOURABLE';

  // --- Factor breakdown (exposes the scoring engine's actual inputs) ---
  const factors = [
    { label: 'OI structure', value: Math.round(oiScore) },
    { label: 'PCR momentum', value: Math.round(pcrScore) },
    { label: 'Price vs max pain', value: Math.round(priceScore) }
  ];
  if (ivState === 'CONFIRMS') factors.push({ label: 'IV ' + ivRegime + ' confirms direction', value: 15 });
  else if (ivState === 'CONTRADICTS') factors.push({ label: 'IV ' + ivRegime + ' contradicts direction', value: -15 });
  else factors.push({ label: 'IV ' + ivRegime + ' (no directional weight)', value: 0 });
  if (allAligned && activeSubs.length === 3) factors.push({ label: 'All signals aligned', value: 25 });
  else if (allAligned && activeSubs.length === 2) factors.push({ label: 'Signals aligned', value: 15 });

  // --- Signal quality grade (factor agreement, not magnitude) ---
  let signalGrade;
  const opposingCount = activeSubs.filter(s => Math.sign(s) !== Math.sign(directionalScore || 1)).length;
  if (bias === 'NEUTRAL') {
    signalGrade = ivRegime === 'HIGH' ? 'B' : 'C';
  } else if (allAligned && activeSubs.length === 3 && ivState === 'CONFIRMS') signalGrade = 'A+';
  else if (allAligned && activeSubs.length >= 2 && ivState !== 'CONTRADICTS') signalGrade = 'A';
  else if (opposingCount === 0 && ivState !== 'CONTRADICTS') signalGrade = 'B';
  else if (opposingCount >= 2 || ivState === 'CONTRADICTS') signalGrade = 'D';
  else signalGrade = 'C';

  // --- Trade thesis (deterministic - assembled from the same inputs the engine scored) ---
  const strategyHuman = STRATEGY_NAMES[strategy] || strategy;
  const dirWord = bias.indexOf('BULL') >= 0 ? 'bullish' : bias.indexOf('BEAR') >= 0 ? 'bearish' : 'neutral';
  const thesisParts = [];
  thesisParts.push('Smart PCR at ' + pcr.toFixed(2) + ' with ' + writerDominance.label.toLowerCase() +
    (writerDominance.strength !== 'EVEN' ? ' (' + writerDominance.strength.toLowerCase() + ')' : '') + '.');
  thesisParts.push('PE wall at ' + peWall + ', CE wall at ' + ceWall +
    '; spot trading ' + (spot > maxPain ? 'above' : 'below') + ' max pain (' + maxPain + ').');
  if (strategy === 'WAIT') {
    thesisParts.push('No edge at current readings; ' + strategyHuman + ' until structure or volatility shifts.');
  } else if (ivRegime === 'HIGH') {
    thesisParts.push('Elevated IV (' + avgIV.toFixed(1) + ' pct) favours premium selling; ' + strategyHuman + ' offers defined-risk theta exposure consistent with the ' + dirWord + ' read.');
  } else if (ivRegime === 'LOW') {
    thesisParts.push('Low IV (' + avgIV.toFixed(1) + ' pct) favours long premium; ' + strategyHuman + ' aligns with the ' + dirWord + ' read.');
  } else {
    thesisParts.push('IV at ' + avgIV.toFixed(1) + ' pct is mid-regime; ' + strategyHuman + ' fits the ' + dirWord + ' structure.');
  }
  const thesis = thesisParts.join(' ');

  // --- Counterarguments (the honest case against the current read) ---
  const counterarguments = [];
  const isBullBias = totalScore >= 10;
  const isBearBias = totalScore <= -10;
  if (isBullBias) {
    if (oiScore < 0) counterarguments.push('OI structure still leans bearish');
    if (priceScore < 0) counterarguments.push('Spot below max pain (' + maxPain + ')');
    if ((ceWall - spot) / spot < 0.008) counterarguments.push('CE wall at ' + ceWall + ' sits just overhead');
    if (ivState === 'CONTRADICTS') counterarguments.push('High IV undercuts the bullish read');
  } else if (isBearBias) {
    if (oiScore > 0) counterarguments.push('OI structure still leans bullish');
    if (priceScore > 0) counterarguments.push('Spot above max pain (' + maxPain + ')');
    if ((spot - peWall) / spot < 0.008) counterarguments.push('PE wall at ' + peWall + ' sits just below');
    if (ivState === 'CONTRADICTS') counterarguments.push('Low IV undercuts the bearish read');
  } else {
    counterarguments.push('A decisive break of either wall voids the range-bound thesis');
    if (breakoutRisk !== 'LOW') counterarguments.push('Breakout risk currently ' + breakoutRisk.toLowerCase());
  }
  if (confidence < 50) counterarguments.push('Conviction below 50 - modest signal strength');

  // --- Strategy invalidation conditions ---
  let invalidation = [];
  if (tradeLegs) {
    if (strategy === 'BEAR_CALL_SPREAD') invalidation = [
      'Spot closes above breakeven (' + tradeLegs.breakeven + ')',
      'PCR climbs above 1.2 (positioning turns bullish)',
      'IV regime drops to LOW (credit thesis void)'
    ];
    else if (strategy === 'BULL_PUT_SPREAD') invalidation = [
      'Spot closes below breakeven (' + tradeLegs.breakeven + ')',
      'PCR falls below 0.8 (positioning turns bearish)',
      'IV regime drops to LOW (credit thesis void)'
    ];
    else if (strategy === 'IRON_CONDOR') invalidation = [
      'Spot closes beyond ' + tradeLegs.breakevenLow + ' / ' + tradeLegs.breakevenHigh,
      'Either wall (PE ' + peWall + ' / CE ' + ceWall + ') breaks with OI unwinding',
      'IV regime drops to LOW (premium collection thesis void)'
    ];
    else if (strategy === 'LONG_CALL') invalidation = [
      'Spot closes below support (' + support.strike + ')',
      'Bias flips bearish on PCR breakdown',
      'IV spikes sharply (fresh entries overpay for premium)'
    ];
    else if (strategy === 'LONG_PUT') invalidation = [
      'Spot closes above resistance (' + resistance.strike + ')',
      'Bias flips bullish on PCR recovery',
      'IV spikes sharply (fresh entries overpay for premium)'
    ];
  }

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
    explain: { factors, signalGrade, thesis, counterarguments, invalidation },
    expectedMove: { points: expectedMovePts, low: emLow, high: emHigh, strikeSafety },
    structure: { writerDominance, peWall, ceWall, rangeWidth, rangePct, compression, breakoutRisk, premiumSelling },
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
    console.log('[upstox] expiries returned:', JSON.stringify(expiries.slice(0, 3)));
    const nearestExpiry = expiries[0];
    const chain = await fetchUpstoxChain(nearestExpiry);
    const result = analyse(chain, nearestExpiry);
    if (result) {
      lastResult = result;
      lastFetchTime = Date.now();
      fetchErrorCount = 0;
      lastError = null;
      // Append slim snapshot to history for session grading
      history.push({
        ts: result.timestamp,
        spot: result.spot,
        bias: result.bias,
        biasLabel: result.biasLabel,
        confidence: result.confidence,
        pcr: result.pcr,
        ivRegime: result.ivRegime,
        avgIV: result.avgIV,
        strategy: result.decision?.strategy,
        signalGrade: result.explain?.signalGrade,
        tradeLegs: result.decision?.tradeLegs
      });
      if (history.length > HISTORY_LIMIT) history.shift();
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

// History endpoint - last N poll snapshots for session grading
// Query: ?limit=N (default 100, max HISTORY_LIMIT), ?since=ISO (filter by timestamp)
app.get('/history', (req, res) => {
  const limit = Math.min(HISTORY_LIMIT, parseInt(req.query.limit, 10) || 100);
  const since = req.query.since ? new Date(req.query.since).getTime() : 0;
  let slice = history;
  if (since) slice = slice.filter(h => new Date(h.ts).getTime() >= since);
  res.json({ count: slice.length, total: history.length, entries: slice.slice(-limit) });
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log('EDGE backend on port', PORT);
  const probeUrl = new URL('https://api.upstox.com/v2/option/contract');
  probeUrl.searchParams.set('instrument_key', 'NSE_INDEX|Nifty 50');
  console.log('[upstox] expiry URL constructed:', probeUrl.toString());
  poll();
});
