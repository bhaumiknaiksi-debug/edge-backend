# 0002: One set of limits, fail closed

Date: 29 Oct 2026. Status: accepted by the owner. Revised the same day after an independent review.

## Decision

The signal engine's position check sizes with the owner's saved sandbox policy: capital, per-trade risk, daily loss and cost reserve.

- **Store-backed.** `execution/ownerLimits.js` reads the policy straight from the sandbox store before every analysis. This works whether or not the sandbox worker is running, armed, or holding its lease.
- **Fail closed.** Missing, malformed or stale limits (older than 60 seconds) leave the budget `UNAVAILABLE`, and nothing can pass the position check. There is no fallback to the old ₹10,000 / ₹1,000 / ₹1,000. Those numbers remain only for legacy callers that supply no limits at all. A missing number never locks the day.
- **Immediate.** Saving the policy updates the limits before the response returns, and bumps the same epoch that ledger changes use. That clears any cached approval and aborts any analysis already under way.
- **Stamped approvals.** Each analysis records the limits it sized under (a version and generation token). A READY is published, and served from cache, only while those exact limits are still current and fresh. A changed, failed or expired read voids it, even if a cache was not cleared. A database read that began before a save can never reinstall the older limits, and a failed read stops approvals at once.
- **Every outlet guarded.** The dashboard, the trade-log plan, the trade-plans overlay, the "I traded" snapshot capture, the sandbox executor's input, Telegram and push all go through the same check (`ownerLimits.approvedOnly` / `servable`). Queued Telegram and push READY alerts are revalidated immediately before sending. A test fails if any new code reads the current result without the guard.
- **One formula.** `execution/riskMath.js` computes a single option's planned loss for both the signal engine and the sandbox executor:
  - entry at the ask rounded up to the tick
  - the stop rounded down to the tick, as the executor's exit plan does
  - a stop-limit fill at that stop minus max(tick, 0.5% of the stop), rounded down
  - plus the cost reserve

  A READY signal is therefore one the executor would accept on risk. A stop-limit at or below zero, or not below the entry, is refused on both sides.

## Why

The owner funds Upstox with ₹10,000 and wants one place to set limits. The first version of this change was reviewed independently, and the review found five problems, all reproduced and fixed here:
1. A malformed value widened risk to ₹1,000.
2. Limits depended on the worker having ticked.
3. A tighter limit did not invalidate existing approvals.
4. The signal and the executor computed risk differently: ₹620 versus ₹652.50 for an entry of 100 and a stop of 92.
5. The tests did not prove the wiring.

A second review of the revision found four more problems, also reproduced and fixed:
1. A slow read could undo a saved tighter limit.
2. A failed read kept old limits approving.
3. Expired limits could accompany a cached READY.
4. The signal and the executor rounded stops differently: ₹649.25 versus ₹652.50 for a stop of 92.04.

A third review found that queued Telegram and push alerts and the trade-log plan bypassed the stamp check, and that signal sizing accepted a zero stop-limit. All were reproduced and fixed. Three further outlets of the same kind (the trade-plans overlay, the snapshot capture and the executor's input) were found and guarded at the same time.

## Consequences

- The owner's −8 point exit on one lot (entry 100, stop 92) plans a ₹652.50 loss, so per-trade risk must be at least about ₹660, and the daily loss at least that much, for such ideas to pass.
- `ledger.js`, `positionSizingEngine.js` and `server.js` are in the signal rule fingerprint, so this ships as a new rule version.
- The daily goal and loss still cannot exceed the sandbox pilot maximum of ₹1,000.
