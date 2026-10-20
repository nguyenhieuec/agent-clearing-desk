export interface Env {
  DB: D1Database;
  OPENKRILL_BASE_URL?: string;
  OPENKRILL_API_KEY?: string;
  DEFAULT_PRICE_CENTS?: string;
  ADMIN_SECRET?: string;
  RECEIPT_SIGNING_KEY: string;
}

export interface Organization {
  id: string;
  name: string;
  email: string;
  created_at: number;
}

export interface AgentKey {
  key_hash: string;
  key_id: string;
  key_prefix: string;
  org_id: string;
  name: string;
  budget_cents: number;
  spent_cents: number;
  allowlist: string; // JSON string array
  per_call_price_cents: number;
  tool_pricing_overrides: string; // JSON string object
  status: 'active' | 'revoked';
  created_at: number;
  updated_at: number;
}

export interface AuditLog {
  id: string;
  org_id: string;
  key_id: string;
  tool_name: string;
  protocol: 'http' | 'mcp';
  request_method: string;
  status: 'success' | 'refused_budget' | 'refused_allowlist' | 'error';
  status_code: number;
  params_summary: string | null;
  cost_cents: number;
  price_cents: number;
  margin_cents: number;
  created_at: number;
}

export interface Receipt {
  id: string;
  audit_log_id: string;
  key_id: string;
  org_id: string;
  tool_name: string;
  amount_cents: number;
  currency: string;
  receipt_hash: string;
  issued_at: number;
}

export interface UsageEvent {
  key_id: string;
  event: string;
  period: string;
  count: number;
  spent_cents: number;
}

export interface UsageSummaryItem {
  event: string;
  count: number;
  spent_cents: number;
  price_per_event_cents: number;
}

export interface UsageSummary {
  period: string;
  key_id: string;
  budget_cents: number;
  spent_cents: number;
  remaining_budget_cents: number;
  items: UsageSummaryItem[];
  usage: Record<string, number>;
  total_events: number;
  upstream_openkrill_usage?: Record<string, number> | null;
}

export interface ToolPricing {
  toolName: string;
  costCents: number;
  priceCents: number;
  marginCents: number;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface StructuredClearingError {
  error: {
    code:
      | 'budget_exceeded'
      | 'tool_not_allowed'
      | 'key_revoked'
      | 'unauthorized'
      | 'not_found'
      | 'bad_request'
      | 'internal_error';
    message: string;
    key_id?: string;
    tool_name?: string;
    budget_cents?: number;
    spent_cents?: number;
    call_price_cents?: number;
    receipt_id?: string;
  };
}
