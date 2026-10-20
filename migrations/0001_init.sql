-- Agent Clearing Desk Schema

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
  budget_cents REAL NOT NULL DEFAULT 0,
  spent_cents REAL NOT NULL DEFAULT 0,
  allowlist TEXT NOT NULL DEFAULT '["*"]',
  per_call_price_cents REAL NOT NULL DEFAULT 5,
  tool_pricing_overrides TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_agent_keys_org ON agent_keys(org_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  request_method TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  params_summary TEXT,
  cost_cents REAL NOT NULL DEFAULT 0,
  price_cents REAL NOT NULL DEFAULT 0,
  margin_cents REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_audit_logs_key ON audit_logs(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  audit_log_id TEXT NOT NULL UNIQUE REFERENCES audit_logs(id),
  key_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  amount_cents REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  receipt_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_receipts_key ON receipts(key_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_org ON receipts(org_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  key_id TEXT NOT NULL,
  event TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  spent_cents REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, event, period)
) WITHOUT ROWID;
