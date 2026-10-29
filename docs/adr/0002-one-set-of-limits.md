# 0002: One set of limits

Date: 29 Oct 2026. Status: accepted by the owner.

## Decision

The signal engine's position check sizes with the owner's sandbox control-page limits: capital, per-trade risk and daily loss. These replace the fixed ₹10,000 / ₹1,000 / ₹1,000 in `trading/ledger.js`. The fixed numbers remain only as a fallback when the policy cannot be read or a value is malformed. Per-trade risk is never allowed above the daily loss. The daily lock in the manual ledger follows the same daily loss.

## Why

The owner funds Upstox with ₹10,000 and wants a single place to set limits. Two rulebooks, a hidden ₹1,000 cap in the engine and the control-page limits for the sandbox, made it unclear why ideas were or were not graded.

## Consequences

- Changing per-trade risk on the control page changes which ideas can reach grade B or A. The owner's −8 point exit on one lot risks about ₹620 (8 × 65 + ₹100 reserve), so per-trade risk must be at least about ₹620 for those ideas to pass.
- `ledger.js` and `positionSizingEngine.js` are in the signal rule fingerprint, so this ships as a new rule version.
- The daily goal and loss still cannot exceed the sandbox pilot maximum of ₹1,000.
