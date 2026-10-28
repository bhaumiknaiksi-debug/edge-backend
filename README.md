

### Kite Tradebook historical import (owner-only)
`POST /api/v1/trades/import` accepts a maximum of 120 locally parsed, validated NIFTY option fills with `clientId`, `fills`, and a unique `requestId`. Each fill contains `symbol`, `exchange`, `tradeDate`, `time` (Kite local IST), `side`, `quantity`, `price`, `tradeId` and `orderId`.

The route uses the same owner Bearer authentication as the manual ledger. Broker history is stored in a separate `brokerFills` field of the existing protected ledger JSONB payload: no schema migration, broker API credentials or brokerage orders. Imports retain original Kite execution timestamps, deduplicate overlapping uploads by Kite fill identity, reject conflicting fills/account mismatches, and build FIFO summaries for completed long NIFTY option cycles. Unmatched sells and open buys are flagged. Reports show **gross P&L only**: Excel tradebook fills do not include verified brokerage and statutory charges. `netPnl` stays null.

**Safety invariant:** Imported broker history is excluded from daily reconciliation, live available-capital calculations, loss allowances, signal selection and entry approval. It does not invoke the market-poll-invalidating `onChange` callback. Existing manual `/open` and `/close` operations retain their semantics. Reconcile live broker positions using the manual ledger as before. This intentionally avoids incorrectly assigning historical trades to today.

## Durable evidence and manual trade ledger

`EDGE_DATA_DATABASE_URL` (or the existing `EDGE_PUSH_DATABASE_URL`) selects PostgreSQL as the primary evidence store. Apply `src/storage/schema.sql` with `npm run migrate:data` before deploying. This is additive: it preserves push subscriptions and settings. Snapshots, tier candidates, transitions and harvested outcomes are gzip-compressed and keyed for idempotent inserts. Records are retained in PostgreSQL; `EDGE_EVIDENCE_MEMORY_LIMIT` controls the restored working set (default 100, bounded to 50–500). Restore failures stop startup. Full-mode append failures prevent publishing a fresh decision; lightweight recording failures are reported but preserve the existing live decision. Local JSONL remains a development fallback only when no database is configured.

`GET /evidence/health` returns 503 while evidence is initializing or when reported polling/storage/harvester health fails. Its counters describe the **loaded working set**, not an audit of every retained database record or uninterrupted market coverage. `continuousCollectionVerified` remains false. `GET /evidence/storage/verify` in PostgreSQL mode compares one loaded record to its persisted, decompressed contents using a SELECT only; the `SINGLE_RECORD_READBACK` result is not an archive backup or a whole-session durability proof. Empty, missing, damaged and unavailable data fail verification. Archive mode continues using the separate `POST /evidence/archive/verify` round trip. Scheduled and live-smoke checks assert JSON health rather than accepting HTTP 200 alone. See [collection monitoring repair](docs/audits/collection-monitoring-repair.md) for rollout, regression tests and remaining limitations.

The private `/api/v1/trades` routes use the existing alert owner code as a Bearer token. GET reads records; POST `/open`, `/close`, `/confirm` requires a unique `requestId` for retry safety. Entries describe **actual broker fills**, including fills outside policy; these routes never place broker orders. Close records require actual total charges. All writes serialize on the owner row in a database transaction.

Sizing uses a ₹10,000 capital ceiling and ₹1,000 daily planned-loss allowance, including existing open risk and a ₹100-per-lot estimated cost/slippage reserve. Recorded cumulative net losses reduce capital availability; profits do not raise the ceiling. Daily reconciliation resets at 09:15 IST. Reaching a realised net loss of ₹1,000 locks entries for that session, even if subsequent gains recover it. An unreconciled, stale or unavailable ledger blocks entries. Credit strategies remain blocked without verified broker margin. Stops can slip: these are planning controls, not guaranteed loss caps or broker-side enforcement.

Control → Manual trade log supports whole-position entries/closes. Split fills must be logged separately. Historical records are not automatically reconstructed, and no broker reconciliation is automatic. Database persistence does not prevent a free hosting instance from sleeping; missed market observations cannot be recovered by this storage change.

## Optional private Telegram notifications (send-only, disabled by default)

The Telegram adapter mirrors backend-confirmed Tier A readiness and invalidations, warns about
stale collection while the backend is awake, and queues a daily monitor summary after 15:45 IST.
It never places orders, changes signal/risk rules, accepts trade commands or uploads broker history.
Existing Web Push is unchanged. Telegram has separate additive event/outbox tables so it does not
displace the 100-record evidence working set.

Enable only after review, deployment and secure configuration of `EDGE_TELEGRAM_BOT_TOKEN` and
the owner's positive numeric `EDGE_TELEGRAM_CHAT_ID`, then set `EDGE_TELEGRAM_ENABLED=true`.
The adapter requires PostgreSQL and verifies that Telegram reports that exact recipient as a
private chat. With the flag off, it creates no tables, timers or Telegram requests. Optional
`EDGE_TELEGRAM_DAILY_SUMMARY_ENABLED=false` disables the daily summary only.
Public read-only `GET /api/v1/telegram/status` exposes configuration/delivery health without
credentials, recipient IDs or message contents. There is no public send, webhook or trade route.

Messages are persisted before delivery. Readiness expires after 45 seconds and is rechecked
against the current backend result immediately before sending. Telegram API acceptance is not
proof of phone delivery or that a message was read. Ambiguous sends are retained as `UNCERTAIN`,
not silently retried; rate-limit retries still obey freshness and expiry. Summaries are explicitly
coverage-unknown and contain no profit claims. Backend sleep still loses observations and can
delay alerts/summaries; Telegram does not keep the collector running or fix outcome harvesting.
See [Telegram send-only rollout](docs/audits/telegram-send-only.md) and run `npm run test:telegram`.

## Private opportunity coverage

The owner report at `/api/v1/opportunities/control` matches imported Kite fills and saved snapshots to recorded tiers and rejection gates. It separates recording gaps from known misses, compares all flagged candidate/readiness episodes, and groups results by rule fingerprint. The sandbox page includes owner-set daily goal/loss controls. No gate loosening or live trading is enabled. See [methodology, limits and rollback](docs/execution/opportunity-coverage.md).

The optional sandbox executor (`EDGE_SANDBOX_EXECUTION_ENABLED=true`, Upstox sandbox host only, no live mode) places test orders from an owner-armed worker and is controlled at `/api/v1/execution/sandbox/control`. By default it trades only authoritative Tier A; the owner can opt into experimental modes that trade B/C candidates after their fixed opening-range level is crossed, or let Claude (via the Anthropic API, `ANTHROPIC_API_KEY`) choose among EDGE's candidates once per 5-minute candle while code enforces every limit. Every sandbox trade records its entry tier. See `docs/execution/upstox-sandbox.md`.
