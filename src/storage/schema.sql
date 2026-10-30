CREATE TABLE IF NOT EXISTS edge_evidence_v1 (
  record_key text PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  record_type text NOT NULL,
  payload_gzip bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_evidence_v1_time ON edge_evidence_v1(recorded_at DESC);
ALTER TABLE edge_evidence_v1 ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS edge_evidence_v1_seq ON edge_evidence_v1(seq);
CREATE TABLE IF NOT EXISTS edge_trade_ledger_v1 (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO edge_trade_ledger_v1(owner_id,payload) VALUES ('owner','{"trades":[],"confirmedDay":null,"lockedDays":[],"operations":[]}') ON CONFLICT DO NOTHING;

-- Additive schema only; no existing ledger or evidence table is altered.
CREATE TABLE IF NOT EXISTS edge_trade_snapshots_v1 (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL CHECK (owner_id = 'owner'),
 request_id uuid NOT NULL,
 analysis_at timestamptz NOT NULL,
 captured_at timestamptz NOT NULL,
 tier text NOT NULL CHECK (tier IN ('A','B','C')),
 payload jsonb NOT NULL,
 UNIQUE (owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS edge_trade_snapshots_v1_time ON edge_trade_snapshots_v1(owner_id,captured_at DESC);
CREATE TABLE IF NOT EXISTS edge_trade_snapshot_matches_v1 (
 snapshot_id uuid PRIMARY KEY REFERENCES edge_trade_snapshots_v1(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK (status IN ('PENDING_TRADEBOOK','MATCHED','PARTIAL','AMBIGUOUS','UNMATCHED')),
 details jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
