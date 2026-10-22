# Entry-trigger audit — 21 October 2026

Baseline: e2345135dcfe1ef0c71921ab9944016fcdcfe4be.

## Confirmed defect

`src/server.js` selects support/resistance at ATM minus/plus three chain indices on every analysis. `src/engine/entryEngine.js` requires spot to cross those levels for LONG_CALL, LONG_PUT, BULL_CALL_SPREAD and BEAR_PUT_SPREAD. On a regular, interior chain the threshold moves with spot and remains out of reach. This conclusion does not cover truncated-chain endpoints or credit strategies, which use other conditions.

Run `node scripts/audit-entry-triggers.js`. Across 801 spot observations per strategy, with acceptable quotes, liquidity and aligned momentum, all 3,204 evaluations wait for the trigger. Fixed-anchor controls cross successfully; without momentum they remain blocked. These are synthetic diagnostic observations, not backtest trades or profitability evidence. The script intentionally characterizes the current defect and must be revised when production behavior is corrected.

## Observed production evidence

Snapshot: 2026-10-21 06:41:27 UTC / 12:11:27 IST. Not a current quote.

- Spot: 22,776.45; regime STRONG_BEARISH.
- Authoritative structure: BEAR_PUT_SPREAD, buy 22,800 PE / sell 22,600 PE, 27 October expiry.
- Entry: price and liquidity passed, momentum passed, breakdown failed.
- Dynamic support: 22,650; resistance: 22,950.
- Position gate independently blocked because the day's manual log was not reconciled with the broker.
- Research state: C; chart AGREES; failed gates TRIGGER and POSITION.

The debit quote of 78.60 points at 65 units represents ₹5,109 premium at risk before costs (₹5,209 including the configured ₹100 reserve). Fixing the trigger must not automatically waive the separate ₹1,000 daily risk budget or account reconciliation.

## Related findings

- Tier B currently includes position readiness, so an account restriction can keep a chart-aligned candidate in C. Market readiness and account eligibility should be explained separately without changing execution authorization.
- The read-only planner also uses the ATM-offset levels as structural anchors. Its targets/stops therefore need review before they can serve as validated trade guidance.
- Premium limits are recalculated around the current quote; this audit does not validate a persistent do-not-chase limit.

## Correction requirements

Use an explicitly defined, completed-candle or session structure as the trigger source. Freeze the anchor for the candidate episode; record its source, timestamp, expiry and invalidation. Reject missing, stale, future, cross-session and incomplete-candle anchors. Test equality, crossings, candidate changes, restarts, and both directions. Evaluate first in shadow mode with timestamped live evidence and historical replay without lookahead. Compare candidate identity and every existing execution gate to the baseline. Do not substitute an arbitrary fixed level merely because the control experiment can cross it.

This audit changes no production strategy, contract selection, tier authorization, risk settings or order routing. No production trigger fix has been deployed.
