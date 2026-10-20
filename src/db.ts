import type {
  AgentKey,
  AuditLog,
  Organization,
  Receipt,
  UsageEvent,
  UsageSummary,
  UsageSummaryItem,
} from './types.ts';
import {
  computeReceiptHash,
  generateAgentKeyCredentials,
  generateOrgId,
  randomHex,
  sha256Hex,
} from './crypto.ts';

function numOrZero(val: number | null | undefined): number {
  return val ?? 0;
}

/**
 * Find agent key by raw key string (hashes raw key to look up in DB).
 */
export async function getAgentKeyByRawKey(
  db: D1Database,
  rawKey: string
): Promise<AgentKey | null> {
  const hash = await sha256Hex(rawKey.trim());
  const res = await db
    .prepare('SELECT * FROM agent_keys WHERE key_hash = ? LIMIT 1')
    .bind(hash)
    .first<AgentKey>();
  return res ?? null;
}

/**
 * Find agent key by key_id.
 */
export async function getAgentKeyById(
  db: D1Database,
  keyId: string
): Promise<AgentKey | null> {
  const res = await db
    .prepare('SELECT * FROM agent_keys WHERE key_id = ? LIMIT 1')
    .bind(keyId)
    .first<AgentKey>();
  return res ?? null;
}

/**
 * Create a new organization.
 */
export async function createOrganization(
  db: D1Database,
  name: string,
  email: string
): Promise<Organization> {
  const id = generateOrgId();
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO organizations (id, name, email, created_at) VALUES (?, ?, ?, ?)'
    )
    .bind(id, name, email, now)
    .run();
  return { id, name, email, created_at: now };
}

/**
 * List all organizations.
 */
export async function listOrganizations(db: D1Database): Promise<Organization[]> {
  const res = await db
    .prepare('SELECT * FROM organizations ORDER BY created_at DESC')
    .all<Organization>();
  return res.results ?? [];
}

/**
 * Create a new agent key for an organization.
 */
