-- Budgets can reset each UTC day or month. period_key names the period spent_mc belongs to;
-- the reservation UPDATE starts spend from 0 when the period has changed.
ALTER TABLE agent_keys ADD COLUMN budget_period TEXT NOT NULL DEFAULT 'none'
  CHECK (budget_period IN ('none', 'daily', 'monthly'));
ALTER TABLE agent_keys ADD COLUMN period_key TEXT NOT NULL DEFAULT '';

-- MCP tools an operator adds at run time, next to the built-in tools in src/tools.ts.
-- Rows are disabled, never deleted, so audit rows and receipts keep naming a real tool.
CREATE TABLE IF NOT EXISTS custom_tools (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  upstream TEXT NOT NULL,
  mcp_url TEXT NOT NULL,
  upstream_tool TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  cost_mc INTEGER NOT NULL CHECK (cost_mc >= 0),
  price_mc INTEGER NOT NULL CHECK (price_mc >= 0),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 60000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Counters that are not per agent key, such as sandbox keys minted per UTC day.
CREATE TABLE IF NOT EXISTS desk_counters (
  name TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (name, period)
) WITHOUT ROWID;
