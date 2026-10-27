# EDGE paper execution and evidence replay

## Scope and baseline

Baseline main: `ef7068723ad08e258db0a648ff8c685fbf546861`. Initial draft: `41950f62a53a3915769d5963f435ba1f66aa99da` (PR #65). This follow-up makes the draft usable with exported EDGE evidence, adds a data-readiness audit, and repairs simulation accounting. It does not import the simulator into the server, add routes, migrate storage, connect a broker, change existing signal selection or alter the live ledger limits. No deployment is required.

The defaults (Rs 10,000 capital, Rs 250 planned trade risk, Rs 500 daily loss threshold, Rs 100 estimated round-trip friction, zero additional slippage) are research assumptions, not approved live settings or measured charges. Stress tests must use realistic nonzero additional slippage. No profit target forces trades.

## What is now implemented

`src/replay/paperExecution.js` models one long call or put, one lot at a time. It buys at observed ask plus assumed slippage, and exits at the next observed bid minus slippage. It reserves round-trip friction, reduces available capital after realized losses, prevents duplicate episode entries, respects remaining daily risk, and latches the daily loss lock. Stop exits can lose more than planned. It checks loss including unrealized position P&L at each usable quote. New entries require an explicitly OPEN market during the regular IST session.

Quotes for the originally held contract remain usable after the displayed candidate changes. Gaps, invalid quotes, or loss of the original position quote make the path terminally UNKNOWN: a later price cannot establish whether a stop or target should have occurred during the gap. Open positions and UNKNOWN paths have null net P&L. There is no artificial close at the end of the input.

`src/replay/paperEvidence.js` consumes real `POLL_SNAPSHOT` records (an array or the public endpoint's `{entries: [...]}` envelope). Outcome records are counted and excluded, not converted into executable prices. It retains the selected contract and expiry. It reads recorded opening-range shadow timing; it never invokes selection, fabricates a trigger, promotes tiers or overrides current execution eligibility. One tier is evaluated per run to prevent competing copies of the same capital. The entry policy is explicitly a research experiment and is not authoritative live readiness.

Only an observed UNKNOWN/WAITING-to-CONFIRMED transition in a matching recorded episode can trigger research entry. First-observation CONFIRMED states, gaps, identity mismatches, expired episodes, future candle closes and unrecognized shadow versions cannot create retroactive entries. Frozen recorded plans must match the record timestamp, tier, strategy and contract. Without a frozen plan, reconstruction is opt-in and requires the recorded planner-source hash to match the local implementation and the original structural inputs to exist. Reconstructed stops/targets are still unvalidated hypotheses.

## Local replay

Run the audit on an existing JSON export:

```sh
npm run replay:paper -- --input /absolute/path/evidence.json --reconstruct-plans
```

This performs no network requests or database operations and prints JSON to stdout. It cannot supply absent observations. To simulate entries it additionally needs explicit timestamped quotes and historical instrument metadata:

```sh
npm run replay:paper -- --input /absolute/path/evidence.json --quotes /absolute/path/quotes.json --instruments /absolute/path/instruments.json --tier C --reconstruct-plans
```

The quotes file is an array of `{instrumentKey, expiry, receivedAt, bid, ask, source}`. Timestamps must include a UTC offset. The most recent quote received no later than the observation is joined by instrument AND exact expiry; future prices cannot influence earlier entries. Quote receipt times are not exchange freshness guarantees. Source provenance must be checked before trusting a dataset.

The instrument file is an array of `{instrumentKey, expiry, lotSize, validFrom, validThrough, source}`. Effective dates and source are mandatory. Neither the current server constant nor a number copied from today's instrument file is silently applied to older contracts. Ambiguous metadata prevents entry. Analysis timestamps, LTPs and outcome candle closes are never substituted for missing bid/ask receipt records. Sidecars are caller-supplied evidence, not broker-verified by this offline tool.

The CLI rejects unknown arguments, including credential arguments. Nothing needs broker tokens.

## Actual endpoint audit on 28 October 2026

`paper-data-readiness-20261028.json` was generated against a read-only response from `https://edge-backend-r1ng.onrender.com/evidence/snapshots?limit=500`. The response returned its current **100-record working set**, not a complete database export: 99 RESEARCH_CANDIDATE_OUTCOME records and one POLL_SNAPSHOT. The poll at `2026-10-27T19:46:03.295Z` is after market close (28 October IST), with no recorded entry trigger, no timestamped quote sidecar or historical lot metadata, and no usable exit hypothesis. The replay correctly opened zero positions and reported net P&L null. This does not prove there were no opportunities, or that the durable database lacks older polls. It establishes that this particular response cannot test an intraday trading strategy.

A minimized copy of that actual poll is preserved in `fixtures/paper-evidence-captured-20261028.json` to test the real schema and missing-data behavior. Synthetic integration tests separately use the existing shadow-timing and planner modules. Fixture profits are never reported as measured market performance.

## Validation and next measurable milestone

Run `npm run test:paper-execution`, `npm run test:all`, `npm run test:syntax`, and `git diff --check`. Tests cover actual module integration, original contract/expiry retention, no lookahead quote joins, explicit metadata, source-version mismatch, no retroactive baselines, unavailable fields, cash depletion, daily loss lock, gap losses, invalid/stale quotes, duplicate episodes, ordering, session boundaries and input immutability.

Before connecting live execution:

1. Obtain a scoped read-only export of the retained market-session polls. Audit what the database actually holds rather than extrapolating from the 100-record endpoint.
2. Capture full-session research observations, contemporaneous hypotheses, quote receipt timestamps and effective broker instrument metadata independently of the bounded working set. Continue observing every open paper contract even if candidates change. This capture path is not implemented by this PR.
3. Replay complete sessions, compare contracts with baseline EDGE, and report trade counts, all skip reasons, UNKNOWN coverage, costs, drawdown and sensitivity to nonzero slippage. Evaluate rules on later held-out sessions. No numerical profit promise or live-readiness threshold is inferred from fixture tests.
4. Separately build sandbox order handling, persistent intent/fill reconciliation, restart recovery, protective exits and kill switch. Establish always-awake hosting and broker static-IP/account prerequisites before live activation.

Rollback is a code revert or deletion of these offline modules, tests, script and report. There is no schema migration, runtime feature flag, open position, production configuration or evidence deletion involved.
