import type {
  AgentKey,
  AuditLog,
  BudgetPeriod,
  ClearingStatus,
  Millicents,
  Organization,
  Protocol,
  Receipt,
  ReceiptPayload,
  UsageEvent,
} from './types.ts';
import {
  canonicalReceiptPayload,
  generateAgentKeyCredentials,
  randomHex,
  sha256Hex,
  signReceiptPayload,
} from './crypto.ts';
import { periodKey } from './budget-period.ts';

export async function getAgentKeyByRawKey(db: D1Database, rawKey: string): Promise<AgentKey | null> {
  const hash = await sha256Hex(rawKey.trim());
  return db.prepare('SELECT * FROM agent_keys WHERE key_hash = ?').bind(hash).first<AgentKey>();
}

export async function getAgentKeyById(db: D1Database, keyId: string): Promise<AgentKey | null> {
  return db.prepare('SELECT * FROM agent_keys WHERE key_id = ?').bind(keyId).first<AgentKey>();
}

export async function createOrganization(db: D1Database, name: string, email: string): Promise<Organization> {
  const org: Organization = { id: `org_${randomHex(8)}`, name, email, created_at: Date.now() };
  await db
    .prepare('INSERT INTO organizations (id, name, email, created_at) VALUES (?, ?, ?, ?)')
    .bind(org.id, org.name, org.email, org.created_at)
    .run();
  return org;
}

export async function getOrganization(db: D1Database, id: string): Promise<Organization | null> {
  return db.prepare('SELECT * FROM organizations WHERE id = ?').bind(id).first<Organization>();
}

export async function listOrganizations(db: D1Database): Promise<Organization[]> {
  const res = await db.prepare('SELECT * FROM organizations ORDER BY created_at DESC').all<Organization>();
  return res.results;
}

export interface NewAgentKey {
  orgId: string;
  name: string;
  budgetMc: Millicents;
  allowlist: string[];
  priceOverrides?: Record<string, Millicents>;
  expiresAt?: number | null;
  budgetPeriod?: BudgetPeriod;
}

