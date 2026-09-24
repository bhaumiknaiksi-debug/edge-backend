'use strict';

/**
 * Outcome engine for captured EDGE decisions.
 * Uses subsequent historical option candles only; it never generates a signal.
 *
 * Upstox expired candles provide OHLC/OI rather than historical bid/ask.
 * Multi-leg exits therefore use a conservative OHLC envelope.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function ts(v) {
  const x = new Date(v).getTime();
  return Number.isFinite(x) ? x : null;
}

function round(v, dp = 2) {
  return Number(v.toFixed(dp));
}

function keyOf(leg) {
  return leg?.instrumentKey || leg?.instrument_key || leg?.id || leg?.key || null;
}

function candleMap(candles) {
  const map = new Map();
  for (const c of candles || []) {
    if (!c || !c.instrumentKey || ts(c.timestamp) === null) continue;
    if (!map.has(c.instrumentKey)) map.set(c.instrumentKey, []);
    map.get(c.instrumentKey).push(c);
  }
  for (const rows of map.values()) rows.sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
  return map;
}

function eventBase(status, reason, entryTimestamp, exitTimestamp) {
  const a = ts(entryTimestamp), b = ts(exitTimestamp);
  return {
    status,
    reason,
    entryTimestamp,
    exitTimestamp,
    holdMinutes: a !== null && b !== null ? round((b - a) / 60000, 2) : null
  };
}

function getEntryPrice(decision, strategy) {
  const p = decision?.entry?.premium || {};
  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    return n(decision?.fill?.entryPrice ?? decision?.tradeLegs?.buyLeg?.premium ?? p.high ?? p.low);
  }
  return n(decision?.fill?.entryCredit ?? decision?.tradeLegs?.netCredit ?? p.low ?? p.high);
}

function evaluateLong(decision, rows, entry, stop, target1, target2) {
  let target1Hit = false;
  let points = 0;
  const path = [];

  for (const c of rows) {
    const high = n(c.high), low = n(c.low);
    if (high === null || low === null) continue;

    // Conservative intrabar rule: STOP wins if stop and target are both touched.
    if (low <= stop) {
      points += target1Hit
        ? 0.5 * (target1 - entry) + 0.5 * (stop - entry)
        : stop - entry;
      path.push({ timestamp: c.timestamp, event: 'STOP', price: stop });
      return {
        ...eventBase('STOP', 'Stop premium reached.', decision.timestamp, c.timestamp),
        entryPrice: round(entry), exitPrice: round(stop), pnlPoints: round(points),
        target1Hit, path
      };
    }

    if (!target1Hit && high >= target1) {
      target1Hit = true;
      points += 0.5 * (target1 - entry);
      path.push({ timestamp: c.timestamp, event: 'TARGET1', price: target1, quantityFraction: 0.5 });
    }

    if (high >= target2) {
      points += target1Hit ? 0.5 * (target2 - entry) : target2 - entry;
      path.push({ timestamp: c.timestamp, event: 'TARGET2', price: target2 });
      return {
        ...eventBase('TARGET2', 'Second profit target reached.', decision.timestamp, c.timestamp),
        entryPrice: round(entry), exitPrice: round(target2), pnlPoints: round(points),
        target1Hit, path
      };
    }
  }

  const last = rows[rows.length - 1];
  if (!last || n(last.close) === null) return { status: 'NO_DATA', reason: 'No usable subsequent option candle.' };
  const exit = n(last.close);
  points += target1Hit ? 0.5 * (exit - entry) : exit - entry;
  path.push({ timestamp: last.timestamp, event: 'TIME_EXIT', price: exit });

  return {
    ...eventBase('TIME_EXIT', 'Maximum holding period reached.', decision.timestamp, last.timestamp),
    entryPrice: round(entry), exitPrice: round(exit), pnlPoints: round(points),
    target1Hit, path
  };
}

function evaluateCredit(decision, map, startMs, endMs, entry, stop, target1, target2) {
  const tl = decision.tradeLegs || {};
  const ic = decision.strategy === 'IRON_CONDOR';

  let legs;
  if (ic) {
    legs = {
      ceShort: keyOf(tl.ceShort), ceLong: keyOf(tl.ceLong),
      peShort: keyOf(tl.peShort), peLong: keyOf(tl.peLong)
    };
  } else if (tl.sellLeg?.type === 'CE') {
    legs = { short: keyOf(tl.sellLeg), long: keyOf(tl.buyLeg) };
  } else {
    legs = { short: keyOf(tl.sellLeg), long: keyOf(tl.buyLeg) };
  }

  const required = Object.values(legs).filter(Boolean);
  if (!required.length || required.some(k => !map.has(k))) {
    return { status: 'NO_DATA', reason: 'Required historical option-leg candles are missing.' };
  }

  const times = [...new Set(required.flatMap(k => map.get(k).map(c => c.timestamp)))]
    .map(ts).filter(t => t >= startMs && t <= endMs).sort((a, b) => a - b);

  let target1Hit = false;
  let points = 0;
  const path = [];
  let lastMark = null;

  for (const t of times) {
    const rows = {};
    let complete = true;
    for (const [name, key] of Object.entries(legs)) {
      rows[name] = map.get(key).find(c => ts(c.timestamp) === t);
      if (!rows[name]) complete = false;
    }
    if (!complete) continue;

    let mark;
    if (ic) {
      const a = rows.ceShort, b = rows.ceLong, c = rows.peShort, d = rows.peLong;
      mark = {
        close: (n(b.close) + n(d.close)) - (n(a.close) + n(c.close)),
        lower: (n(b.low) + n(d.low)) - (n(a.high) + n(c.high)),
        upper: (n(b.high) + n(d.high)) - (n(a.low) + n(c.low))
      };
    } else {
      const s = rows.short, l = rows.long;
      mark = {
        close: n(l.close) - n(s.close),
        lower: n(l.low) - n(s.high),
        upper: n(l.high) - n(s.low)
      };
    }

    if ([mark.close, mark.lower, mark.upper].some(v => v === null)) continue;
    lastMark = { timestamp: rows[Object.keys(rows)[0]].timestamp, ...mark };

    // STOP first on ambiguous OHLC candles.
    if (mark.upper >= stop) {
      points += target1Hit
        ? 0.5 * (entry - target1) + 0.5 * (entry - stop)
        : entry - stop;
      path.push({ timestamp: lastMark.timestamp, event: 'STOP', price: stop });
      return {
        ...eventBase('STOP', 'Spread debit reached the management stop.', decision.timestamp, lastMark.timestamp),
        entryPrice: round(entry), exitPrice: round(stop), pnlPoints: round(points),
        target1Hit, path, markModel: 'CONSERVATIVE_OHLC_ENVELOPE'
      };
    }

    if (!target1Hit && mark.lower <= target1) {
      target1Hit = true;
      points += 0.5 * (entry - target1);
      path.push({ timestamp: lastMark.timestamp, event: 'TARGET1', price: target1, quantityFraction: 0.5 });
    }

    if (mark.lower <= target2) {
      points += target1Hit ? 0.5 * (entry - target2) : entry - target2;
      path.push({ timestamp: lastMark.timestamp, event: 'TARGET2', price: target2 });
      return {
        ...eventBase('TARGET2', 'Second profit target reached.', decision.timestamp, lastMark.timestamp),
        entryPrice: round(entry), exitPrice: round(target2), pnlPoints: round(points),
        target1Hit, path, markModel: 'CONSERVATIVE_OHLC_ENVELOPE'
      };
    }
  }

  if (!lastMark) return { status: 'NO_DATA', reason: 'No complete multi-leg candle in evaluation window.' };

  points += target1Hit
    ? 0.5 * (entry - lastMark.close)
    : entry - lastMark.close;
  path.push({ timestamp: lastMark.timestamp, event: 'TIME_EXIT', price: lastMark.close });

  return {
    ...eventBase('TIME_EXIT', 'Maximum holding period reached.', decision.timestamp, lastMark.timestamp),
    entryPrice: round(entry), exitPrice: round(lastMark.close), pnlPoints: round(points),
    target1Hit, path, markModel: 'CONSERVATIVE_OHLC_ENVELOPE'
  };
}

function evaluateOutcome(input) {
  const decision = input?.decision;
  if (!decision) throw new Error('decision is required');

  const strategy = decision.strategy;
  const supported = ['LONG_CALL', 'LONG_PUT', 'BEAR_CALL_SPREAD', 'BULL_PUT_SPREAD', 'IRON_CONDOR'];
  if (!supported.includes(strategy)) return { status: 'NOT_EXECUTED', reason: 'Unsupported or non-trading strategy.' };
  if (decision.orchestration?.executionAllowed === false) return { status: 'NOT_EXECUTED', reason: 'Decision was not execution-allowed.' };

  const startMs = ts(decision.fill?.entryTimestamp || decision.timestamp);
  if (startMs === null) return { status: 'NO_DATA', reason: 'Decision timestamp is invalid.' };

  const hold = n(decision.risk?.maxHoldMinutes) ?? n(decision.entry?.timing?.maxHoldMinutes) ?? 120;
  const endMs = startMs + hold * 60000;
  const entry = getEntryPrice(decision, strategy);
  if (entry === null || entry <= 0) return { status: 'NO_DATA', reason: 'Entry premium/credit is unavailable.' };

  const map = candleMap(input.futureCandles?.candles || input.futureCandles || []);
  const lots = n(input.lots) ?? n(decision.position?.recommendedLots) ?? 1;
  const lotSize = n(decision.tradeLegs?.lotSize) ?? n(decision.tradeLegs?.sellLeg?.lotSize) ??
    n(decision.tradeLegs?.buyLeg?.lotSize) ?? n(input.lotSize) ?? 65;
  const costsPerLot = n(input.costsPerLot) ?? 0;

  const stop = n(decision.risk?.stop?.value);
  const target1 = n(decision.risk?.target1?.value);
  const target2 = n(decision.risk?.target2?.value);
  if ([stop, target1, target2].some(v => v === null)) return { status: 'NO_DATA', reason: 'Risk thresholds are missing.' };

  let raw;
  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    const leg = decision.tradeLegs?.buyLeg;
    const key = keyOf(leg);
    const rows = key && map.has(key)
      ? map.get(key).filter(c => ts(c.timestamp) >= startMs && ts(c.timestamp) <= endMs)
      : [];
    if (!rows.length) return { status: 'NO_DATA', reason: 'Directional option candles are missing.' };
    raw = evaluateLong(decision, rows, entry, stop, target1, target2);
  } else {
    raw = evaluateCredit(decision, map, startMs, endMs, entry, stop, target1, target2);
  }

  if (!raw || ['NO_DATA', 'NOT_EXECUTED'].includes(raw.status)) return raw;

  const pnlBeforeCosts = raw.pnlPoints * lotSize * lots;
  const costs = costsPerLot * lots;
  const pnlRupees = pnlBeforeCosts - costs;
  const riskPoints = strategy === 'LONG_CALL' || strategy === 'LONG_PUT'
    ? Math.abs(entry - stop)
    : Math.max(0, n(decision.risk?.maxLossPoints) ?? Math.abs(entry - stop));
  const riskRupees = riskPoints * lotSize * lots;

  return {
    ...raw,
    strategy,
    lots,
    lotSize,
    pnlBeforeCostsRupees: round(pnlBeforeCosts),
    costsRupees: round(costs),
    pnlRupees: round(pnlRupees),
    riskRupees: round(riskRupees),
    rMultiple: riskRupees > 0 ? round(pnlRupees / riskRupees, 4) : null,
    fillModel: input.fillModel || 'DECISION_SNAPSHOT_ENTRY',
    costModel: costsPerLot > 0 ? 'CONFIGURED_PER_LOT_COST' : 'NO_COSTS_CONFIGURED'
  };
}

module.exports = { evaluateOutcome, candleMap, keyOf };
