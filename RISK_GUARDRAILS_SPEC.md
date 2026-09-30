# Risk Guardrails Specification — V1 (NOT ENABLED)

These controls are specifications only. They must not affect live orchestration until separately implemented, reviewed and enabled.

## Invariants

1. Guardrails are **vetoes only**. No signal quality, confidence or later setup may override an active lock.
2. Every signal that reaches READY_TO_EXECUTE is logged before guardrail evaluation.
3. A vetoed READY episode receives a durable veto record and its counterfactual outcome is harvested normally.
4. A loss is determined **net of configured friction at final exit**.
5. Session state is keyed to the NSE trading session and resets at 09:15 IST, except an open trade spanning the boundary remains attributed to its originating session until final exit.
6. Restart must reconstruct guardrail state from durable evidence, never from process memory alone.
7. Observed-only / WAIT / NO_TRADE states do not increment trade or loss counters.

## Proposed state machine

OPEN → LOCKED_MAX_TRADES | LOCKED_LOSS_COOLDOWN | LOCKED_PROFIT

A locked state can return to OPEN only through its specified deterministic reset condition. A later high-quality signal cannot bypass it.

### Max trades/session
Counter increments only for READY episodes marked taken or paper-logged. Limit value is **not chosen in this specification**. Reset: next NSE session start.

### Consecutive-loss cooldown
Increment only when a taken/paper-logged READY episode reaches final exit with net-of-friction loss. Partial exits do not classify the trade until final exit. Cooldown length and consecutive-loss threshold are **not chosen yet**. A restart reloads the streak and cooldown expiry from durable records.

### Profit lock
Based on realized net-of-friction session P&L only. Unrealized profit cannot activate it. Threshold and lock behavior are **not chosen yet**. Reset: next NSE session start.

## Required tests before activation

Partial exit then final exit; trade spanning reset; restart while OPEN; restart while each lock is active; vetoed READY signal still harvested; repeated READY polls count as one episode; new opportunity creates a new episode; WAIT/NO_TRADE never increments counters; later high-confidence signal cannot override a lock.