export async function createAgentKey(
  db: D1Database,
  params: {
    orgId: string;
    name: string;
    budgetCents: number;
    allowlist?: string[];
    perCallPriceCents?: number;
    toolPricingOverrides?: Record<string, number>;
  }
): Promise<{ rawKey: string; key: AgentKey }> {
  const creds = await generateAgentKeyCredentials();
  const now = Date.now();
  const allowlistJson = JSON.stringify(params.allowlist ?? ['*']);
  const overridesJson = JSON.stringify(params.toolPricingOverrides ?? {});
  const perCallPrice = params.perCallPriceCents ?? 5;

  await db
    .prepare(
      `INSERT INTO agent_keys (
        key_hash, key_id, key_prefix, org_id, name,
        budget_cents, spent_cents, allowlist, per_call_price_cents,
        tool_pricing_overrides, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?)`
    )
    .bind(
      creds.keyHash,
      creds.keyId,
      creds.keyPrefix,
      params.orgId,
      params.name,
      params.budgetCents,
      allowlistJson,
      perCallPrice,
      overridesJson,
      now,
      now
    )
    .run();

  const key: AgentKey = {
    key_hash: creds.keyHash,
    key_id: creds.keyId,
    key_prefix: creds.keyPrefix,
    org_id: params.orgId,
    name: params.name,
    budget_cents: params.budgetCents,
    spent_cents: 0,
    allowlist: allowlistJson,
    per_call_price_cents: perCallPrice,
    tool_pricing_overrides: overridesJson,
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  return { rawKey: creds.rawKey, key };
}

/**
 * Rotate an existing agent key.
 * Preserves key_id, budget, spent, allowlist, and organization,
 * while updating the key hash and prefix to the newly generated credentials.
 */
export async function rotateAgentKey(
  db: D1Database,
  keyId: string
): Promise<{ rawKey: string; key: AgentKey }> {
  const existing = await getAgentKeyById(db, keyId);
  if (!existing) {
    throw new Error(`Agent key ${keyId} not found`);
  }

  const creds = await generateAgentKeyCredentials();
  const now = Date.now();

  await db
    .prepare(
      `UPDATE agent_keys
       SET key_hash = ?, key_prefix = ?, updated_at = ?
       WHERE key_id = ?`
    )
    .bind(creds.keyHash, creds.keyPrefix, now, keyId)
    .run();

  const updated: AgentKey = {
    ...existing,
    key_hash: creds.keyHash,
    key_prefix: creds.keyPrefix,
    updated_at: now,
  };

  return { rawKey: creds.rawKey, key: updated };
}

/**
 * Revoke an agent key.
 */
export async function revokeAgentKey(db: D1Database, keyId: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare('UPDATE agent_keys SET status = ?, updated_at = ? WHERE key_id = ?')
    .bind('revoked', now, keyId)
    .run();
}

/**
 * Update budget on an agent key.
 */
export async function updateAgentBudget(
  db: D1Database,
  keyId: string,
  newBudgetCents: number
): Promise<AgentKey> {
  const now = Date.now();
  await db
    .prepare('UPDATE agent_keys SET budget_cents = ?, updated_at = ? WHERE key_id = ?')
    .bind(newBudgetCents, now, keyId)
    .run();
  const key = await getAgentKeyById(db, keyId);
  if (!key) throw new Error('Key not found');
  return key;
}

/**
 * List all agent keys, optionally filtered by org.
 */
export async function listAgentKeys(
  db: D1Database,
  orgId?: string
): Promise<AgentKey[]> {
  if (orgId) {
    const res = await db
      .prepare('SELECT * FROM agent_keys WHERE org_id = ? ORDER BY created_at DESC')
      .bind(orgId)
      .all<AgentKey>();
    return res.results ?? [];
  }
  const res = await db
    .prepare('SELECT * FROM agent_keys ORDER BY created_at DESC')
    .all<AgentKey>();
  return res.results ?? [];
}

function currentUtcPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Atomically record clearing transaction in D1:
 * - Insert audit_logs row
 * - Insert receipts row (sharing the 12-byte transaction suffix so aud_<hex> <-> rcpt_<hex>)
 * - Update key spent_cents (if billable)
 * - Update usage_events row (if billable)
 * Executed in a single batch to conserve D1 write quota.
 */
export async function recordClearingTransaction(
  db: D1Database,
  params: {
    key: AgentKey;
    toolName: string;
    protocol: 'http' | 'mcp';
    requestMethod: string;
    status: 'success' | 'refused_budget' | 'refused_allowlist' | 'error';
    statusCode: number;
    paramsSummary?: string;
    costCents: number;
    priceCents: number;
    marginCents: number;
  }
): Promise<{ auditLog: AuditLog; receipt: Receipt }> {
  const now = Date.now();
  const txSuffix = randomHex(12);
  const auditId = `aud_${txSuffix}`;
  const receiptId = `rcpt_${txSuffix}`;
  const isBillable = params.status === 'success';
  const billableAmount = isBillable ? params.priceCents : 0;

  const receiptHash = await computeReceiptHash({
    receiptId,
    auditLogId: auditId,
    keyId: params.key.key_id,
    orgId: params.key.org_id,
    toolName: params.toolName,
    amountCents: billableAmount,
    currency: 'USD',
    issuedAt: now,
  });

  const auditLog: AuditLog = {
    id: auditId,
    org_id: params.key.org_id,
    key_id: params.key.key_id,
    tool_name: params.toolName,
    protocol: params.protocol,
    request_method: params.requestMethod,
    status: params.status,
    status_code: params.statusCode,
    params_summary: params.paramsSummary ?? null,
    cost_cents: isBillable ? params.costCents : 0,
    price_cents: billableAmount,
    margin_cents: isBillable ? params.marginCents : 0,
    created_at: now,
  };

  const receipt: Receipt = {
    id: receiptId,
    audit_log_id: auditId,
    key_id: params.key.key_id,
    org_id: params.key.org_id,
    tool_name: params.toolName,
    amount_cents: billableAmount,
    currency: 'USD',
    receipt_hash: receiptHash,
    issued_at: now,
  };

  const period = currentUtcPeriod(now);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO audit_logs (
          id, org_id, key_id, tool_name, protocol, request_method,
          status, status_code, params_summary, cost_cents, price_cents, margin_cents, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditLog.id,
        auditLog.org_id,
        auditLog.key_id,
        auditLog.tool_name,
        auditLog.protocol,
        auditLog.request_method,
        auditLog.status,
        auditLog.status_code,
        auditLog.params_summary,
        auditLog.cost_cents,
        auditLog.price_cents,
        auditLog.margin_cents,
        auditLog.created_at
      ),
    db
      .prepare(
        `INSERT INTO receipts (
          id, audit_log_id, key_id, org_id, tool_name, amount_cents, currency, receipt_hash, issued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        receipt.id,
        receipt.audit_log_id,
        receipt.key_id,
        receipt.org_id,
        receipt.tool_name,
        receipt.amount_cents,
        receipt.currency,
        receipt.receipt_hash,
        receipt.issued_at
      ),
  ];

  if (billableAmount > 0) {
    statements.push(
      db
        .prepare(
          'UPDATE agent_keys SET spent_cents = spent_cents + ?, updated_at = ? WHERE key_id = ?'
        )
        .bind(billableAmount, now, params.key.key_id),
      db
        .prepare(
          `INSERT INTO usage_events (key_id, event, period, count, spent_cents)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(key_id, event, period) DO UPDATE SET
             count = count + 1,
             spent_cents = spent_cents + excluded.spent_cents`
        )
        .bind(params.key.key_id, params.toolName, period, billableAmount)
    );
  }

  await db.batch(statements);
  return { auditLog, receipt };
}

/**
 * Retrieve receipt by ID.
 */
export async function getReceiptById(
  db: D1Database,
  receiptId: string
): Promise<Receipt | null> {
  const res = await db
    .prepare('SELECT * FROM receipts WHERE id = ? LIMIT 1')
    .bind(receiptId)
    .first<Receipt>();
  return res ?? null;
}

/**
 * List recent receipts.
 */
export async function listReceipts(
  db: D1Database,
  keyId?: string,
  limit = 50
): Promise<Receipt[]> {
  if (keyId) {
    const res = await db
      .prepare('SELECT * FROM receipts WHERE key_id = ? ORDER BY issued_at DESC LIMIT ?')
      .bind(keyId, limit)
      .all<Receipt>();
    return res.results ?? [];
  }
  const res = await db
    .prepare('SELECT * FROM receipts ORDER BY issued_at DESC LIMIT ?')
    .bind(limit)
    .all<Receipt>();
  return res.results ?? [];
}

/**
 * List recent audit logs.
 */
export async function listAuditLogs(
  db: D1Database,
  keyId?: string,
  limit = 50
): Promise<AuditLog[]> {
  if (keyId) {
    const res = await db
      .prepare('SELECT * FROM audit_logs WHERE key_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(keyId, limit)
      .all<AuditLog>();
    return res.results ?? [];
  }
  const res = await db
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all<AuditLog>();
  return res.results ?? [];
}

function toUsageSummaryItem(e: UsageEvent): UsageSummaryItem {
  return {
    event: e.event,
    count: e.count,
    spent_cents: e.spent_cents,
    price_per_event_cents:
      e.count > 0 ? Math.round((e.spent_cents / e.count) * 100) / 100 : 0,
  };
}

/**
 * Get usage summary matching openkrill /v1/usage contract for an agent key.
 */
export async function getUsage(
  db: D1Database,
  keyId: string,
  period?: string
): Promise<UsageSummary> {
  const key = await getAgentKeyById(db, keyId);
  if (!key) {
    throw new Error(`Key ${keyId} not found`);
  }

  const selectedPeriod = period || currentUtcPeriod(Date.now());
  const events = await db
    .prepare(
      'SELECT * FROM usage_events WHERE key_id = ? AND period = ? ORDER BY event ASC'
    )
    .bind(keyId, selectedPeriod)
    .all<UsageEvent>();

  const rows = events.results ?? [];
  const items = rows.map(toUsageSummaryItem);
  const usage: Record<string, number> = {};
  let totalEvents = 0;
  for (const item of items) {
    usage[item.event] = item.count;
    totalEvents += item.count;
  }

  return {
    period: selectedPeriod,
    key_id: keyId,
    budget_cents: key.budget_cents,
    spent_cents: key.spent_cents,
    remaining_budget_cents: Math.max(0, key.budget_cents - key.spent_cents),
    items,
    usage,
    total_events: totalEvents,
  };
}

/**
 * Aggregate overview statistics for the admin dashboard.
 */
export async function getOverviewStats(db: D1Database): Promise<{
  totalOrgs: number;
  totalKeys: number;
  totalBudgetCents: number;
  totalSpentCents: number;
  totalReceipts: number;
  totalMarginCents: number;
}> {
  const orgCount = await db
    .prepare('SELECT COUNT(*) as count FROM organizations')
    .first<{ count: number }>();

  const keyStats = await db
    .prepare(
      `SELECT
        COUNT(*) as count,
        COALESCE(SUM(budget_cents), 0) as total_budget,
        COALESCE(SUM(spent_cents), 0) as total_spent
       FROM agent_keys WHERE status = 'active'`
    )
    .first<{ count: number; total_budget: number; total_spent: number }>();

  const receiptStats = await db
    .prepare('SELECT COUNT(*) as count FROM receipts')
    .first<{ count: number }>();

  const marginStats = await db
    .prepare('SELECT COALESCE(SUM(margin_cents), 0) as total_margin FROM audit_logs')
    .first<{ total_margin: number }>();

  return {
    totalOrgs: numOrZero(orgCount?.count),
    totalKeys: numOrZero(keyStats?.count),
    totalBudgetCents: numOrZero(keyStats?.total_budget),
    totalSpentCents: numOrZero(keyStats?.total_spent),
    totalReceipts: numOrZero(receiptStats?.count),
    totalMarginCents: numOrZero(marginStats?.total_margin),
  };
}
