'use strict';
const assert = require('node:assert/strict');
const { buildTimingSource } = require('./shadowTiming');
const { createShadowTimingV3, SETTLE_MS } = require('./shadowTimingV3');
const DAY = '2026-11-02';
const t = s => Date.parse(DAY + 'T' + s + '+05:30');
const FIVE = 300000;
// Opening range 09:15-09:25 bars: high 110, low 90. Later bars carry only the close that matters.
const row = (time, close = 100, high = Math.max(close, 100) + 1, low = Math.min(close, 100) - 1) =>
  [DAY + 'T' + time + '+05:30', 100, high, low, close, 1000];
const opening = [row('09:15:00', 100, 110, 95), row('09:20:00', 100, 105, 90), row('09:25:00', 100, 104, 96)];
const bars = (...closes) => closes.map((c, i) => row(new Date(t('09:30:00') + i * FIVE + 19800000).toISOString().slice(11, 19), c));
const card = (strategy, key = 'K1') => ({ available:true, strategy, legs:{ buyLeg:{ instrumentKey:key, bid:100, ask:101, premium:100.5 } } });
const input = (direction = 'BULLISH', spot = 112) => ({ spot, support:50, resistance:150, marketPhase:'OPEN', dte:5,
  features:{ trend30mPct:direction === 'BEARISH' ? -1 : 1, sessionChangePct:direction === 'BEARISH' ? -1 : 1 }, regime:{ direction } });
function run(ev, rows, at, { strategy = 'LONG_CALL', direction, spot, key, phase = 'OPEN', source } = {}) {
  const now = t(at);
  return ev({ enabled:true, now, source:source === undefined ? buildTimingSource(rows, now) : source,
    candidates:{ plans:{ C:card(strategy, key) } },
    input:{ ...input(direction ?? (strategy === 'LONG_CALL' ? 'BULLISH' : 'BEARISH'), spot ?? (strategy === 'LONG_CALL' ? 112 : 88)), marketPhase:phase } });
}

// --- disabled returns null; V2 output is untouched by this module ---
assert.equal(createShadowTimingV3()({ enabled:false }), null);

// --- clean breakout, both directions: judged only after settlement, ready inside the window ---
for (const [strategy, close] of [['LONG_CALL', 112], ['LONG_PUT', 88]]) {
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05', { strategy });
  const rows = [...opening, ...bars(close)];
  let x = run(ev, rows, '09:35:30', { strategy });
  assert.equal(x.plans.C.status, 'WAITING', 'the crossing candle is not judged before it settles');
  x = run(ev, rows, '09:36:01', { strategy });
  assert.equal(x.plans.C.status, 'CONFIRMED');
  assert.equal(x.plans.C.shadowEntryReady, true, strategy + ' confirmed and entry-ready');
  assert.equal(x.plans.C.crossedAt, new Date(t('09:35:00')).toISOString(), 'crossing time = crossing candle close');
  assert.equal(x.plans.C.executionAllowed, false);
  assert.equal(x.market.breakouts.length, 1);
}

// --- confirmation outlives the 30-minute V2 timer; entry eligibility closes after 10 minutes ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  const closes = [112, 113, 114, 115, 116, 117, 118, 118, 119];
  let x = run(ev, [...opening, ...bars(...closes)], '10:16:05');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'still confirmed 40 minutes after the crossing');
  assert.equal(x.plans.C.shadowEntryReady, false);
  assert.equal(x.plans.C.entryBlocker, 'ENTRY_WINDOW_ELAPSED');
  x = run(ev, [...opening, ...bars(...closes, 108)], '10:21:05');
  assert.equal(x.plans.C.status, 'INVALIDATED');
  assert.equal(x.plans.C.reason, 'CLOSE_BACK_THROUGH_ANCHOR');
  x = run(ev, [...opening, ...bars(...closes, 108, 111)], '10:26:05');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'a fresh re-break after a failed one confirms again');
  assert.equal(x.plans.C.shadowEntryReady, true);
  assert.equal(x.market.breakouts.length, 2);
  assert.notEqual(x.plans.C.breakoutId, x.market.breakouts[0].id, 'as a new breakout id');
}

// --- delayed regime alignment: neutral at the break, aligned 6 minutes later -> allowed; 12 minutes -> not ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112, 112.5, 113)];
  run(ev, opening, '09:31:05', { direction:'NEUTRAL' });
  let x = run(ev, rows.slice(0, 4), '09:36:05', { direction:'NEUTRAL' });
  assert.equal(x.market.breakouts.length, 1, 'market-level breakout recorded while the regime is neutral');
  assert.equal(x.plans.C.entryBlocker, 'REGIME_NOT_ALIGNED');
  x = run(ev, rows.slice(0, 5), '09:41:05');
  assert.equal(x.plans.C.shadowEntryReady, true, 'aligned within 10 minutes: eligible');
  x = run(ev, rows, '09:46:05');
  assert.equal(x.plans.C.entryBlocker, 'ENTRY_WINDOW_ELAPSED', 'aligned after 10 minutes: not eligible');
}

