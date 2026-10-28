# Opportunity coverage and rule-change prerequisites

Baseline: main `6ffe61e421222e3d7b9805e8ae9d5d7f1214b937` (PR #69). This release adds reports and sandbox settings. It does not loosen entry, selection, setup, tier, liquidity, risk, or position gates. Live trading remains out of scope until an actual sandbox order/fill/protection/exit lifecycle has completed against the owner's real sandbox token.

## Owner report

Open `/api/v1/opportunities/control` on the backend and enter the existing EDGE owner code. Credentials stay in page memory. The private GET `/api/v1/opportunities` returns the complete report; the page can download it as JSON. No owner trade data is exposed by `/status` or the static page.

The report reads the entire supported persisted archive in a repeatable-read, read-only database transaction, with imported fills and every saved snapshot. It retains only reporting fields, not the historical full-snapshot copies embedded inside outcomes. Incremental refreshes use a timestamp/key cursor and verify the total count; a late historical insert forces a full read. This relies on the application's append-only evidence contract. It does not use the small recent-record buffer. Corrupt records, missing storage, or more than 50,000 evidence records / 10,000 snapshots / 32 MiB projected data produce an unavailable report rather than silently truncated coverage. Individual decoded records are bounded to 2 MiB. These explicit limits will need a paginated reporting store as the archive grows.

Every imported fill has an exact expiry/strike/option-type match attempt, historical tier changes, source times and rule fingerprints. Monthly symbols without an exact expiry remain unresolved. A saved click after an execution does not prove that EDGE had displayed the same candidate before execution. No later A-tier result is backfilled onto an earlier trade. The contemporaneous lookback is at most 90 seconds. Older matches remain visible in the history but do not establish readiness at entry.

Missing collection is `UNKNOWN_RECORDING_GAP`, not a gate rejection. `NOT_FLAGGED_AT_OBSERVED_POLL` means an actual nearby poll exists without that contract. Rejected candidates show known false gates. Historical B/C cards without candidate-specific checks show their research-only execution restriction; authoritative-plan gates are provided separately and are not attributed to a different C-card contract.

Candidate A/B/C cards can contain different structures. The actual authoritative readiness tier is another axis. Both have separate results. Candidate-card episodes start at the first flag per session, trading implementation fingerprint, strategy and contract identity. Disappearance, a changed identity, a rule change or an observation gap over 90 seconds starts a new episode. Readiness episodes additionally restart on a readiness-tier change of the authoritative structure. Repeated polls do not add samples. The two cohort axes overlap and must not be added together as independent trades.

## Expectancy and missing outcomes

All flagged episodes remain visible, including losses, flat outcomes, off-hours observations and unavailable results. Off-hours records are explicitly unmeasured. Reported expectancy uses a common 60-minute candle-close horizon and the recorded executable entry bid/ask, with a maximum two-minute exit-mark tolerance. It does not choose the best later price or infer stop/target execution. Records with missing executable quotes, contract identity, lot size or correct horizon marks are identified; missing monetary results are never zero-filled.

The estimated net scenario subtracts Rs100 per leg for one recorded lot. This is a friction reserve, not actual brokerage or verified fills. Manual Kite gross P&L, broker statement charges, and modeled candidate expectancy are different quantities. Partial manual imports, short entries and multi-leg grouping cannot be assigned invented per-trade profits. Coverage includes every fill; the gate-priority queue counts unique buy orders and labels this scope.

`OPPORTUNITY_FIXED_60M_V1` versions the measurement. Existing `SIGNAL_RULE_SPEC_V1` source fingerprints identify trading implementations; unversioned historical records remain unversioned. Results are split by implementation fingerprint and by cohort axis. These descriptive, overlapping samples do not establish statistical confidence or a profitable live policy.

The outcome collector reads historical candles only, processes up to four episodes per run, retries unavailable requests up to three times with backoff, and persists results. It runs once a minute while the host is awake. POST `/api/v1/opportunities/measure` requests another bounded pass. Expired-contract requests now use the observation's IST trade date rather than the expiry date. Closed-market horizons and data gaps remain unavailable. Free-host sleep still interrupts recording; no full-session coverage is claimed.

## Recording and gate changes

The optional census records every successful OPEN poll independently of whether the owner traded, the signal tier, or whether a gate passed. It freezes each existing candidate's contracts, quotes, recorded lot size, current rule hash, and a read-only evaluation of the current gates for that candidate. These evaluations never authorize B/C trades or change the original decision. Failures are isolated from signal generation and reported as recording errors.

`EDGE_OPPORTUNITY_REPORTS_ENABLED=false` disables the census, reports and collector. Otherwise they use the existing database and evidence store. No new infrastructure or schema migration is required.

`COVERAGE_AND_EXPECTANCY_REQUIRED_V1` leaves every proposed gate change unauthorized. The queue ranks the largest classified buy-order misses first, while collection gaps are assigned to coverage repair. Before changing a gate, a new implementation must link a frozen report fingerprint, exact candidate-specific gate rejections, all-candidate winners/losses/missing outcomes, chronological validation with overlap control, regression/replay results and rollback. No blanket B/C authorization follows from profitable owner-selected trades. Each accepted change must receive its own source rule fingerprint. This release applies no such change.

## Daily goal and loss limit

The sandbox control page now allows the owner to set `dailyGoal` and `dailyLoss` with authenticated POST `/api/v1/execution/sandbox/policy`, a unique request ID and `confirmSandbox:true`. It displays loss as a percentage of goal. The default remains Rs1,000 goal and Rs500 loss threshold (50%). The goal is a reporting target, not promised income, a forced-entry target or a sizing multiplier.

Configuration requires killed/disarmed and flat state. Existing capital, trade-count and pilot daily-loss ceilings remain in force: Rs10,000 capital and at most Rs1,000 daily loss threshold. Tightening a threshold can reduce the per-trade allowance; raising a goal never increases it. A hit daily loss lock persists across settings changes and restarts. Actual losses can exceed thresholds during gaps, slippage, stop-limit non-fills or outages. These settings do not change the separate manual ledger's existing controls.

## Validation and rollback

`npm run test:opportunities` covers no hindsight, missing collection, exact contracts, cohort dedupe, rule splits, both tier axes, wins/losses/unavailable outcomes, full-archive read isolation, private HTTP routes, static CSP and unchanged decisions. `npm run test:upstox-sandbox` includes settings idempotency, stopped/flat requirements and persistent daily loss locks. Run the full suite and syntax check before merging.

Rollback: set `EDGE_OPPORTUNITY_REPORTS_ENABLED=false` and redeploy, or revert this release. Retain all recorded data; no schema rollback or data deletion is necessary. Existing sandbox orders must still be reconciled separately. A deployment/restart disarms sandbox entries.