export async function createAgentKey(
  db: D1Database,
  params: NewAgentKey
): Promise<{ rawKey: string; key: AgentKey }> {
  const creds = await generateAgentKeyCredentials();
  const now = Date.now();
  const key: AgentKey = {
    key_hash: creds.keyHash,
    key_id: `key_${randomHex(8)}`,
    key_prefix: creds.keyPrefix,
    org_id: params.orgId,
    name: params.name,
    budget_mc: params.budgetMc,
    spent_mc: 0,
    budget_period: params.budgetPeriod ?? 'none',
    period_key: periodKey(params.budgetPeriod ?? 'none', now),
    allowlist: JSON.stringify(params.allowlist),
    price_overrides: JSON.stringify(params.priceOverrides ?? {}),
    status: 'active',
    expires_at: params.expiresAt ?? null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO agent_keys (key_hash, key_id, key_prefix, org_id, name, budget_mc, spent_mc,
        budget_period, period_key, allowlist, price_overrides, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .bind(
      key.key_hash,
      key.key_id,
      key.key_prefix,
      key.org_id,
      key.name,
      key.budget_mc,
      key.budget_period,
      key.period_key,
      key.allowlist,
      key.price_overrides,
      key.expires_at,
      now,
      now
    )
    .run();
  return { rawKey: creds.rawKey, key };
}

/** New secret for the same key_id: budget, spend, allowlist and ledger history stay. */
export async function rotateAgentKey(db: D1Database, keyId: string): Promise<{ rawKey: string; key: AgentKey } | null> {
  const creds = await generateAgentKeyCredentials();
  const res = await db
    .prepare(`UPDATE agent_keys SET key_hash = ?, key_prefix = ?, updated_at = ? WHERE key_id = ? AND status = 'active'`)
    .bind(creds.keyHash, creds.keyPrefix, Date.now(), keyId)
    .run();
  if (res.meta.changes !== 1) return null;
  const key = await getAgentKeyById(db, keyId);
  return key ? { rawKey: creds.rawKey, key } : null;
}

export async function revokeAgentKey(db: D1Database, keyId: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE agent_keys SET status = 'revoked', updated_at = ? WHERE key_id = ?`)
    .bind(Date.now(), keyId)
    .run();
  return res.meta.changes === 1;
}

/** Set a new budget; refused (null) when it would sit below what is already spent. */
export async function updateAgentBudget(db: D1Database, keyId: string, budgetMc: Millicents): Promise<AgentKey | null> {
  const res = await db
    .prepare('UPDATE agent_keys SET budget_mc = ?, updated_at = ? WHERE key_id = ? AND spent_mc <= ?')
    .bind(budgetMc, Date.now(), keyId, budgetMc)
    .run();
  return res.meta.changes === 1 ? getAgentKeyById(db, keyId) : null;
}

export async function listAgentKeys(db: D1Database, limit = 100): Promise<AgentKey[]> {
  const res = await db
    .prepare('SELECT * FROM agent_keys ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<AgentKey>();
  return res.results;
}

/**
 * Take one of `limit` slots for the current UTC day in a single statement, so parallel
 * callers can never take more than `limit`. Returns the slot number, or null when the day is full.
 */
export async function claimDailySlot(db: D1Database, name: string, limit: number, now: number): Promise<number | null> {
  return claimCounterSlot(db, name, new Date(now).toISOString().slice(0, 10), limit);
}

async function claimCounterSlot(db: D1Database, name: string, period: string, limit: number): Promise<number | null> {
  if (limit <= 0) return null;
  const row = await db
    .prepare(
      `INSERT INTO desk_counters (name, period, count) VALUES (?1, ?2, 1)
       ON CONFLICT(name, period) DO UPDATE SET count = count + 1 WHERE count < ?3
       RETURNING count`
    )
    .bind(name, period, limit)
    .first<{ count: number }>();
  return row?.count ?? null;
}

const utcHour = (now: number) => new Date(now).toISOString().slice(0, 13);

/** Failed (refunded) upstream calls of one key in the current UTC hour. */
export async function failedCallsThisHour(db: D1Database, keyId: string, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM desk_counters WHERE name = ? AND period = ?')
    .bind(`failed:${keyId}`, utcHour(now))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countFailedCall(db: D1Database, keyId: string, now: number): Promise<void> {
  await claimCounterSlot(db, `failed:${keyId}`, utcHour(now), Number.MAX_SAFE_INTEGER);
}

/** The period a key's spend counts toward, chosen in SQL from the key's own budget_period. */
const PERIOD_SQL = "(CASE budget_period WHEN 'daily' THEN ?4 WHEN 'monthly' THEN ?5 ELSE '' END)";
/** Spend in the current period: spend stored under an earlier period counts as 0. */
const CURRENT_SPEND_SQL = `(CASE WHEN period_key = ${PERIOD_SQL} THEN spent_mc ELSE 0 END)`;

/**
 * Reserve the call price before the upstream runs. One conditional UPDATE is the
 * whole budget gate: D1 runs it atomically, so N parallel calls on a key with room
 * for one see exactly one change and N-1 refusals. The same statement starts a new
 * day or month from 0 for keys with a budget period. Zero-price calls skip it.
 */
export async function reserveBudget(db: D1Database, keyId: string, priceMc: Millicents, now: number): Promise<boolean> {
  if (priceMc === 0) return true;
  const res = await db
    .prepare(
      `UPDATE agent_keys SET spent_mc = ${CURRENT_SPEND_SQL} + ?1, period_key = ${PERIOD_SQL}, updated_at = ?2
       WHERE key_id = ?3 AND status = 'active' AND (expires_at IS NULL OR expires_at > ?2)
         AND ${CURRENT_SPEND_SQL} + ?1 <= budget_mc`
    )
    .bind(priceMc, now, keyId, periodKey('daily', now), periodKey('monthly', now))
    .run();
  return res.meta.changes === 1;
}

function utcPeriod(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface LedgerEntry {
  key: AgentKey;
  toolName: string;
  upstream: string;
  protocol: Protocol;
  status: ClearingStatus;
  statusCode: number;
  paramsSummary: string;
  paramsSha256: string;
  resultSha256: string | null;
  errorDetail: string | null;
  costMc: Millicents;
  priceMc: Millicents;
  /** Amount reserved by reserveBudget that must be handed back (upstream failed). */
  refundMc: Millicents;
  /** The budget period the reservation was taken in (see periodKey); a refund only goes back to it. */
  reservedPeriod: string;
  latencyMs: number;
  signingKey: string;
}

/**
 * Write one ledger entry in a single D1 batch: audit row, signed receipt, usage
 * counter on success, and the refund of the reservation on failure.
 */
export async function recordLedgerEntry(db: D1Database, e: LedgerEntry): Promise<{ auditLog: AuditLog; receipt: Receipt }> {
  const now = Date.now();
  const suffix = randomHex(12);
  const billed = e.status === 'success';
  const priceMc = billed ? e.priceMc : 0;
  const costMc = billed ? e.costMc : 0;
  const auditLog: AuditLog = {
    id: `aud_${suffix}`,
    org_id: e.key.org_id,
    key_id: e.key.key_id,
    tool_name: e.toolName,
    upstream: e.upstream,
    protocol: e.protocol,
    status: e.status,
    status_code: e.statusCode,
    params_summary: e.paramsSummary,
    params_sha256: e.paramsSha256,
    result_sha256: e.resultSha256,
    error_detail: e.errorDetail,
    cost_mc: costMc,
    price_mc: priceMc,
    margin_mc: priceMc - costMc,
    latency_ms: e.latencyMs,
    created_at: now,
  };
  const payload: ReceiptPayload = {
    v: 'cd-receipt-v4',
    receipt_id: `rcpt_${suffix}`,
    audit_log_id: auditLog.id,
    org_id: auditLog.org_id,
    key_id: auditLog.key_id,
    tool: e.toolName,
    upstream: e.upstream,
    protocol: e.protocol,
    outcome: e.status,
    http_status: e.statusCode,
    amount_mc: priceMc,
    cost_mc: costMc,
    currency: 'USD',
    params_sha256: e.paramsSha256,
    result_sha256: e.resultSha256,
    issued_at: now,
  };
  const payloadText = canonicalReceiptPayload(payload);
  const { signature, kid } = await signReceiptPayload(e.signingKey, payloadText);
  const receipt: Receipt = {
    id: payload.receipt_id,
    audit_log_id: auditLog.id,
    key_id: auditLog.key_id,
    org_id: auditLog.org_id,
    tool_name: e.toolName,
    amount_mc: priceMc,
    payload: payloadText,
    signature,
    key_fingerprint: kid,
    issued_at: now,
  };

  const statements = [
    db
      .prepare(
        `INSERT INTO audit_logs (id, org_id, key_id, tool_name, upstream, protocol, status, status_code,
          params_summary, params_sha256, result_sha256, error_detail, cost_mc, price_mc, margin_mc, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        auditLog.id,
        auditLog.org_id,
        auditLog.key_id,
        auditLog.tool_name,
        auditLog.upstream,
        auditLog.protocol,
        auditLog.status,
        auditLog.status_code,
        auditLog.params_summary,
        auditLog.params_sha256,
        auditLog.result_sha256,
        auditLog.error_detail,
        auditLog.cost_mc,
        auditLog.price_mc,
        auditLog.margin_mc,
        auditLog.latency_ms,
        auditLog.created_at
      ),
    db
      .prepare(
        `INSERT INTO receipts (id, audit_log_id, key_id, org_id, tool_name, amount_mc, payload, signature, key_fingerprint, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        receipt.id,
        receipt.audit_log_id,
        receipt.key_id,
        receipt.org_id,
        receipt.tool_name,
        receipt.amount_mc,
        receipt.payload,
        receipt.signature,
        receipt.key_fingerprint,
        receipt.issued_at
      ),
  ];
  if (e.refundMc > 0) {
    // A refund that lands after a daily or monthly reset belongs to the old period, which
    // no longer counts; returning it to the new period would let that period overspend.
    statements.push(
      db
        .prepare('UPDATE agent_keys SET spent_mc = MAX(0, spent_mc - ?), updated_at = ? WHERE key_id = ? AND period_key = ?')
        .bind(e.refundMc, now, e.key.key_id, e.reservedPeriod)
    );
  }
  if (billed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO usage_events (key_id, event, period, count, spent_mc) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(key_id, event, period) DO UPDATE SET count = count + 1, spent_mc = spent_mc + excluded.spent_mc`
        )
        .bind(e.key.key_id, e.toolName, utcPeriod(now), priceMc)
    );
  }
  await db.batch(statements);
  return { auditLog, receipt };
}

