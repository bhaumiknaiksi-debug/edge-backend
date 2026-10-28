# EDGE sandbox execution V1

This is an executable sandbox order workflow, connected to EDGE through an optional background worker and owner-only controls. It is not a live trading release. Every order and cancellation has a hard-coded `api-sandbox.upstox.com` destination. There is no live mode or live-order host setting. The existing market-data credential is used only for a fixed GET quote endpoint.

## Runtime setup

Existing production configuration is unchanged until an operator configures the sandbox feature. The service needs:

- Existing PostgreSQL pool and EDGE owner code.
- `EDGE_UPSTOX_SANDBOX_TOKEN`: a separate token generated from an Upstox sandbox app, stored only in server environment settings. Never paste it in chat, source, browser URLs or frontend code. Existing market-data tokens do not substitute for it.
- Existing `UPSTOX_ACCESS_TOKEN`: read-only quote acquisition uses the current data connection.
- `EDGE_SANDBOX_EXECUTION_ENABLED=true`: opt-in flag. Off by default. Disabled/missing configuration makes no execution database requests, HTTP requests or timers. Invalid optional credentials fail closed without crashing the main backend.

With the flag enabled, one additive `edge_sandbox_execution_v1` JSONB state table initializes in the existing database. It is separate from trading history, evidence and Web Push. No existing table is altered and no historical trades are imported. The state starts killed/disarmed. It does not place a test order automatically.

The public `/api/v1/execution/sandbox/status` shows configuration/worker status without credentials, orders, positions or contracts. `/api/v1/execution/sandbox/control` provides a sandbox control page using the existing owner code. The owner code stays in page memory, not local storage or URLs. The API requires owner Bearer authentication for full state and POST `/arm` or `/stop`; commands require `confirmSandbox:true` and a unique `requestId`. Replaying an old ARM request cannot override a later STOP. No public order-send or inbound broker webhook endpoint exists.

A read-only broker smoke is available with `npm run check:sandbox-connection` from a host where the sandbox token is securely configured. It calls order-book and positions reads and reports only counts/capabilities. It never places an order. The positions read may return 404 even when the order-book read succeeds.

## Decisions and limits

The worker reads the untouched current EDGE result. By default (`AUTHORITATIVE_A_ONLY`) it accepts only existing authoritative Tier A, explicit READY_TO_EXECUTE/executionAllowed, risk READY and position READY. An owner-selected experimental mode (below) can also trade B/C candidates. It supports one long NIFTY call or put, one broker-defined lot, and one open sandbox trade at a time. C/B research candidates are not promoted by the executor. The original instrument, strike, expiry, strategy and contract remain fixed for each trade. Multi-leg strategies are not supported in V1.

Pilot sandbox settings are Rs 10,000 capital, Rs 250 planned risk per trade, Rs 500 daily loss threshold, Rs 100 estimated round-trip friction and at most three entries per IST date. These do not change the live ledger and are not measured brokerage charges. Broker-reported fill P&L minus the friction estimate is labeled as estimated P&L. Losses reduce the capital ceiling; profits do not expand it. Stops and daily thresholds are not guaranteed loss caps.

New entries are considered from 09:30 until 15:00 IST, rechecked immediately before sending, and expire after 15 seconds while queued. Existing EDGE market/calendar and eligibility gates still apply. The worker requests closure after 15:15 IST. These are sandbox pilot restrictions, not a claim that this strategy is profitable.

Instrument lot, strike, expiry and tick size come from the official NSE BOD CSV (rupee tick values, e.g. 0.05). A current IST-date Last-Modified header is required, preventing silent use of stale files. One-lot requests do not use slicing; broker/exchange limits may still reject an order. Full market quotes are fetched independently for the original open contract as well as the currently displayed candidate. They require fresh exchange timestamps and two-sided depth; LTP is not substituted. No decision or selected candidate is mutated.

## Entry modes, per-trade risk and owner recovery

These controls are sandbox-only, owner-authenticated, require STOP and a flat account to change, and do not touch EDGE's decision, tiers or the live ledger.

