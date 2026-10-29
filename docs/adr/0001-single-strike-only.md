# 0001: Single option strike only

Date: 29 Oct 2026. Status: accepted by the owner.

## Decision

EDGE's main engine chooses only an outright call (bullish) or an outright put (bearish), in every volatility regime. A neutral regime waits. No spreads, condors, butterflies, straddles or strangles are chosen, and the research card B (a debit spread) is no longer built. The policy is the constant `SINGLE_STRIKE_ONLY = true` in `server.js`. It is fixed in code so that it is part of the signal rule fingerprint.

## Why

The owner trades one strike at a time with about ₹10,000 at Upstox. Over 13 days, 71% of Tier A cards were debit spreads. Those are sized on their full debit, typically ₹2,500–3,500 per lot, so they never fit the ₹1,000 per-trade risk cap. Readiness grade B requires the position gate to pass, which is why the readiness grade was C on every observed day. Single-strike research cards passed the same position gate about 72% of the time.

## Consequences

- The grades A/B/C now rank single-strike ideas, the only kind the owner trades.
- The rule fingerprint changes, so evidence before and after this decision stays separate.
- Exits and stop size are still the existing rules. The quick-exit research (`QUICK_EXIT_V1`) decides whether they change.
- The ₹1,000 per-trade cap is unchanged.