export async function getReceiptById(db: D1Database, receiptId: string): Promise<Receipt | null> {
  return db.prepare('SELECT * FROM receipts WHERE id = ?').bind(receiptId).first<Receipt>();
}

export async function listReceipts(db: D1Database, filter: { keyId?: string }, limit = 50): Promise<Receipt[]> {
  const res = filter.keyId
    ? await db
        .prepare('SELECT * FROM receipts WHERE key_id = ? ORDER BY issued_at DESC LIMIT ?')
        .bind(filter.keyId, limit)
        .all<Receipt>()
    : await db.prepare('SELECT * FROM receipts ORDER BY issued_at DESC LIMIT ?').bind(limit).all<Receipt>();
  return res.results;
}

export async function listAuditLogs(db: D1Database, filter: { keyId?: string }, limit = 50): Promise<AuditLog[]> {
  const res = filter.keyId
    ? await db
        .prepare('SELECT * FROM audit_logs WHERE key_id = ? ORDER BY created_at DESC LIMIT ?')
        .bind(filter.keyId, limit)
        .all<AuditLog>()
    : await db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').bind(limit).all<AuditLog>();
  return res.results;
}

export async function getUsageEvents(db: D1Database, keyId: string, period: string): Promise<UsageEvent[]> {
  const res = await db
    .prepare('SELECT * FROM usage_events WHERE key_id = ? AND period = ? ORDER BY event')
    .bind(keyId, period)
    .all<UsageEvent>();
  return res.results;
}

