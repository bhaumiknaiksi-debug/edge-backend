'use strict';
const assert = require('node:assert/strict');
const { buildTimingSource } = require('./shadowTiming');
const { createShadowTimingV3, SETTLE_MS, CONFIRM_MS } = require('./shadowTimingV3');
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
function runAt(ev, rows, now, { strategy = 'LONG_CALL', direction, spot, key, phase = 'OPEN', source, candidates } = {}) {
  return ev({ enabled:true, now, source:source === undefined ? buildTimingSource(rows, now) : source,
    candidates:candidates || { plans:{ C:card(strategy, key) } },
    input:{ ...input(direction ?? (strategy === 'LONG_CALL' ? 'BULLISH' : 'BEARISH'), spot ?? (strategy === 'LONG_CALL' ? 112 : 88)), marketPhase:phase } });
}
const run = (ev, rows, at, opts) => runAt(ev, rows, t(at), opts);
// Production polls every 30 s. buildTimingSource drops bars that have not closed yet, so a full-day row list
// replayed through poll() reveals bars as time passes. Returns the output of the last poll.
function poll(ev, rows, from, to, opts) {
  let x;
  for (let now = t(from); now <= t(to); now += 30000) x = runAt(ev, rows, now, opts);
  return x;
}

// --- disabled returns null; V2 output is untouched by this module ---
assert.equal(createShadowTimingV3()({ enabled:false }), null);

// --- the opening range is frozen only after two matching reads a minute apart ---
{
  const ev = createShadowTimingV3();
  let x = run(ev, opening, '09:30:40');
  assert.equal(x.market.anchor, null, 'too fresh to read');
  x = run(ev, opening, '09:31:05');
  assert.equal(x.market.anchor, null, 'one read is not a confirmation');
  x = run(ev, opening, '09:32:05');
  assert.equal(x.market.anchor.high, 110);
  assert.equal(x.market.anchor.confirmedAt, new Date(t('09:32:05')).toISOString());
}

// --- clean breakout, both directions: judged only after confirmation, ready inside the window ---
for (const [strategy, close] of [['LONG_CALL', 112], ['LONG_PUT', 88]]) {
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(close)];
  let x = poll(ev, rows, '09:30:05', '09:36:35', { strategy });
  assert.equal(x.plans.C.status, 'WAITING', 'one read of the crossing candle is not enough');
  x = run(ev, rows, '09:37:05', { strategy });
  assert.equal(x.plans.C.status, 'CONFIRMED');
  assert.equal(x.plans.C.shadowEntryReady, true, strategy + ' confirmed and entry-ready');
  assert.equal(x.plans.C.crossedAt, new Date(t('09:35:00')).toISOString(), 'crossing time = crossing candle close');
  assert.equal(x.plans.C.executionAllowed, false);
  assert.equal(x.market.breakouts.length, 1);
  assert.deepEqual(x.market.candleLog, [], 'clean data leaves no log entries');
}

// --- confirmation outlives the 30-minute V2 timer; entry eligibility closes after 10 minutes ---
{
  const ev = createShadowTimingV3();
  const rows = [...opening, ...bars(112, 113, 114, 115, 116, 117, 118, 118, 119, 108, 111)];
  let x = poll(ev, rows, '09:30:05', '10:16:05');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'still confirmed 40 minutes after the crossing');
  assert.equal(x.plans.C.shadowEntryReady, false);
  assert.equal(x.plans.C.entryBlocker, 'ENTRY_WINDOW_ELAPSED');
  x = poll(ev, rows, '10:16:35', '10:22:05');
  assert.equal(x.plans.C.status, 'INVALIDATED');
  assert.equal(x.plans.C.reason, 'CLOSE_BACK_THROUGH_ANCHOR');
  x = poll(ev, rows, '10:22:35', '10:27:05');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'a fresh re-break after a failed one confirms again');
  assert.equal(x.plans.C.shadowEntryReady, true);
  assert.equal(x.market.breakouts.length, 2);
  assert.notEqual(x.plans.C.breakoutId, x.market.breakouts[0].id, 'as a new breakout id');
}

