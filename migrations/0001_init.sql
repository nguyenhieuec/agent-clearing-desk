-- Agent Clearing Desk schema.
-- Money columns are INTEGER millicents (1/1000 of a US cent): no floating point in the ledger.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS agent_keys (
  key_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  budget_mc INTEGER NOT NULL CHECK (budget_mc >= 0),
  -- spent_mc includes in-flight reservations; the CHECK makes overspend impossible
  -- even if a caller skipped the conditional reservation update.
  spent_mc INTEGER NOT NULL DEFAULT 0 CHECK (spent_mc >= 0 AND spent_mc <= budget_mc),
  allowlist TEXT NOT NULL DEFAULT '["*"]',
  price_overrides TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_keys_org ON agent_keys(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  upstream TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  params_summary TEXT NOT NULL,
  params_sha256 TEXT NOT NULL,
  result_sha256 TEXT,
  error_detail TEXT,
  cost_mc INTEGER NOT NULL DEFAULT 0,
  price_mc INTEGER NOT NULL DEFAULT 0,
  margin_mc INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_audit_logs_key ON audit_logs(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  audit_log_id TEXT NOT NULL UNIQUE REFERENCES audit_logs(id),
  key_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  amount_mc INTEGER NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  issued_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_receipts_key ON receipts(key_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_org ON receipts(org_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  key_id TEXT NOT NULL,
  event TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  spent_mc INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, event, period)
) WITHOUT ROWID;

-- The ledger is append-only: audit rows and receipts can be inserted, never changed or removed.
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts is append-only'); END;
