# Timing Lab V1 — 1m / 3m opening-range and futures-VWAP research

**Status: OFF by default, research only.** Stacked on the separate Entry & Exit Research V2 draft PR #89. No new order route, paper mode, entry approval, position sizing or strike-selection changes.

## Opt-in and isolation

The existing `EDGE_OPPORTUNITY_REPORTS_ENABLED=true` is required to provide a durable PostgreSQL evidence archive. Set `EDGE_TIMING_LAB_ENABLED=true` separately **only after review** to enable one extra read-only Upstox NIFTY-index one-minute candle request, cached for 45 seconds. The service catches all observer/data failures independently of the main poll. It runs only *after* the current trading decision is calculated and persisted.

To disable this lab without disrupting existing quick-exit or V3 research, set `EDGE_TIMING_LAB_ENABLED=false` and restart. Restart disarms any running paper trader; re-arm only after checking state. V2's separate `EDGE_TRIGGERED_EXIT_V2_ENABLED` flag is unchanged. If #89 is not merged, this stacked PR must not merge directly into main.

## Preregistered hypotheses (no tuned thresholds)

All raw candle timestamps are bar **starts**, with a source settlement delay of at least 30 seconds. In memory, a signal needs two matching source reads at least 60 seconds apart with different fetch timestamps. A replay based on historical candles does not prove the source would have supplied the second matching read in time. The observer does not issue broker orders.

1. **ORB_1M:** use the confirmed 09:15–09:30 NIFTY spot-index opening-range high/low from exactly the first three **completed** five-minute index candles. The first completed one-minute index candle close crossing the boundary relative to the previous completed close generates a candidate. Complete, contiguous one-minute index bars are required.
2. **ORB_3M:** assemble three adjacent, completed one-minute index bars aligned from 09:15. A three-minute close crossing the same range is a separate candidate. It is NOT a synthetic provider 3m candle or a V3 replacement.
3. **FUTURES_VWAP_PULLBACK:** use completed five-minute candles of the nearest NIFTY futures contract and **traded futures volume**, not NIFTY spot's nonexistent volume. A preceding five-minute bar must have touched within 0.07% of the calculated session VWAP and closed on the trend side, followed by a bar closing above the previous high/below the previous low, with VWAP sloping in the same direction and price confirmation against five bars earlier. Parameters are hypotheses, not optimized market truths.

Untrustworthy or incomplete candles, duplicate timestamps, an opening-range revision, absent quotes, or stale polling yield UNKNOWN/UNMEASURED. The baseline V3 timing state and its two-read 5-minute candle logic remain completely untouched.

## What gets measured

- Each confirmed **underlying-level hypothesis** receives a stable unique event ID, source and confirmation time, and a contemporaneous read-only snapshot of up to three existing EDGE A/B/C long-option candidates pointing in that direction. No new strike is manufactured. Each candidate must have a positive bid and ask and quote analysis age under 15 seconds.
- One per-hypothesis/contract/tier/episode option-outcome record measures +8/-8/30-minute exits using existing V2's 0/1/2-point assumed exit haircut plus brokerage and statutory fees. Minute OHLC is not a real executable bid. A missing minute in the walked exit path leaves the outcome UNKNOWN. Historical event data with no contemporaneous option quote cannot be backfilled.
- The owner-only `/api/v1/opportunities` JSON includes `timingLab` with family counts, all-episode denominators, distinct measured days, and results by family and tier. The existing Quick Exit section shows a compact summary.
- ORB variants can be **contextually paired** against V3 only when the recorded candidate tier, contract, directional side, implementation fingerprint, session and crossing within ten minutes match. Positive entry-lead minutes mean the variant's recorded confirmation was earlier. Identical-model net difference is reported **only if both sides have measured exits**. These are descriptive pairings, not interchangeable randomized trades.
- Options candidates from the same underlying breakout are correlated; raw means and win rates are not evidence of statistically repeatable edge. Future holdouts, cost stress tests, and independent session counts must precede any promotion.

## Resource limits and rollback

- Additional NIFTY-index 1m reads are shared/cached for 45 seconds; no request to the trading broker order endpoint.
- Outcome harvesting uses at most 10 unique option contract/day downloads and 60 append-only records per pass, with retries and terminal reasons. Its new source records count toward the existing bounded reporting archive (50k records / 32 MiB); observe retention and transfer.
- To roll back before merge: close the stacked draft PR. After a merge/deploy, unset `EDGE_TIMING_LAB_ENABLED` and restart, or revert this PR. Prior lab records remain for audit.
- Run `npm run test:timing-lab`, `npm run test:opportunities`, `npm run test:syntax`, and `npm run test:all`. Check unchanged strike-engine, candidate selection, sandbox, V3 and ledger paths.

**Operational requirement:** Do not enable automatic trading based on lab evidence. Evaluate later market sessions with exact execution quotes, distinct day counts, friction sensitivity and a frozen rule version before changing any entry gate.
