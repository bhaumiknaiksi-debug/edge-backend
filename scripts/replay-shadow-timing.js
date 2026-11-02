'use strict';
// Diagnostic only: replays sessions through the REAL timing rule (V2 or V3), candidate selection and paper
// executor entry gates, poll by poll, and compares V2 with V3. No network, broker, database or server state.
//
//   node scripts/replay-shadow-timing.js            # built-in session shapes x data conditions
//   node scripts/replay-shadow-timing.js --json     # machine-readable
//
// Session shapes are constructed, not recorded market data: they exercise the state handling under known
// conditions. Scope: ENTRY ELIGIBILITY only (the executor's planEntry returning QUEUED). There is no paper-broker
// fill, protective stop, target or exit in this replay; a queued trade is simply closed after 15 minutes so later
// entries are possible. P&L and the full order lifecycle are not measured here. Ground truth comes from the final, clean candles: a "genuine opportunity" is a completed close
// crossing the opening range with the regime aligned within 10 minutes of the crossing.
const { buildTimingSource, createShadowTiming } = require('../src/engine/shadowTiming');
const { createShadowTimingV3 } = require('../src/engine/shadowTimingV3');
const E = require('../src/execution/sandboxEngine');

const DAY = '2026-11-02', FIVE = 300000, POLL = 38000, HOLD = 15 * 60000, WINDOW = 10 * 60000;
const T = s => Date.parse(DAY + 'T' + s + ':00+05:30');
const HIGH = 24100, LOW = 24020, OPEN = T('09:15'), OR_END = T('09:30');
const hhmm = t => new Date(t + 19800000).toISOString().slice(11, 16);

// --- session shapes: close of each 5-minute bar from 09:30, until 13:00 (42 bars) ---
function path(points) { // [[time, close], ...] linear between anchors
  const out = [];
  for (let t = OR_END; t < T('13:00'); t += FIVE) {
    const i = points.findIndex(p => T(p[0]) > t);
    const a = points[Math.max(0, i - 1)], b = points[i === -1 ? points.length - 1 : i];
    const ta = T(a[0]), tb = T(b[0]);
    out.push(tb === ta ? b[1] : a[1] + (b[1] - a[1]) * (t - ta) / (tb - ta));
  }
  return out.map(x => Math.round(x * 100) / 100);
}
const SHAPES = {
  'late breakout, trend': { closes:path([['09:30',24060],['10:25',24085],['10:30',24112],['13:00',24180]]), regimeFrom:'09:30', dir:'UP' },
  'early breakout, trend': { closes:path([['09:30',24070],['09:35',24095],['09:40',24115],['13:00',24210]]), regimeFrom:'09:30', dir:'UP' },
  'false break then re-break': { closes:path([['09:30',24060],['10:25',24090],['10:30',24112],['10:35',24104],['10:40',24090],['11:25',24080],['11:30',24115],['13:00',24160]]), regimeFrom:'09:30', dir:'UP' },
  'range day': { closes:path([['09:30',24060],['10:30',24095],['11:30',24030],['12:30',24090],['13:00',24060]]), regimeFrom:'09:30', dir:'UP' },
  'breakdown': { closes:path([['09:30',24050],['10:55',24030],['11:00',24008],['13:00',23930]]), regimeFrom:'09:30', dir:'DOWN' },
};
// --- data conditions applied on top of a shape ---
const CONDITIONS = {
  'clean, regime aligned': {},
  'regime aligns 6 min after break': { regimeDelay:6 * 60000 },
  'regime aligns 15 min after break': { regimeDelay:15 * 60000 },
  'regime flickers neutral': { flicker:true },
  'newest candle provisional for 40s': { provisional:true },
  'settled revision of crossing candle': { settledRevision:true },
  'intermittent fetch failures': { fetchFail:true },
  'ATM strike rolls': { rolls:true },
  'quote too wide for 3 min after break': { wideQuote:3 * 60000 },
  'server restart 1 min after break': { restartAfter:60000 },
  'newest candle missing every 3rd poll': { dropNewest:true },
};

