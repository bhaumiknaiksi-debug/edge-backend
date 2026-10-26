-- Additive, optional Telegram transport storage. Existing evidence/ledger tables are untouched.
CREATE TABLE IF NOT EXISTS edge_telegram_state_v1 (
  recipient_key text PRIMARY KEY,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_telegram_events_v1 (
  event_id text PRIMARY KEY,
  recipient_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_telegram_outbox_v1 (
  event_id text PRIMARY KEY REFERENCES edge_telegram_events_v1(event_id) ON DELETE RESTRICT,
  recipient_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','EXPIRED','FAILED','UNCERTAIN')),
  attempts integer NOT NULL DEFAULT 0,
  priority smallint NOT NULL,
  created_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz,
  message_id bigint,
  last_error text
);
CREATE INDEX IF NOT EXISTS edge_telegram_outbox_pending_v1
  ON edge_telegram_outbox_v1(recipient_key,status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS edge_telegram_events_time_v1
  ON edge_telegram_events_v1(recipient_key,occurred_at DESC);
