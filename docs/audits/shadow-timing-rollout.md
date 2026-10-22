# Opening-range timing experiment

Baseline: e2345135dcfe1ef0c71921ab9944016fcdcfe4be. Existing selector, entry engine, tiers, orchestration and notification permissions remain authoritative.

## Hypothesis and boundaries

OPENING_RANGE_SHADOW_V1 tests a close beyond the completed NIFTY spot 09:15–09:30 IST opening range, observed after a candidate episode begins. Only complete, consecutive five-minute candles qualify. Equality is not a crossing. This is a specific hypothesis, not a validated universal entry rule. It will intentionally miss breakouts that occurred before observation began; it does not catch up by treating an already-broken level as a new signal. Credit and neutral structures are unsupported.

The anchor is frozen per episode, identified by displayed tier, strategy, contract instruments and session. Each episode expires after 30 minutes or market close; it stays expired until contract/session changes or continuity resets. A close back through the breakout level invalidates a confirmed episode. Thirty minutes is an experimental lifetime, not a recommended holding period. Revisions to opening-range data invalidate the episode. Missing bars, out-of-order bars and stale sources cannot confirm a crossing. Restarts and stale-source resets begin a new episode with UNKNOWN continuity; no prior confirmation is reconstructed. The in-memory map is bounded to three entries. The existing durable evidence store records episode IDs and outcomes, including in lightweight mode.

## API

`decision.shadowTiming` is null by default. With `EDGE_SHADOW_TIMING_ENABLED=true`, it contains A/B/C observations: episode ID, anchor source and timestamp, candle timestamp, expiry, confirmation state, baseline trigger result, shadow trigger result, quote checks and differences. It always has `executionAllowed=false` and never feeds the live orchestrator or notifications. Baseline B/C comparisons evaluate the current entry engine on their own unchanged contracts rather than borrowing A's entry status.

`decision.readinessView` separately exposes technical market gates and account/position eligibility. It reports the CURRENT authoritative entry's market readiness, not the experimental trigger's readiness. Structural risk and position eligibility remain visible separately; this view never grants trading permission. Existing tier labels are unchanged. Frontend presentation is a subsequent change, not included here.

## Validation and rollout

1. Baseline full suite passed; synthetic trigger audit reproduced starvation in 3,204 interior-chain evaluations. These are not trades or profit evidence.
2. Run `npm run test:shadow-timing` for complete-range, crossing/equality, four strategies, liquidity/momentum, frozen-anchor, invalidation, expiry, gap, stale-data, restart, contract-change and account-separation checks. Run `npm run test:all` for regression coverage.
3. Merge/release with the flag unset first. Enable the flag only for observational collection. No paid infrastructure change is included.
4. Compare episodes across market sessions. Record data coverage and gaps explicitly. Inspect disagreements and quote availability. A synthetic test does not establish predictive quality or profitable expectancy.
5. Do not promote the experiment to live entry logic until historical/live comparisons support a specified acceptance criterion. Exit simulation and cost-adjusted results remain separate pending work.

Rollback: unset `EDGE_SHADOW_TIMING_ENABLED` and restart; the shadow response becomes null and no experimental trigger can affect authorization. No database migration or evidence deletion is required.

## Known limitations

Completed-candle confirmation can lag intrabar opportunities. Opening-range breakouts alone may be unsuitable later in the session. Candle recency establishes candle coverage, not proof that every option quote was fresh or executable. Current quote checks inherit the existing engine's pricing rules. This PR does not repair hosting continuity, validate stops/targets, or make claims about performance.