function crossings(closes, dir) { // ground truth from final clean data
  const level = dir === 'UP' ? HIGH : LOW, beyond = c => dir === 'UP' ? c > level : c < level, out = [];
  let prev = 24060, active = false;
  closes.forEach((c, i) => {
    if (active && !beyond(c)) active = false;
    else if (!active && !beyond(prev) && beyond(c)) { active = true; out.push(OR_END + i * FIVE + FIVE); }
    prev = c;
  });
  return out;
}

function simulate(version, shape, cond) {
  const s = SHAPES[shape], c = CONDITIONS[cond], dir = s.dir;
  const breaks = crossings(s.closes, dir);
  const alignAt = c.regimeDelay !== undefined && breaks.length ? breaks[0] + c.regimeDelay : T(s.regimeFrom);
  const make = () => version === 'V3' ? createShadowTimingV3() : createShadowTiming();
  let evaluate = make(), restarted = false;
  const state = E.initialState();
  E.configurePolicy(state, { requestId:'replay-policy-000001', dailyGoal:1000, dailyLoss:1000, perTradeRisk:1000, entryMode:'OPENING_RANGE_SHADOW_V1' }, OPEN);
  E.recover(state, 'replay'); E.reconcile(state, [], [], T('09:30')); E.control(state, 'ARM', 'replay-arm-00000001', T('09:30'));
  const entries = [], confirmed = new Set(); let poll = 0;
  for (let now = OR_END + 5000; now < T('13:00'); now += POLL, poll++) {
    // close a paper trade after HOLD so later entries are possible (exits are not what is being compared)
    for (const t of Object.values(state.trades)) if (!t.closedAt && now - t.createdAt >= HOLD) { t.closedAt = now; t.buys = 65; t.netPnl = 0; }
    for (const o of Object.values(state.orders)) o.state = 'COMPLETE';
    state.reconciledAt = now;
    if (c.restartAfter && !restarted && breaks.length && now >= breaks[0] + c.restartAfter) { evaluate = make(); restarted = true; }
    const done = Math.floor((now - OR_END) / FIVE); // completed bars after the range
    const rows = [[OPEN, 24060, HIGH, 24040, 24060], [OPEN + FIVE, 24060, 24080, LOW, 24070], [OPEN + 2 * FIVE, 24070, 24090, 24050, 24060]];
    for (let i = 0; i < done && i < s.closes.length; i++) {
      const start = OR_END + i * FIVE; let close = s.closes[i];
      const age = now - (start + FIVE);
      if (c.provisional && age < 40000) close = Math.round((close + (dir === 'UP' ? -9 : 9)) * 100) / 100;
      if (c.settledRevision && breaks.length && start + FIVE === breaks[0] && age >= 60000 && age < 100000) close = dir === 'UP' ? HIGH - 2 : LOW + 2;
      rows.push([start, close, Math.max(close, 24000) + 3, Math.min(close, 24200) - 3, close]);
    }
    if (c.dropNewest && poll % 3 === 1 && rows.length > 3) rows.pop(); // otherwise-valid but partial response
    const raw = rows.map(r => [new Date(r[0]).toISOString(), r[1], Math.max(r[1], r[2], r[4]), Math.min(r[1], r[3], r[4]), r[4], 1000]);
    const failed = c.fetchFail && poll % 7 === 3;
    const source = failed ? buildTimingSource([], now) : buildTimingSource(raw, now);
    const forming = s.closes[Math.min(done, s.closes.length - 1)], last = done ? s.closes[done - 1] : 24060;
    const spot = Math.round((last + (forming - last) * ((now - OR_END) % FIVE) / FIVE) * 100) / 100;
    const directional = now >= alignAt && !(c.flicker && poll % 10 === 4);
    const regime = { direction:directional ? (dir === 'UP' ? 'BULLISH' : 'BEARISH') : 'NEUTRAL' };
    const strike = c.rolls ? Math.round(spot / 50) * 50 : 24100;
    const key = 'NSE_FO|' + strike, type = dir === 'UP' ? 'CE' : 'PE', strategy = dir === 'UP' ? 'LONG_CALL' : 'LONG_PUT';
    const leg = { instrumentKey:key, contractId:'NIFTY 04 NOV ' + strike + ' ' + type, strike, type, delta:0.5, bid:99.95, ask:100, premium:100 };
    const plans = { C:directional ? { available:true, strategy, legs:{ buyLeg:leg, legDelta:0.5 } } : { available:false } };
    const timing = evaluate({ enabled:true, now, source, candidates:{ plans },
      input:{ spot, support:23900, resistance:24300, marketPhase:'OPEN', dte:2, minutesRemaining:200, regime,
        features:{ trend30mPct:dir === 'UP' ? 0.3 : -0.3, sessionChangePct:dir === 'UP' ? 0.5 : -0.5, optionFlow:{ aggregate:{ label:'MIXED_FLOW' } } } } });
    if (timing.plans.C.status === 'CONFIRMED') confirmed.add(timing.plans.C.breakoutId || timing.plans.C.episodeId);
    const result = { timestamp:new Date(now).toISOString(), expiry:'2026-11-04', spot, market:{ phase:'OPEN' },
      decision:{ strategy:'WAIT', regime, researchCandidatePlans:{ plans }, shadowTiming:timing } };
    const meta = { instrumentKey:key, underlying:'NIFTY', optionType:type, strike, expiry:'2026-11-04', session:DAY, lotSize:65, tickSizeRupees:0.05 };
    const wide = c.wideQuote && breaks.length && now >= breaks[0] && now < breaks[0] + c.wideQuote;
    const outcome = E.planEntry(state, result, { instrumentKey:key, bid:wide ? 96 : 99.95, ask:100, receivedAt:now }, meta, now);
    if (outcome === 'QUEUED') {
      const level = dir === 'UP' ? HIGH : LOW;
      const ref = breaks.filter(b => b <= now).at(-1) ?? null; // the genuine breakout this entry belongs to
      const still = dir === 'UP' ? s.closes.slice(0, done).at(-1) > level : s.closes.slice(0, done).at(-1) < level;
      entries.push({ at:now, ref, inside:!(dir === 'UP' ? spot > level : spot < level) || !still,
        late:ref !== null && now - ref > WINDOW, unaligned:regime.direction === 'NEUTRAL' });
    }
  }
  // genuine = crossing whose regime aligned within the 10-minute window
  const genuine = breaks.filter(b => alignAt <= b + WINDOW);
  const taken = new Set(entries.map(e => e.ref));
  const perBreak = {}; for (const e of entries) perBreak[e.ref] = (perBreak[e.ref] || 0) + 1;
  return { genuine:genuine.length, confirmed:confirmed.size, entries:entries.length,
    missed:genuine.filter(b => !taken.has(b)).length,
    duplicate:Object.values(perBreak).reduce((a, n) => a + Math.max(0, n - 1), 0),
    unsafe:entries.filter(e => e.inside || e.ref === null || e.unaligned).length,
    late:entries.filter(e => e.late).length,
    firstEntry:entries[0] ? hhmm(entries[0].at) : '-' };
}