// --- delayed regime alignment: neutral at the break, aligned 6 minutes later -> allowed; 11 minutes -> not ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112, 112.5, 113)];
  let x = poll(ev, rows, '09:30:05', '09:37:05', { direction:'NEUTRAL' });
  assert.equal(x.market.breakouts.length, 1, 'market-level breakout recorded while the regime is neutral');
  assert.equal(x.plans.C.entryBlocker, 'REGIME_NOT_ALIGNED');
  x = poll(ev, rows, '09:37:35', '09:41:05');
  assert.equal(x.plans.C.shadowEntryReady, true, 'aligned within 10 minutes: eligible');
  x = poll(ev, rows, '09:41:35', '09:46:05');
  assert.equal(x.plans.C.entryBlocker, 'ENTRY_WINDOW_ELAPSED', 'aligned after 10 minutes: not eligible');
}

// --- not chasing: price must be beyond the level by no more than half the range width (20 * 0.5 = 10) ---
{
  const rows = [...opening, ...bars(112)];
  assert.equal(poll(createShadowTimingV3(), rows, '09:30:05', '09:37:05', { spot:121 }).plans.C.entryBlocker, 'CHASE_LIMIT');
  assert.equal(poll(createShadowTimingV3(), rows, '09:30:05', '09:37:05', { spot:109 }).plans.C.entryBlocker, 'PRICE_BACK_INSIDE_RANGE');
}

// --- a correction before confirmation (stale cached candle) is logged, restarts the wait, and is not a conflict ---
{
  const ev = createShadowTimingV3();
  poll(ev, opening, '09:30:05', '09:35:35');
  run(ev, [...opening, ...bars(109)], '09:36:05');            // stale first read
  let x = run(ev, [...opening, ...bars(112)], '09:36:35');    // corrected
  x = run(ev, [...opening, ...bars(112)], '09:37:05');
  assert.equal(x.plans.C.dataStatus, 'CANDLE_UNCONFIRMED', 'the corrected value needs its own minute');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, [...opening, ...bars(112)], '09:37:35');
  assert.equal(x.plans.C.shadowEntryReady, true, 'the breakout survives the correction');
  assert.equal(x.market.conflicts, 0);
  assert.equal(x.market.candleLog.length, 1);
  assert.deepEqual(x.market.candleLog[0], { kind:'PRE_CONFIRM_CORRECTION', candle:new Date(t('09:30:00')).toISOString(),
    firstRead:109, observed:112, firstReadAt:new Date(t('09:36:05')).toISOString(),
    detectedAt:new Date(t('09:36:35')).toISOString(), lagSeconds:95 });
}

// --- a confirmed candle that changes is a recorded conflict: the breakout it created is never tradable,
//     and new entries stay blocked until a candle that started after the conflict has been confirmed ---
{
  const ev = createShadowTimingV3();
  let x = poll(ev, [...opening, ...bars(112)], '09:30:05', '09:37:05');
  const id = x.plans.C.breakoutId;
  assert.equal(x.plans.C.shadowEntryReady, true);
  x = run(ev, [...opening, ...bars(109)], '09:37:35');
  assert.equal(x.market.conflicts, 1);
  assert.equal(x.market.breakouts[0].id, id, 'history kept');
  assert.equal(x.market.breakouts[0].reason, 'CROSSING_CANDLE_REVISED');
  const revised = x.market.candleLog.at(-1);
  assert.equal(revised.kind, 'CANDLE_REVISED');
  assert.equal(revised.recorded, 112); assert.equal(revised.observed, 109);
  assert.equal(revised.confirmedAt, new Date(t('09:37:05')).toISOString());
  assert.equal(revised.lagSeconds, 155, 'seconds after the candle closed');
  x = run(ev, [...opening, ...bars(112)], '09:38:05');
  assert.equal(x.plans.C.status, 'INVALIDATED', 'flip-flopping data never restores the breakout');
  assert.equal(x.plans.C.shadowEntryReady, false);
  const rows = [...opening, ...bars(112, 108, 112)];
  x = poll(ev, rows, '09:38:35', '09:46:35');
  assert.equal(x.plans.C.dataStatus, 'DATA_CONFLICT_UNRESOLVED', 'one read of the post-conflict candle is not enough');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, rows, '09:47:05');
  assert.equal(x.plans.C.dataStatus, 'OK', 'trust restored once a post-conflict candle is confirmed');
  assert.equal(x.plans.C.shadowEntryReady, true, 'a genuine later re-break is tradable');
  assert.notEqual(x.plans.C.breakoutId, id);
}