**Entry mode.** `AUTHORITATIVE_A_ONLY` (default) is the behaviour described above. `OPENING_RANGE_SHADOW_V1` lets the executor trade a single-leg long call or put from the Tier A, B or C research card (A preferred) once that card's `OPENING_RANGE_SHADOW_V1` timing is CONFIRMED and shadow-entry-ready. That timing freezes the day's opening-range high/low and waits for a completed 5-minute candle to close through it, so a crossing is a detectable event (the original trigger compares spot with a level recomputed three strikes from spot, which cannot be reached). It requires `EDGE_SHADOW_TIMING_ENABLED=true`. A confirmed call is refused when the regime is bearish, a confirmed put when it is bullish, and when spot has fallen back through the level. The executor's own gates still apply unchanged: fresh two-sided quote, spread, instrument metadata, one open trade, trade count, capital, daily loss, per-trade risk and time window. This mode does not use the setup-qualification gate; it is the experiment whose evidence the opportunity report exists to judge.

**Stop and target in this mode.** `ANCHOR_INVALIDATION_V1`: the stop is the premium implied by price returning to the frozen level (entry minus delta times the points travelled beyond the level, never tighter than twice the quoted spread), and the target is 1.5 times that planned premium risk. These are delta estimates, not guaranteed fills. The broker-held stop-limit and the existing quote-driven exits are unchanged. A candidate that has already run far past its level is rejected by the risk budget instead of being chased.

**Tier is recorded.** Each sandbox trade stores the tier it entered at, the entry source, the rule version, the risk model and the frozen level. The owner page and `GET /api/v1/execution/sandbox` report realized estimated P&L by entry tier. Estimated P&L is broker fills minus the Rs 100 friction reserve.

**Per-trade risk.** `perTradeRisk` is now its own setting (`POST /policy`), above the Rs 100 friction reserve and never above the daily loss threshold (pilot maximum Rs 1,000). It is never raised implicitly; lowering the daily loss threshold can only lower it. Capital stays fixed at Rs 10,000.

**Resolving a prior-day trade.** The sandbox order book resets daily, so a trade left open overnight cannot be reconciled and blocks everything. After STOP, the owner can `POST /resolve` (`requestId`, `tradeId`, `reason`, `confirmSandbox:true`). It applies only to trades from an earlier IST day: working orders are marked expired, unsold quantity is valued at zero (worst case), and the result is booked on the trade's own day so today's loss lock is unaffected. Same-day trades cannot be resolved this way.

**Error halts cancel unfilled entries.** Any worker error that halts the sandbox (for example a broker read failure) now also requests cancellation of a known, working entry order, not only STOP. A halted worker still cannot submit another SELL until it reconciles. Arming afterwards requires a fresh reconciliation.

## Order lifecycle

1. Persist a deterministic entry intent, then claim it as SUBMITTING before any HTTP mutation. Session/contract identity deduplicates repeated polls.
2. Keep ACKNOWLEDGED separate from fills. Reconcile tag, instrument, side, product, quantity, order type, prices and cumulative fills against the broker order book. When positions are available they are independently checked. A sandbox positions HTTP 404 enables the explicitly labeled `SANDBOX_ORDER_BOOK_DERIVED` basis: exposure is calculated solely from validated broker-reported fills, not independently confirmed by a positions API. Unknown orders and unresolved prior-day trades halt reconciliation. Other positions errors fail closed. This fallback is sandbox-only and is not proof of broker-account flatness, particularly after broker book rollover.
3. For a partial entry, cancel the unfilled remainder and wait for terminal broker confirmation before fixing the protective-stop quantity. There is an unprotected interval while cancellation/stop placement completes; this alone prevents treating V1 as a production-ready execution system.
4. Place a broker-held SELL stop-limit for the confirmed quantity. A stop-limit is not a guaranteed fill. Fresh quotes, target/stop breach, estimated loss threshold, time exit, restart or STOP control may request closure.
5. Cancel an active protective stop and wait for broker terminal status before submitting a new SELL exit. If the stop fills while cancellation is pending, reconcile its fill and sell only the remaining net quantity, preventing duplicate exits/short positions.
6. Retry an exit only after its prior order is terminal, using a new intent. At most three exit orders are created. Failure to flatten remains visible; no successful exit is invented. Cancellation retries are bounded and use subsequent broker status, not blind resubmission of entry orders.