const rows = [];
for (const shape of Object.keys(SHAPES)) for (const cond of Object.keys(CONDITIONS)) {
  const v2 = simulate('V2', shape, cond), v3 = simulate('V3', shape, cond);
  rows.push({ shape, cond, v2, v3 });
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
const f = r => `${r.entries}e ${r.missed}m ${r.duplicate}d ${r.unsafe}u ${r.late}l @${r.firstEntry}`;
console.log('ENTRY ELIGIBILITY replay (constructed sessions; no broker fills, stops or exits).');
console.log('Per cell: entries(e) missed(m) duplicate(d) unsafe(u) late>10min(l) @first entry. genuine = real opportunities.\n');
console.log('shape'.padEnd(27) + 'condition'.padEnd(37) + 'genuine  ' + 'V2'.padEnd(26) + 'V3');
for (const r of rows) console.log(r.shape.padEnd(27) + r.cond.padEnd(37) + String(r.v2.genuine).padEnd(9) + f(r.v2).padEnd(26) + f(r.v3));
const sum = (v, k) => rows.reduce((a, r) => a + r[v][k], 0);
console.log('\nTOTAL genuine ' + sum('v2', 'genuine'));
for (const v of ['v2', 'v3']) console.log(v.toUpperCase() + ': entries ' + sum(v, 'entries') + ', missed ' + sum(v, 'missed') + ', duplicate ' + sum(v, 'duplicate') + ', unsafe ' + sum(v, 'unsafe') + ', late>10min ' + sum(v, 'late'));
