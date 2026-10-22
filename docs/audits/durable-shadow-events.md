# Durable shadow market events and contract observations

Baseline: dc255bca01dd1f29577d7ed51c6c96e8874e66c3. Version SHADOW_EVENTS_V1.

## Identity and scope

A market event is a completed five-minute opening-range crossing, identified by session, frozen opening-range source/values, direction and crossing candle timestamp. It is independent of candidate tier and instrument. The existing PR59 shadowTiming response remains unchanged for baseline comparison. This separate tracker does not feed selector, tiers, orchestration, journal, sizing or notifications.

At the first observed crossing it freezes all currently selected, direction-compatible A/B/C long/debit contract expressions. Multiple tiers on the same crossing are one market event. No compatible candidate means an event with no contract observations, not an invented trade. Each observation retains exact instrument keys and buy/sell sides. Candidate changes mark replacedAt without replacing the original legs or ending the event.

## Collection and measurement

The full chain already fetched by the poll supplies quotes for original instruments, irrespective of the displayed shortlist. Missing original instruments, zero/crossed quotes and snapshots received more than 90 seconds before processing produce missing observations. No extra instrument subscription is created. Provider exchange quote timestamps are not available here: snapshot receipt time is recorded and cannot prove exchange freshness.

Entry mark is long ask minus short bid; exit mark is long bid minus short ask, taken from the same chain snapshot. Missing entry quotes remain missing for that observation permanently. Marks are before fees and additional slippage, not fills, net profit or recommendations. Observations retain sampled favourable/adverse points (positive/negative, zero bounded) and 5/15/30-minute point changes from detection/entry observation time. These are snapshot extrema, not continuous MFE/MAE. Horizons use the first poll at/after their due time with at most 90 seconds lateness. Missing/late marks are UNKNOWN; no interpolation. Horizon timestamps disclose actual observation delay.

Completed closes back through the frozen level invalidate the market event. Contract observations continue through 30 minutes after detection, capped at 15:30 IST. Missing candle continuity or revisions make event status UNKNOWN. Mid-candle spot changes do not invalidate it. Later-session prices never fill prior horizons. Poll gaps over 90 seconds are recorded. Expired pending records are finalized on a later poll even after a restart; missed horizons remain unknown.

## Persistence and isolation

Two additive tables: edge_shadow_cursor_v1 (single serialized NIFTY candle cursor) and edge_shadow_events_v1 (one JSON record per market event). Event records hold frozen contract observations and bounded samples. Transactions lock the cursor row, update events and cursor atomically; deterministic event IDs prevent duplicate crossings. A new process reads the persisted cursor and pending events. It only confirms a new crossing with consecutive observed candles and a recent prior poll; downtime cannot manufacture unseen crossings.

Per event: at most 3 contract observations, 120 snapshots per contract, 64 detailed gap intervals plus an uncapped count. At most 200 pending events loaded per poll; reaching the cap reports failure instead of silently skipping. Existing completed events are retained. The read-only report returns the latest 50 events and summarizes samples. This PR does not backfill older events, including the original 2:45 example.

Enable with EDGE_SHADOW_EVENTS_ENABLED=true; default disabled. The tables initialize only when enabled and a database exists. Rollback is to set the flag false and redeploy. No deletes or existing schema changes. Optional observation errors are caught by the server and reported as RECORDING_UNAVAILABLE without changing the live decision. Database operations have the existing pool timeout; observation persistence adds bounded work/latency to polling.

## Report and validation

GET /api/v1/shadow-events returns factual events and per-contract horizon/coverage summaries. It contains research selections only, no private broker fills or journal data. There is no mutation route. Disabled returns enabled:false; unavailable storage returns HTTP 503. decision.shadowEvents exposes recording status and event IDs. The separate durable tables retain the full observations even when lightweight evidence sampling is enabled.

Tests cover candidate replacement while original marks continue, state serialization across restart, one crossing across A/B/C, spread side pricing, completed invalidation, observation after invalidation, missing entries/quotes, stale snapshots, expiry, missed horizons, equality/revisions, next-session rejection, pure-input immutability, disabled storage and rollback/release on database failure. Existing test:all remains the regression gate.

Activation verifies schema and report availability. Live event/outcome validation requires subsequent observed crossings and elapsed horizons; absence of a new event is not a software failure or a performance result. Hosting continuity, UI presentation, actual fills, fees, slippage simulation and profitability validation remain separate work.
