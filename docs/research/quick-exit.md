# Quick-exit measurement (`QUICK_EXIT_V1`)

Research only. It answers one question: if every flagged single-leg card (long call or long put, any card tier) had been bought and managed with a quick target, a hard stop and a time limit, what would the results have been?

It exists because the fixed 60-minute mark in the opportunity report does not match how the owner trades. The owner exits in minutes at a few premium points, and the 60-minute mark can turn a quick winner into a loss.

## Rule

- **Primary, fixed in advance:** buy at the ask quoted on the card when it was first flagged, exit at **+8 premium points**, **−8 premium points**, or at market after **30 minutes**, whichever comes first.
- **Sensitivity only:** +6/−6, +10/−10, +10/−6 and +15/−8, all with 30 minutes. These are shown so the primary result can be judged in context. Picking the best of them after seeing the results overstates it.

## Fill assumptions

- The walk uses that contract's own 1-minute candles, starting with the first candle that opens at or after the flag.
- The stop fills at entry − stop, or at the candle's open if the candle gapped below it.
- The target fills at entry + target, never better.
- A minute that touches both the target and the stop counts as the stop.
- With no hit, the exit is the close of the last candle inside the window. The window never runs past the 15:29 candle.
- Missing candle data leaves the card unmeasured. It never becomes a time exit.
- Costs: ₹100 per leg, one lot, the same reserve the 60-minute report uses. These are not measured broker charges.

## Collection

The opportunity service measures cards once their window has passed, reusing the outcome harvester's candle download. That covers active contracts from Upstox historical candles and expired ones from the expired-instruments API. One download serves every card on the same contract and day. Each pass makes at most 10 downloads and writes at most 60 records, so the back history fills in over the first hour or so. Records are stored as `OPPORTUNITY_QUICK_EXIT`. Failed downloads retry with backoff, up to three attempts.

## Reading it

The report page has a "Quick exit" section. It shows the primary rule by card tier, by direction, by expiry day versus other days, and by time of day, plus the sensitivity table. Overlapping cards on the same move are correlated, so their totals are not independent trades. None of this changes any trading rule.