export function currentPeriod(): string {
  return utcPeriod(Date.now());
}

export interface OverviewStats {
  orgs: number;
  activeKeys: number;
  budgetMc: Millicents;
  spentMc: Millicents;
  receipts: number;
  costMc: Millicents;
  marginMc: Millicents;
  refusals: number;
  upstreamErrors: number;
}

export async function getOverviewStats(db: D1Database): Promise<OverviewStats> {
  const [orgs, keys, ledger] = await db.batch<Record<string, number>>([
    db.prepare('SELECT COUNT(*) AS n FROM organizations'),
    db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(budget_mc), 0) AS budget, COALESCE(SUM(spent_mc), 0) AS spent
       FROM agent_keys WHERE status = 'active'`
    ),
    db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_mc), 0) AS cost, COALESCE(SUM(margin_mc), 0) AS margin,
        COALESCE(SUM(status IN ('refused_allowlist', 'refused_budget')), 0) AS refusals,
        COALESCE(SUM(status = 'upstream_error'), 0) AS errors
       FROM audit_logs`
    ),
  ]);
  const k = keys.results[0];
  const l = ledger.results[0];
  return {
    orgs: orgs.results[0].n,
    activeKeys: k.n,
    budgetMc: k.budget,
    spentMc: k.spent,
    receipts: l.n,
    costMc: l.cost,
    marginMc: l.margin,
    refusals: l.refusals,
    upstreamErrors: l.errors,
  };
}
