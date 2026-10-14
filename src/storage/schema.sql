CREATE TABLE IF NOT EXISTS edge_evidence_v1 (
  record_key text PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  record_type text NOT NULL,
  payload_gzip bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_evidence_v1_time ON edge_evidence_v1(recorded_at DESC);
CREATE TABLE IF NOT EXISTS edge_trade_ledger_v1 (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO edge_trade_ledger_v1(owner_id,payload) VALUES ('owner','{"trades":[],"confirmedDay":null,"lockedDays":[],"operations":[]}') ON CONFLICT DO NOTHING;
