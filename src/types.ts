export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  OPENKRILL_BASE_URL?: string;
  /** A static OpenKrill API key; when set it is used instead of the Connect token. */
  OPENKRILL_API_KEY?: string;
  /** OpenKrill Connect OAuth client the desk refreshes its access token with. */
  OPENKRILL_CLIENT_ID?: string;
  /** Seeds the first Connect refresh; later refresh tokens rotate in D1. */
  OPENKRILL_REFRESH_TOKEN?: string;
  /** Bearer token for every /api/admin/* route. Unset means the admin plane is closed. */
  ADMIN_SECRET?: string;
  /** Ed25519 private key as a JWK JSON string; its public half is served for offline checks. */
  RECEIPT_SIGNING_KEY: string;
  /** How many public sandbox keys may be minted per UTC day. */
  DEMO_DAILY_KEY_LIMIT?: string;
  /** Failed (refunded) upstream calls one key may make per UTC hour; default 20. */
  FAILED_CALLS_PER_HOUR?: string;
  /** 32 random bytes in base64; seals upstream credentials operators add at run time. */
  UPSTREAM_SECRET_KEY?: string;
}

/**
 * Money is stored and computed as integer millicents (1/1000 of a US cent),
 * so sub-cent tool prices never pass through floating point.
 */
export type Millicents = number;

export interface Organization {
  id: string;
  name: string;
  email: string;
  created_at: number;
}

export type BudgetPeriod = 'none' | 'daily' | 'monthly';

export interface AgentKey {
  key_hash: string;
  key_id: string;
  key_prefix: string;
  org_id: string;
  name: string;
  budget_mc: Millicents;
  spent_mc: Millicents;
  /** When spend starts again from 0: never, each UTC day, or each UTC month. */
  budget_period: BudgetPeriod;
  /** The day or month spent_mc belongs to ('' when budget_period is none). */
  period_key: string;
  allowlist: string; // JSON string array of desk tool names, or ["*"] for every governed tool
  price_overrides: string; // JSON object: desk tool name -> price in millicents
  status: 'active' | 'revoked';
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export type Protocol = 'http' | 'mcp';

export type ClearingStatus =
  | 'success'
  | 'refused_allowlist'
  | 'refused_budget'
  | 'upstream_error';

export interface AuditLog {
  id: string;
  org_id: string;
  key_id: string;
  tool_name: string;
  upstream: string;
  protocol: Protocol;
  status: ClearingStatus;
  status_code: number;
  params_summary: string;
  params_sha256: string;
  result_sha256: string | null;
  error_detail: string | null;
  cost_mc: Millicents;
  price_mc: Millicents;
  margin_mc: Millicents;
  latency_ms: number;
  created_at: number;
}

/** The exact fields a receipt signs, in signing order. */
export interface ReceiptPayload {
  /** v4: params_sha256 and result_sha256 are SHA-256 over canonical JSON (sorted keys). */
  v: 'cd-receipt-v4';
  receipt_id: string;
  audit_log_id: string;
  org_id: string;
  key_id: string;
  tool: string;
  upstream: string;
  protocol: Protocol;
  outcome: ClearingStatus;
  http_status: number;
  amount_mc: Millicents;
  cost_mc: Millicents;
  currency: 'USD';
  params_sha256: string;
  result_sha256: string | null;
  issued_at: number;
}

export interface Receipt {
  id: string;
  audit_log_id: string;
  key_id: string;
  org_id: string;
  tool_name: string;
  amount_mc: Millicents;
  /** Canonical JSON of ReceiptPayload; the signature covers these exact bytes. */
  payload: string;
  /** Base64url Ed25519 signature over payload. */
  signature: string;
  key_fingerprint: string;
  issued_at: number;
}

export interface UsageEvent {
  key_id: string;
  event: string;
  period: string;
  count: number;
  spent_mc: Millicents;
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
  title?: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type ClearingErrorCode =
  | 'budget_exceeded'
  | 'tool_not_allowed'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'upstream_error'
  | 'key_revoked'
  | 'key_expired'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'too_many_failed_calls'
  | 'admin_disabled'
  | 'internal_error';

export interface ClearingError {
  error: {
    code: ClearingErrorCode;
    message: string;
    [key: string]: unknown;
  };
}
