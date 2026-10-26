# EDGE Telegram V1: private, send-only transport

Baseline: `177e0e0b0a18364c75a9c8b478e4f1d78b97a10f`. Independent of monitoring PR #62;
review that collection repair before activation. This branch does not merge or deploy either PR.

## Safety scope

Existing strike selection, A/B/C promotion, orchestration, entry, risk, ledger, snapshots,
outcome harvesting, shadow research, Web Push and UI are unchanged. Seven server integration
lines add a separate optional adapter. It creates no orders and has no incoming commands,
trade buttons, subscriptions, webhooks, public test-send route or broker upload path.

`EDGE_TELEGRAM_ENABLED` defaults off. In that state the adapter makes no database or Telegram
requests, starts no timers and does not create its three tables. Missing credentials, no durable
database, nonnumeric/group/channel recipients, or a `getChat` private-recipient mismatch fail
closed. Only one configured private recipient is supported. Tokens never appear in source,
responses or raw transport-error logs. The fixed HTTPS destination is `api.telegram.org`.

## Events, evidence and delivery

- A readiness message requires an OPEN market, a fresh backend observation, authoritative
  `READY_TO_EXECUTE` plus `executionAllowed:true`, and the backend's non-research Tier A.
  Research B/C, modeled targets, percentages and private broker/ledger data are not copied.
- First observation, restart, storage recovery, observation coalescing and gaps over 90 seconds
  establish a baseline; they do not manufacture retroactive readiness alerts. Contract identity
  includes every observed leg. Changing a contract ends the old ready episode.
- `edge_telegram_events_v1` is an immutable-by-adapter event log. The event, matching outbox
  row and cursor update commit in one transaction. The worker sends only committed events.
  This stores evidence about notifications, not every B/C signal or every market poll.
- `edge_telegram_state_v1` holds a small recipient-specific cursor and daily monitor counters.
  `edge_telegram_outbox_v1` holds pending, sending, sent, expired, failed and uncertain delivery
  outcomes. Nothing is inserted into the existing bounded evidence working set, ledger or
  Web Push tables. No old data is deleted and there is no historical backfill.
- The worker checks TTL, current episode, current market phase and the actual current backend
  object again immediately before a READY send. Poll errors and ledger invalidation can clear
  the current backend object and veto an otherwise fresh queued message. Messages contain
  observation/expiry times and require reopening EDGE to recheck live prices, entry and risk.
- Readiness TTL is 45 seconds. Other live notifications have a five-minute sending window.
  Expired messages remain in the audit table and are never delivered as fresh readiness.
  Text already delivered to Telegram does not disappear when this window expires.
- Claimed delivery has a 15-second lease and per-recipient pacing. An expired in-flight lease
  becomes `UNCERTAIN`: Telegram may have accepted a send before a crash/failed database ACK.
  Network timeouts, invalid/ambiguous responses and unconfirmed ACKs are also uncertain.
  There is no exactly-once or real-device-read guarantee. Uncertain sends are not blindly
  repeated. Explicit 429 responses retry with Telegram's delay, at most four attempts, and
  every retry rechecks freshness. API acceptance is recorded as SENT, not read by the owner.
- A 429 also persists a recipient-wide cooldown in the existing cursor JSON, atomically
  with the outbox result. It blocks every queued message for that recipient, survives
  checkpoints/restarts and remains enforced when the rejected event exhausts its retries.
  No schema change is needed. Expiry and current-readiness checks still run after the wait.
- Optional failures are caught outside the authoritative polling pipeline. The pending
  observation slot is bounded; coalescing is counted and forces a conservative baseline.
  A request has an absolute seven-second deadline and a bounded response body.
  Transport transactions serialize per producer and release their client before any
  Telegram request. The existing database pool is shared, so activation must still check
  polling latency and database capacity; notification isolation is not a resource guarantee.

## Daily monitor summary and limitations

After 15:45 IST, while the backend is awake, it queues one summary for an observed trading
date. If the host sleeps, a later process may queue the prior observed date's summary with
its original date and a current generation timestamp; unobserved days are not invented.
Summary sending expires six hours after generation. Counters cover successful observations
seen by this adapter, recorded alert transitions and detected gaps/coalescing. They are not
full-session coverage, actual trades, measured outcomes, P&L or profitability evidence.

Free-tier sleep, best-effort scheduler timing, missed data and the existing 100-record /
120-minute outcome-harvesting problem remain unresolved. No always-on service or extra
paid resource is introduced. This is designed for the existing single EDGE producer; multiple
simultaneous producers reset each other's baselines and are not a continuity guarantee.

## Activation: separate, owner-authorized step

1. Review this draft and PR #62, their CI, and the source diff before merging anything.
   Both touch the test command; preserve both collection and Telegram suites when rebasing
   or combining them, and rerun the full combined suite before deployment.
2. The owner creates a bot using Telegram's official BotFather and starts a private chat with
   it. Resolve and verify the owner's positive numeric chat ID. Do not use a public channel,
   group, username alias or a third-party bot as the evidence database.
3. Put the bot token and private chat ID into the backend host's secure environment settings,
   never chat messages, frontend code, git, screenshots, browser URLs/history or command logs.
   Existing `EDGE_DATA_DATABASE_URL` / `EDGE_PUSH_DATABASE_URL` supplies PostgreSQL.
4. Deploy the reviewed commit with the feature flag still off. Confirm the intended commit,
   existing regression behavior and read-only `/api/v1/telegram/status` (disabled).
5. After owner approval, enable `EDGE_TELEGRAM_ENABLED=true` and redeploy. Initialization
   verifies the private target and applies only `src/storage/telegram.sql` (three additive
   transport tables). No existing migration, ledger rewrite, evidence deletion or backfill.
6. Verify status and the owner-visible real-device behavior before relying on delivery.
   Do not fabricate a READY state or change risk limits to test a notification. No real-device
   test or Telegram message has been sent by the implementation tests.

Disabling the flag and redeploying stops the transport; retained notification evidence is not
deleted. Rollback is a normal code revert; existing tables may remain unused. Current live
signal selection must remain untouched through activation and rollback.

## Validation

`npm run test:telegram` uses pure fixtures, a PostgreSQL contract fake and an injected HTTPS
transport. It covers authority vetoes, all-leg identity, stale/future observations, baselines,
expiration, daily-summary scope, atomic rollback, recipient isolation, leases, rate limits,
outages, ambiguity, ACK loss, restart, bounded queue and error redaction. No production
database or Telegram request is made. A real PostgreSQL integration test and real-device
delivery check remain activation requirements, not outcomes claimed by mocked tests.

Run `npm run test:all`, `npm run test:syntax`, and `git diff --check` before publication.
Public status counters are explicitly process-local and reset after restart; persistent
delivery outcomes remain in the outbox. No public endpoint exposes those private records.

Official references checked for this implementation:
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#getchat
- https://core.telegram.org/bots/api#responseparameters
- https://core.telegram.org/bots/faq#how-do-i-avoid-hitting-limits
