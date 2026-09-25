'use strict';

/**
 * Entry engine.
 *
 * Converts a qualified setup into a conditional execution plan.
 * It does not predict future prices. "READY_TO_ENTER" means the current
 * snapshot satisfies the engine's trigger conditions; otherwise the setup
 * remains WAIT_FOR_TRIGGER.
 *
 * Premium zones are execution zones derived from the current LTP/bid/ask.
 * They are not guarantees of fill.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(v.toFixed(dp));
}

function validQuote(leg) {
  return leg && n(leg.bid) !== null && n(leg.ask) !== null &&
    n(leg.bid) >= 0 && n(leg.ask) >= n(leg.bid);
}

function creditQuote(tradeLegs) {
  if (tradeLegs.ceShort && tradeLegs.ceLong && tradeLegs.peShort && tradeLegs.peLong &&
      validQuote(tradeLegs.ceShort) && validQuote(tradeLegs.ceLong) &&
      validQuote(tradeLegs.peShort) && validQuote(tradeLegs.peLong)) {
    const executable = n(tradeLegs.ceShort.bid) - n(tradeLegs.ceLong.ask) +
      n(tradeLegs.peShort.bid) - n(tradeLegs.peLong.ask);
    const indicative = n(tradeLegs.netCredit);
    if (executable > 0 && indicative !== null && indicative > 0) {
      return { executable: round(executable), indicative: round(indicative), spreadCost: round(Math.max(0, indicative - executable)) };
    }
  }

  const shortLeg = tradeLegs.sellLeg;
  const longLeg = tradeLegs.buyLeg;
  if (!validQuote(shortLeg) || !validQuote(longLeg)) return null;

  const executable = n(shortLeg.bid) - n(longLeg.ask);
  const indicative = n(tradeLegs.netCredit);
  if (executable <= 0 || indicative === null || indicative <= 0) return null;

  return {
    executable: round(executable),
    indicative: round(indicative),
    spreadCost: round(Math.max(0, indicative - executable))
  };
}

function verticalDebitQuote(tradeLegs) {
  if (!validQuote(tradeLegs?.buyLeg) || !validQuote(tradeLegs?.sellLeg)) return null;
  const executable=n(tradeLegs.buyLeg.ask)-n(tradeLegs.sellLeg.bid);
  const indicative=n(tradeLegs.netDebit);
  if (executable<=0 || indicative===null || indicative<=0) return null;
  return {executable:round(executable),indicative:round(indicative),spreadCost:round(Math.max(0,executable-indicative))};
}

function debitQuote(tradeLegs) {
  const leg = tradeLegs.buyLeg;
  if (!validQuote(leg)) return null;

  return {
    executable: round(n(leg.ask)),
    indicative: round(n(leg.premium)),
    bid: round(n(leg.bid))
  };
}

function flowLabel(features) {
  return features?.optionFlow?.aggregate?.label || 'UNAVAILABLE';
}

function buildTrigger({ strategy, spot, support, resistance, ceWall, peWall, regime, features, tradeLegs }) {
  const s = n(spot);
  const sup = n(support);
  const res = n(resistance);
  const ce = n(ceWall);
  const pe = n(peWall);
  const trend = n(features?.trend30mPct);
  const session = n(features?.sessionChangePct);
  const flow = flowLabel(features);
  const bearishFlow = flow === 'BEARISH_FLOW';
  const bullishFlow = flow === 'BULLISH_FLOW';
  const mixedFlow = flow === 'MIXED_FLOW' || flow === 'UNAVAILABLE';

  if ([s, sup, res].some(v => v === null)) {
    return { status: 'WAIT_FOR_TRIGGER', trigger: 'Price structure unavailable', reason: 'Missing support/resistance data.' };
  }

  if (strategy === 'BEAR_CALL_SPREAD') {
    const shortStrike = n(tradeLegs?.sellLeg?.strike);
    const belowShort = tradeShortCondition(s, shortStrike);
    const bearishConfirmation = (trend !== null && trend <= 0) || (session !== null && session <= 0) || bearishFlow;
    const rejectionZone = ce !== null && s <= ce && s >= res;
    const ready = belowShort && bearishConfirmation;
    return {
      status: ready ? 'READY_TO_ENTER' : 'WAIT_FOR_TRIGGER',
      trigger: belowShort
        ? 'Spot remains below the short-call resistance with bearish confirmation.'
        : 'Wait for rejection below the short-call resistance.',
      reason: ready ? 'Price and directional evidence are aligned.' :
        rejectionZone ? 'Spot is near resistance; wait for confirmation.' :
        'Short-call resistance has not produced a confirmed rejection.',
      evidence: { belowShort, bearishConfirmation, rejectionZone, flow, trend30mPct: trend }
    };
  }

  if (strategy === 'BULL_PUT_SPREAD') {
    const shortStrike = n(tradeLegs?.sellLeg?.strike);
    const aboveShort = shortStrike !== null ? s > shortStrike : (pe !== null ? s > pe : s > sup);
    const bullishConfirmation = (trend !== null && trend >= 0) || (session !== null && session >= 0) || bullishFlow;
    const supportHold = s >= sup;
    const ready = aboveShort && supportHold && bullishConfirmation;
    return {
      status: ready ? 'READY_TO_ENTER' : 'WAIT_FOR_TRIGGER',
      trigger: ready
        ? 'Spot is holding support with bullish confirmation.'
        : 'Wait for a confirmed support hold before selling the put spread.',
      reason: ready ? 'Price and directional evidence are aligned.' :
        s < sup ? 'Support is under pressure; no entry until it is reclaimed/held.' :
        'Support hold lacks sufficient confirmation.',
      evidence: { aboveShort, supportHold, bullishConfirmation, flow, trend30mPct: trend }
    };
  }

  if (strategy === 'BULL_CALL_SPREAD') {
    const reclaim=s>=res;
    const momentum=(trend!==null&&trend>0)||(session!==null&&session>0)||bullishFlow;
    const ready=reclaim&&momentum;
    return {status:ready?'READY_TO_ENTER':'WAIT_FOR_TRIGGER',trigger:'Wait for resistance reclaim with positive momentum before paying the debit.',reason:ready?'Bullish structure confirmed.':'Debit spread needs breakout confirmation.',evidence:{reclaim,momentum,flow,trend30mPct:trend}};
  }

  if (strategy === 'BEAR_PUT_SPREAD') {
    const breakdown=s<=sup;
    const momentum=(trend!==null&&trend<0)||(session!==null&&session<0)||bearishFlow;
    const ready=breakdown&&momentum;
    return {status:ready?'READY_TO_ENTER':'WAIT_FOR_TRIGGER',trigger:'Wait for support break with negative momentum before paying the debit.',reason:ready?'Bearish structure confirmed.':'Debit spread needs breakdown confirmation.',evidence:{breakdown,momentum,flow,trend30mPct:trend}};
  }

  if (strategy === 'LONG_CALL') {
    const reclaim = s >= res;
    const momentum = (trend !== null && trend > 0) || (session !== null && session > 0) || bullishFlow;
    const ready = reclaim && momentum;
    return {
      status: ready ? 'READY_TO_ENTER' : 'WAIT_FOR_TRIGGER',
      trigger: 'Wait for spot to reclaim resistance with positive momentum.',
      reason: ready ? 'Resistance reclaimed with directional confirmation.' : 'Breakout confirmation is still required.',
      evidence: { reclaim, momentum, flow, trend30mPct: trend }
    };
  }

  if (strategy === 'LONG_PUT') {
    const breakdown = s <= sup;
    const momentum = (trend !== null && trend < 0) || (session !== null && session < 0) || bearishFlow;
    const ready = breakdown && momentum;
    return {
      status: ready ? 'READY_TO_ENTER' : 'WAIT_FOR_TRIGGER',
      trigger: 'Wait for spot to break support with negative momentum.',
      reason: ready ? 'Support broken with directional confirmation.' : 'Breakdown confirmation is still required.',
      evidence: { breakdown, momentum, flow, trend30mPct: trend }
    };
  }

  if (strategy === 'IRON_CONDOR') {
    const insideRange = pe !== null && ce !== null && s > pe && s < ce;
    const nonDirectional = mixedFlow || (!bullishFlow && !bearishFlow);
    const ready = insideRange && nonDirectional;
    return {
      status: ready ? 'READY_TO_ENTER' : 'WAIT_FOR_TRIGGER',
      trigger: 'Spot remains between short strikes without a directional flow imbalance.',
      reason: ready ? 'Range conditions are present.' : 'Wait for range stability; avoid entry during directional expansion.',
      evidence: { insideRange, nonDirectional, flow }
    };
  }

  return { status: 'WAIT_FOR_TRIGGER', trigger: 'No entry rule for this strategy.', reason: 'Strategy is not entry-engine compatible.' };
}

function tradeShortCondition(spot, shortStrike) {
  return shortStrike === null ? false : spot < shortStrike;
}

function buildPremiumZone(strategy, tradeLegs) {
  if (!tradeLegs) return { available: false, reason: 'Trade legs unavailable.' };

  if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    const q = creditQuote(tradeLegs);
    const current = n(tradeLegs.netCredit);
    if (q && current !== null) {
      return {
        available: true,
        type: 'NET_CREDIT',
        low: q.executable,
        high: q.indicative,
        doNotChaseBelow: q.executable,
        basis: 'Current executable credit from short-leg bid minus long-leg ask; indicative credit uses current LTPs.'
      };
    }
    if (current !== null && current > 0) {
      return {
        available: true,
        type: 'NET_CREDIT',
        low: round(current * 0.97),
        high: round(current),
        doNotChaseBelow: round(current * 0.97),
        basis: 'Current net credit; bid/ask unavailable, so zone is indicative only.'
      };
    }
  }

  if (strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD') {
    const q=verticalDebitQuote(tradeLegs);
    const current=n(tradeLegs.netDebit);
    if(q) return {available:true,type:'NET_DEBIT',low:q.indicative,high:q.executable,doNotChaseAbove:round(q.executable*1.05),basis:'Executable debit uses long-leg ask minus short-leg bid.'};
    if(current!==null&&current>0) return {available:true,type:'NET_DEBIT',low:round(current),high:round(current*1.03),doNotChaseAbove:round(current*1.08),basis:'Indicative net debit; complete bid/ask unavailable.'};
  }

  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    const q = debitQuote(tradeLegs);
    const current = n(tradeLegs.buyLeg?.premium);
    if (q) {
      return {
        available: true,
        type: 'PREMIUM_DEBIT',
        low: q.indicative,
        high: q.executable,
        doNotChaseAbove: round(q.executable * 1.05),
        basis: 'Current LTP to executable ask.'
      };
    }
    if (current !== null && current > 0) {
      return {
        available: true,
        type: 'PREMIUM_DEBIT',
        low: round(current),
        high: round(current * 1.03),
        doNotChaseAbove: round(current * 1.08),
        basis: 'Current LTP; bid/ask unavailable, so zone is indicative only.'
      };
    }
  }

  return { available: false, reason: 'Premium data unavailable.' };
}

function evaluateExecution(strategy, premium) {
  if (!premium?.available) return { status:'PRICE_UNAVAILABLE', executable:false, current:null, reason:premium?.reason || 'Executable quote unavailable.' };
  const current = strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR'
    ? n(premium.low) : n(premium.high);
  if (current === null) return { status:'PRICE_UNAVAILABLE', executable:false, current:null, reason:'Executable quote unavailable.' };

  if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    const floor=n(premium.doNotChaseBelow);
    const ok=floor===null||current>=floor;
    return {status:ok?'PRICE_OK':'PRICE_TOO_LOW',executable:ok,current,limit:floor,reason:ok?'Executable credit is acceptable.':'Credit has fallen below the minimum acceptable level.'};
  }
  const ceiling=n(premium.doNotChaseAbove);
  const ok=ceiling===null||current<=ceiling;
  return {status:ok?'PRICE_OK':'PRICE_TOO_HIGH',executable:ok,current,limit:ceiling,reason:ok?'Executable debit is acceptable.':'Premium is above the do-not-chase ceiling.'};
}

function calculateValidity(strategy, dte, marketPhase, minutesRemaining = null) {
  if (marketPhase !== 'OPEN') return { validForMinutes: 0, maxHoldMinutes: 0, sessionCapped: false };
  let base;
  if (dte <= 0) base = { validForMinutes: 10, maxHoldMinutes: 60 };
  else if (strategy === 'IRON_CONDOR') base = { validForMinutes: 20, maxHoldMinutes: 150 };
  else if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD') base = { validForMinutes: 15, maxHoldMinutes: 120 };
  else base = { validForMinutes: 10, maxHoldMinutes: 90 };

  if (!Number.isFinite(Number(minutesRemaining))) return { ...base, sessionCapped: false };
  const remaining = Math.max(0, Math.floor(Number(minutesRemaining)));
  return {
    validForMinutes: Math.min(base.validForMinutes, remaining),
    maxHoldMinutes: Math.min(base.maxHoldMinutes, remaining),
    sessionCapped: remaining < base.maxHoldMinutes,
    minutesRemaining: remaining
  };
}

function buildEntryPlan(input) {
  const {
    strategy, spot, support, resistance, ceWall, peWall, expectedMove,
    tradeLegs, regime, features, marketPhase, dte, minutesRemaining
  } = input;

  if (!strategy || strategy === 'WAIT' || !tradeLegs) {
    return {
      status: 'NO_ENTRY',
      type: 'NONE',
      reason: 'No qualified trade structure.'
    };
  }

  const trigger = buildTrigger({
    strategy, spot, support, resistance, ceWall, peWall, regime, features,
    tradeLegs
  });

  const premium = buildPremiumZone(strategy, tradeLegs);
  const timing = calculateValidity(strategy, dte, marketPhase, minutesRemaining);
  const execution = evaluateExecution(strategy, premium);
  const triggerReady = trigger.status === 'READY_TO_ENTER';
  const priceReady = execution.executable;
  const finalStatus = triggerReady && priceReady ? 'READY_TO_ENTER' :
    triggerReady && !priceReady ? 'WAIT_FOR_PRICE' : 'WAIT_FOR_TRIGGER';
  const displayState = finalStatus === 'READY_TO_ENTER' ? 'BUY_NOW' :
    finalStatus === 'WAIT_FOR_PRICE' ? 'TRIGGER_HIT_PRICE_BAD' :
    priceReady ? 'PRICE_OK_WAITING_TRIGGER' : 'WAITING_TRIGGER_AND_PRICE';

  const invalidation = [];
  const s = n(spot);
  if (strategy === 'BEAR_CALL_SPREAD' && n(tradeLegs.sellLeg?.strike) !== null) {
    invalidation.push('Spot sustains above short call ' + tradeLegs.sellLeg.strike);
  } else if (strategy === 'BULL_PUT_SPREAD' && n(tradeLegs.sellLeg?.strike) !== null) {
    invalidation.push('Spot sustains below short put ' + tradeLegs.sellLeg.strike);
  } else if (strategy === 'BULL_CALL_SPREAD') {
    invalidation.push('Spot loses the reclaimed bullish structure');
  } else if (strategy === 'BEAR_PUT_SPREAD') {
    invalidation.push('Spot reclaims the broken bearish structure');
  } else if (strategy === 'LONG_CALL') {
    invalidation.push('Spot loses the reclaimed resistance/support structure');
  } else if (strategy === 'LONG_PUT') {
    invalidation.push('Spot reclaims the broken support/resistance structure');
  } else if (strategy === 'IRON_CONDOR') {
    invalidation.push('Spot exits the short-strike range with directional flow');
  }

  return {
    status: finalStatus,
    displayState,
    triggerStatus: trigger.status,
    triggerReady,
    execution,
    priceReady,
    type: strategy === 'LONG_CALL' || strategy === 'LONG_PUT' ? 'PREMIUM_ZONE' : (strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD' ? 'NET_DEBIT_ZONE' : 'NET_CREDIT_ZONE'),
    trigger: trigger.trigger,
    reason: finalStatus === 'READY_TO_ENTER' ? 'Trigger confirmed and executable price is acceptable.' : (finalStatus === 'WAIT_FOR_PRICE' ? execution.reason : trigger.reason),
    evidence: trigger.evidence,
    premium,
    timing,
    invalidation,
    snapshot: {
      spot: s,
      support: n(support),
      resistance: n(resistance),
      expectedMoveLow: n(expectedMove?.low),
      expectedMoveHigh: n(expectedMove?.high),
      regime: regime?.direction || null
    }
  };
}

module.exports = { buildEntryPlan };
