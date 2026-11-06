'use strict';
// One formula for the planned loss of a single long option, shared by the signal engine's position check and the
// sandbox executor, so a signal can never be sized differently from the order the executor would place.
//
// Entry is the ask rounded UP to the tick (the limit price the executor sends). The protective stop is a stop-limit
// order whose limit sits below the stop by max(one tick, 0.5% of the stop), rounded DOWN to the tick; the planned
// loss assumes a fill at that limit. The cost reserve covers charges and slippage.
const NIFTY_OPTION_TICK = 0.05;
const money = n => Math.round(n * 100) / 100;
const up = (x, tick) => money(Math.ceil((x - 1e-8) / tick) * tick);
const down = (x, tick) => money(Math.floor((x + 1e-8) / tick) * tick);
const entryPrice = (ask, tick = NIFTY_OPTION_TICK) => up(ask, tick);
// The stop is first normalized DOWN to the tick, exactly as the executor's exit plan does, so a raw stop such as
// 92.04 and its executable 92.00 give the same stop-limit. Idempotent for stops already on the tick.
const normalizeStop = (stop, tick = NIFTY_OPTION_TICK) => down(stop, tick);
const stopLimitPrice = (stop, tick = NIFTY_OPTION_TICK) => { const s = normalizeStop(stop, tick); return down(s - Math.max(tick, s * 0.005), tick); };
function orderRisk({ price, stopLimit, lotSize, costReserve }) {
  return { risk: money((price - stopLimit) * lotSize + costReserve), capital: money(price * lotSize + costReserve) };
}
// Convenience for a quoted long option and a premium stop.
function plannedLongRisk({ ask, stop, lotSize, costReserve = 100, tick = NIFTY_OPTION_TICK }) {
  const price = entryPrice(ask, tick), stopLimit = stopLimitPrice(stop, tick);
  return { price, stopLimit, ...orderRisk({ price, stopLimit, lotSize, costReserve }) };
}
module.exports = { NIFTY_OPTION_TICK, up, down, entryPrice, normalizeStop, stopLimitPrice, orderRisk, plannedLongRisk };