// --- not chasing: price must be beyond the level by no more than half the range width (20 * 0.5 = 10) ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  const x = run(ev, [...opening, ...bars(112)], '09:36:05', { spot:121 });
  assert.equal(x.plans.C.entryBlocker, 'CHASE_LIMIT');
  assert.equal(run(createShadowTimingV3(), [...opening, ...bars(112)], '09:36:05', { spot:109 }).plans.C.entryBlocker, 'PRICE_BACK_INSIDE_RANGE');
}

// --- revised candles: a revision inside the settle window is harmless ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  run(ev, [...opening, ...bars(109)], '09:35:20'); // provisional value, not yet settled
  const x = run(ev, [...opening, ...bars(112)], '09:36:05');
  assert.equal(x.plans.C.shadowEntryReady, true);
  assert.equal(x.market.conflicts, 0);
}
// --- a settled candle that changes is a recorded conflict: the breakout it created is never tradable,
//     and new entries stay blocked until a later candle has settled and been read twice unchanged ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  let x = run(ev, [...opening, ...bars(112)], '09:36:05');
  const id = x.plans.C.breakoutId;
  x = run(ev, [...opening, ...bars(109)], '09:37:05');
  assert.equal(x.market.conflicts, 1);
  assert.equal(x.market.breakouts[0].id, id, 'history kept');
  assert.equal(x.market.breakouts[0].reason, 'CROSSING_CANDLE_REVISED');
  x = run(ev, [...opening, ...bars(112)], '09:37:40');
  assert.equal(x.plans.C.status, 'INVALIDATED', 'flip-flopping data never restores the breakout');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, [...opening, ...bars(112, 108, 112)], '09:46:05');
  assert.equal(x.plans.C.dataStatus, 'DATA_CONFLICT_UNRESOLVED', 'one clean read is not enough');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, [...opening, ...bars(112, 108, 112)], '09:46:45');
  assert.equal(x.plans.C.dataStatus, 'OK', 'trust restored after a post-conflict candle is read twice unchanged');
  assert.equal(x.plans.C.shadowEntryReady, true, 'a genuine later re-break is tradable');
  assert.notEqual(x.plans.C.breakoutId, id);
}
// --- an opening-range revision fails the session closed ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  const revised = [row('09:15:00', 100, 111, 95), ...opening.slice(1)];
  const x = run(ev, [...revised, ...bars(112)], '09:36:05');
  assert.equal(x.plans.C.dataStatus, 'ANCHOR_REVISED');
  assert.equal(x.plans.C.shadowEntryReady, false);
  assert.equal(x.market.anchor.high, 110, 'the frozen range is never replaced');
}

// --- fetch failures keep history but fail closed; fresh data restores eligibility within the window ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112, 113)];
  run(ev, opening, '09:31:05');
  run(ev, rows.slice(0, 4), '09:36:05');
  let x = run(ev, [], '09:37:05', { source:null });
  assert.equal(x.plans.C.dataStatus, 'DATA_UNAVAILABLE');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'breakout history survives the failed fetch');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, [], '09:38:05', { source:{ available:false, reason:'COMPLETE_OPENING_RANGE_REQUIRED' } });
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, rows, '09:41:05');
  assert.equal(x.plans.C.shadowEntryReady, true);
  x = run(ev, rows, '09:53:00');
  assert.equal(x.plans.C.dataStatus, 'STALE_CANDLES', 'no new candle for too long');
}

// --- a gap at the crossing: the crossing is not assumed ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  const gap = [...opening, row('09:35:00', 112)]; // 09:30 bar missing
  const x = run(ev, gap, '09:41:05');
  assert.equal(x.market.breakouts.length, 0);
  assert.equal(x.plans.C.status, 'WAITING');
}

// --- strike roll and tier changes do not change the breakout identity ---
{
  const ev = createShadowTimingV3();
  run(ev, opening, '09:31:05');
  const a = run(ev, [...opening, ...bars(112)], '09:36:05', { key:'K1' }).plans.C;
  const b = run(ev, [...opening, ...bars(112, 125)], '09:41:05', { key:'K2', spot:118 }).plans.C;
  assert.equal(a.breakoutId, b.breakoutId);
  assert.deepEqual(b.contracts, ['K2']);
}

// --- closed market and unavailable cards ---
{
  const ev = createShadowTimingV3();
  assert.equal(run(ev, opening, '09:31:05', { phase:'CLOSED' }).plans.C.dataStatus, 'MARKET_CLOSED');
  const x = ev({ enabled:true, now:t('09:36:05'), source:buildTimingSource([...opening, ...bars(112)], t('09:36:05')),
    candidates:{ plans:{ C:{ available:false } } }, input:input() });
  assert.equal(x.plans.C.reason, 'UNSUPPORTED_OR_UNAVAILABLE_STRUCTURE');
  assert.equal(x.market.breakouts.length, 1, 'market tracking does not need a card');
}
assert.equal(SETTLE_MS, 60000);
console.log('shadowTimingV3: settlement, revalidation, fail-closed data, persistent confirmation, 10-min entry window, late alignment, chase limit, gaps, re-breaks, identity PASS');
