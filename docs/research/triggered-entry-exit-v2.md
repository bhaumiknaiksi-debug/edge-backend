# Confirmed-entry / exit research V2 (TRIGGERED_EXIT_V2)

**Status: research-only, no live or paper entry authority.** This change must not alter strike selection, A/B/C ranking, candidate risk or sizing, V3 state/confirmation, existing QUICK_EXIT_V1, orders, stop placement or broker integration.

## Why

QUICK_EXIT_V1 buys at the first card's ask. A card can first be flagged before V3 has confirmed the breakout; reusing the first ask as though it were an executable confirmed entry can exaggerate or misstate real entry opportunities.

V2 records the **first contemporaneous V3-confirmed readiness poll** for each existing single-leg candidate episode. It stores the actual candidate's ask/bid observed at that poll, the known-at and analysis timestamps, breakout ID, crossing time, expiry, contract ID and implementation fingerprint. The entry is *not* reconstructed from later data. The original first-card record is unchanged.

## Collecting & report

The existing `EDGE_OPPORTUNITY_REPORTS_ENABLED=true` census adds `triggerObservation` to each observed A/B/C candidate when shadow timing exists. **V2 harvesting is OFF by default:** it requires the additional `EDGE_TRIGGERED_EXIT_V2_ENABLED=true` flag. This lets the existing V1 census and quick-exit collection continue normally while V2 is disabled. When enabled, the opportunity service harvests a separate `OPPORTUNITY_TRIGGER_EXIT_V2` outcome from the same Upstox expired-option/active-option 1-minute candle reader. The work remains bounded to 10 contract/day downloads and 60 writes per pass and is skipped when disabled, with no broker orders or trading decision changes.

Read the owner-only `/api/v1/opportunities` report (`triggeredExitV2` key); the existing quick-exit panel now displays V2 coverage and paired results. The collection status has a `triggeredExitV2` entry.

Only a poll whose V3 plan is `CONFIRMED`, `shadowEntryReady=true`, whose quote was recorded within 15 seconds of analysis, and whose entry was known before the breakout deadline qualifies for this comparison. If no such poll exists, the episode remains explicitly unmeasured. **Historical observations predating this deployment cannot be retroactively assigned a V3-confirmed ask.**

## Predeclared comparison, not a trade

- Primary exit is inherited unchanged from QUICK_EXIT_V1: **+8 / −8 premium points / max 30 minutes**.
- Existing sensitivity exits are also reported, not selected as hindsight winners.
- Entry is the **recorded confirmed ask**, and the simulation starts at the *next full 1-minute candle* following the observation. No portion of the already-running minute is inspected.
- Every candle from start to target/stop or time exit must be present. On both stop and target in a single candle, **stop wins**. A stop gap fills at the candle open if worse.
- The exit reference is a historical option OHLC price, **not an executable bid**. Report separately with optimistic 0-point, baseline 1-point and stressed 2-point exit haircut. Brokerage, STT, transaction costs, stamp duty, SEBI fees, IPFT and GST use existing `tradingFriction.js`'s Upstox 2026 rate profile (not actual contract-note verification). The entry ask already accounts for the bid/ask side; no additional entry spread is subtracted.
- For *paired* candidates measured in both V1 and V2, reprice the V1 exit and V2 exit with the **same** 1-point haircut and fee profile, and report the mean net difference across paired episodes. Both remain model counterfactuals. No direct comparison with actual owner trade P&L is claimed.

**Limitations:** OHLC does not prove fills, spreads, exit liquidity or quote freshness at exit. Modelled stops are not guarantees. Overlapping strikes/tiers/episodes on the same market movement are correlated. A missed or delayed observation is UNKNOWN, not a zero-profit trade. Without sufficient forward episodes and distinct trading days, no strategy promotion, tuning or live-trading conclusion is authorized.

## Validation / rollback

Run `npm run test:triggered-exit`, `npm run test:opportunities`, `npm run test:all` and `npm run test:syntax`. Verify no changes to PAPER/Upstox sandbox code, strike selection or V3 entry logic.

For an isolated V2 rollback, set `EDGE_TRIGGERED_EXIT_V2_ENABLED=false` and restart; the existing opportunity census and V1 quick-exit continue. To disable all opportunity collection, set `EDGE_OPPORTUNITY_REPORTS_ENABLED=false` and restart. Alternatively revert this PR; V1 persisted records remain intact. A restart disarms paper execution, requiring the owner to review/arm separately. No old records are rewritten.