A DB worker lease prevents simultaneous instances from claiming the same orders. No DB transaction is held during HTTP calls. Request timeouts and ambiguous API/DB ACKs never cause blind order resubmission. Restart disarms entries, preserves orders, and reconciles ambiguous sends by deterministic tag. Unresolved or foreign orders/positions block entries. Since broker order books roll over, an unknown prior-day order can remain blocked pending manual reconciliation. A restarted worker requests closure of carried sandbox exposure instead of silently resuming entries.

STOP immediately persists killed/disarmed state and requests cancellation/closure. A request already in flight can still be accepted; subsequent reconciliation handles it. During quote outages the worker retains an existing protective stop, can cancel a known unfilled entry, and does not invent an exit price. During broker-read outages it may best-effort cancel a known entry; it cannot establish fills/flatness or submit another SELL until reconciled. Host sleep and network loss still prevent timely software-managed exits. Broker-held stops persist independently, but are not a replacement for reliable hosting.

## Broker capability boundary

Upstox's current sandbox list explicitly advertises placement, modification and cancellation. An older official announcement also describes order/detail/book lifecycle retrieval. The sandbox account returned an order-book success and positions HTTP 404 on 28 October 2026. The worker can use the clearly labeled order-book-derived basis for this specific 404; it never falls back to live-account reads or simulated broker fills. Sandbox order placement and a real sandbox fill/exit lifecycle remain unverified.

## Validation and rollout

Baseline: main `ef7068723ad08e258db0a648ff8c685fbf546861`, transport draft `0190de3e1e0c1b5dc3060db519f12a801e2de868` (PR #66).

- `npm run test:upstox-sandbox`: transport contracts, broker catalog/quote parsing, lifecycle races, owner-auth HTTP, lease/idempotency, partial fills, kill/quote/read outages, persistence ACK loss and restart tests. Broker/network responses are injected in these tests.
- `npm run test:all`, `npm run test:syntax`, script syntax and `git diff --check`.
- Actual PostgreSQL: table initialization, row-lock syntax and nested rollback were checked in a separate disposable test branch, not production. Node-to-PostgreSQL integration was attempted with `scripts/test-sandbox-postgres.js` but blocked by workspace DNS (`EAI_AGAIN`). Concurrency/adapter behavior has contract tests; a driver-level concurrent production integration result is not claimed.
- The opt-in PG integration script requires `EDGE_EXECUTION_TEST_ALLOW_WRITE=true` and a private connection-config file for an isolated test branch. It creates a random test schema rather than overwriting existing application tables. Do not use the production database URL.

Finish current-head CI/review before merging. First deployment stays disabled. Check the public disabled status, existing health endpoints and unchanged source/selection regression checks. Actual sandbox authentication, capability smoke, owner arming and order/fill/cancel/exit testing remain required before activation. Real trading additionally needs the separate live transport, account/static-IP setup, reliable hosting, broker reconciliation and live-specific risk review. No live credential, money transfer or broker-account change is part of this PR.

Rollback: disable the sandbox flag and redeploy. Inspect and manually cancel/close any sandbox exposure in Upstox; disabling the worker does not establish flatness. Keep the state table for reconciliation. A code revert can remove the hooks and modules; there is no data deletion or migration reversal.

Official references checked:
- https://upstox.com/developer/api-documentation/sandbox/
- https://upstox.com/developer/api-documentation/v3/place-order/
- https://upstox.com/developer/api-documentation/v3/cancel-order/
- https://upstox.com/developer/api-documentation/get-order-book/
- https://upstox.com/developer/api-documentation/get-positions/
- https://upstox.com/developer/api-documentation/get-full-market-quote/
- https://upstox.com/developer/api-documentation/instruments/