// --- opening range: a correction before it is frozen is harmless; a revision after fails the session closed ---
{
  const ev = createShadowTimingV3();
  const stale = [row('09:15:00', 100, 111, 95), ...opening.slice(1)];
  run(ev, stale, '09:31:05');
  let x = poll(ev, opening, '09:31:35', '09:32:35');
  assert.equal(x.market.anchor.high, 110, 'the corrected range is the one frozen');
  assert.equal(x.market.candleLog[0].kind, 'ANCHOR_PRE_CONFIRM_CORRECTION');
  x = poll(ev, [...opening, ...bars(112)], '09:33:05', '09:37:05');
  assert.equal(x.plans.C.shadowEntryReady, true);
}
{
  const ev = createShadowTimingV3();
  poll(ev, opening, '09:30:05', '09:32:05');
  const revised = [row('09:15:00', 100, 111, 95), ...opening.slice(1)];
  const x = poll(ev, [...revised, ...bars(112)], '09:32:35', '09:37:05');
  assert.equal(x.plans.C.dataStatus, 'ANCHOR_REVISED');
  assert.equal(x.plans.C.shadowEntryReady, false);
  assert.equal(x.market.anchor.high, 110, 'the frozen range is never replaced');
  assert.equal(x.market.candleLog.filter(e => e.kind === 'ANCHOR_REVISED').length, 1, 'logged once');
}

// --- fetch failures keep history but fail closed; fresh data restores eligibility within the window ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112, 113)];
  poll(ev, rows, '09:30:05', '09:37:05');
  let x = run(ev, [], '09:37:35', { source:null });
  assert.equal(x.plans.C.dataStatus, 'DATA_UNAVAILABLE');
  assert.equal(x.plans.C.status, 'CONFIRMED', 'breakout history survives the failed fetch');
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, [], '09:38:05', { source:{ available:false, reason:'COMPLETE_OPENING_RANGE_REQUIRED' } });
  assert.equal(x.plans.C.shadowEntryReady, false);
  x = run(ev, rows, '09:41:05');
  assert.equal(x.plans.C.shadowEntryReady, true);
  x = run(ev, rows, '09:53:00');
  assert.equal(x.plans.C.dataStatus, 'INCOMPLETE_CANDLES', 'expected candles missing from the response');
}

// --- a missed poll leaves the expected candle unconfirmed: fail closed, never judge on an older close ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112, 113)];
  poll(ev, rows, '09:30:05', '09:37:05');
  const x = run(ev, rows, '09:42:05'); // the 09:35 bar was first read just now
  assert.equal(x.plans.C.dataStatus, 'CANDLE_UNCONFIRMED');
  assert.equal(x.plans.C.shadowEntryReady, false);
}

// --- a gap at the crossing: the crossing is not assumed ---
{
  const ev = createShadowTimingV3();
  const gap = [...opening, row('09:35:00', 112)]; // 09:30 bar missing
  const x = poll(ev, gap, '09:30:05', '09:42:05');
  assert.equal(x.market.breakouts.length, 0);
  assert.equal(x.plans.C.status, 'WAITING');
}

// --- strike roll and tier changes do not change the breakout identity ---
{
  const ev = createShadowTimingV3();
  const a = poll(ev, [...opening, ...bars(112)], '09:30:05', '09:37:05', { key:'K1' }).plans.C;
  const b = poll(ev, [...opening, ...bars(112, 115)], '09:37:35', '09:42:05', { key:'K2', spot:116 }).plans.C;
  assert.equal(a.breakoutId, b.breakoutId);
  assert.deepEqual(b.contracts, ['K2']);
}

// --- quiet polls do not change the output, so evidence transitions are not written every poll ---
{
  const ev = createShadowTimingV3(), rows = [...opening, ...bars(112)];
  const a = poll(ev, rows, '09:30:05', '09:38:05'), b = run(ev, rows, '09:38:35');
  assert.equal(JSON.stringify(a.market), JSON.stringify(b.market));
}

// --- closed market and unavailable cards ---
{
  const ev = createShadowTimingV3();
  assert.equal(run(ev, opening, '09:31:05', { phase:'CLOSED' }).plans.C.dataStatus, 'MARKET_CLOSED');
  const x = poll(createShadowTimingV3(), [...opening, ...bars(112)], '09:30:05', '09:37:05', { candidates:{ plans:{ C:{ available:false } } } });
  assert.equal(x.plans.C.reason, 'UNSUPPORTED_OR_UNAVAILABLE_STRUCTURE');
  assert.equal(x.market.breakouts.length, 1, 'market tracking does not need a card');
}
assert.equal(SETTLE_MS, 60000);
assert.equal(CONFIRM_MS, 60000);
console.log('shadowTimingV3: two-read confirmation, correction log, revalidation, fail-closed data, persistent confirmation, 10-min entry window, late alignment, chase limit, gaps, re-breaks, identity PASS');
