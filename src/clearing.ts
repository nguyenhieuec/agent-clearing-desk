import type { AgentKey, BudgetPeriod, ClearingError, Env, Millicents, Protocol, Receipt } from './types.ts';
import { currentSpend, periodKey, periodResetsAt } from './budget-period.ts';
import type { GovernedTool } from './tools.ts';
import { findTool } from './tool-registry.ts';
import { countFailedCall, failedCallsThisHour, getAgentKeyById, getAgentKeyByRawKey, recordLedgerEntry, reserveBudget } from './db.ts';
import { executeUpstreamTool } from './upstream.ts';
import { canonicalJson, sha256Hex } from './crypto.ts';
import { validateArguments } from './json-schema.ts';
import { mcToCents, mcToUsd } from './money.ts';

export type AuthResult = { ok: true; key: AgentKey } | { ok: false; status: number; error: ClearingError };

function fail(code: ClearingError['error']['code'], message: string, extra: Record<string, unknown> = {}): ClearingError {
  return { error: { code, message, ...extra } };
}

function keyUnusable(key: AgentKey, now: number): AuthResult | null {
  if (key.status === 'revoked') {
    return { ok: false, status: 403, error: fail('key_revoked', 'Agent key has been revoked', { key_id: key.key_id }) };
  }
  if (key.expires_at !== null && key.expires_at <= now) {
    return { ok: false, status: 403, error: fail('key_expired', 'Agent key has expired', { key_id: key.key_id }) };
  }
  return null;
}

export async function authenticateAgent(db: D1Database, rawKey: string | null): Promise<AuthResult> {
  if (!rawKey) {
    return {
      ok: false,
      status: 401,
      error: fail('unauthorized', 'Missing agent key. Send x-api-key or Authorization: Bearer <cd_live_...>'),
    };
  }
  const key = await getAgentKeyByRawKey(db, rawKey);
  if (!key) return { ok: false, status: 401, error: fail('unauthorized', 'Invalid agent key') };
  return keyUnusable(key, Date.now()) ?? { ok: true, key };
}

export function parseAllowlist(key: AgentKey): string[] {
  return JSON.parse(key.allowlist) as string[];
}

export function isToolAllowed(key: AgentKey, toolName: string): boolean {
  const list = parseAllowlist(key);
  return list.includes('*') || list.includes(toolName);
}

export function priceFor(key: AgentKey, tool: GovernedTool): Millicents {
  const overrides = JSON.parse(key.price_overrides) as Record<string, Millicents>;
  return overrides[tool.name] ?? tool.priceMc;
}

/** Failed upstream calls are refunded, so a key may make only this many per UTC hour. */
const DEFAULT_FAILED_CALLS_PER_HOUR = 20;

function failedCallLimit(env: Env): number {
  const n = Number(env.FAILED_CALLS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FAILED_CALLS_PER_HOUR;
}

/** An upstream 4xx (other than its own auth, timeout and rate limit) means the agent's arguments were wrong. */
function upstreamRejectedArguments(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

/** Money fields every response carries, so an agent can always see where it stands. */
export interface BalanceView {
  key_id: string;
  budget_period: BudgetPeriod;
  /** ISO time the budget starts again from 0, or null when it never resets. */
  resets_at: string | null;
  budget_cents: number;
  spent_cents: number;
  remaining_cents: number;
  remaining_usd: string;
}

export function balanceView(
  key: Pick<AgentKey, 'key_id' | 'budget_mc' | 'spent_mc' | 'budget_period' | 'period_key'>,
  now = Date.now()
): BalanceView {
  const spent = currentSpend(key, now);
  const remaining = Math.max(0, key.budget_mc - spent);
  const resetsAt = periodResetsAt(key.budget_period, now);
  return {
    key_id: key.key_id,
    budget_period: key.budget_period,
    resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    budget_cents: mcToCents(key.budget_mc),
    spent_cents: mcToCents(spent),
    remaining_cents: mcToCents(remaining),
    remaining_usd: mcToUsd(remaining),
  };
}

export type ClearingOutcome =
  | { kind: 'success'; httpStatus: 200; result: unknown; receipt: Receipt; priceMc: Millicents; balance: BalanceView }
  | {
      kind: 'refused' | 'upstream_error';
      httpStatus: number;
      error: ClearingError;
      receipt: Receipt;
      priceMc: Millicents;
      balance: BalanceView;
    }
  | { kind: 'rejected'; httpStatus: number; error: ClearingError };

interface CallContext {
  env: Env;
  key: AgentKey;
  toolName: string;
  args: Record<string, unknown>;
  protocol: Protocol;
}

async function writeLedger(
  ctx: CallContext,
  tool: GovernedTool,
  fields: {
    status: 'success' | 'refused_allowlist' | 'refused_budget' | 'upstream_error';
    statusCode: number;
    priceMc: Millicents;
    refundMc: Millicents;
    resultSha256: string | null;
    errorDetail: string | null;
    latencyMs: number;
    reservedPeriod?: string;
  }
): Promise<Receipt> {
  const paramsJson = canonicalJson(ctx.args);
  const { receipt } = await recordLedgerEntry(ctx.env.DB, {
    key: ctx.key,
    toolName: tool.name,
    upstream: tool.target.upstream,
    protocol: ctx.protocol,
    paramsSummary: paramsJson.slice(0, 500),
    paramsSha256: await sha256Hex(paramsJson),
    costMc: tool.costMc,
    signingKey: ctx.env.RECEIPT_SIGNING_KEY,
    ...fields,
    reservedPeriod: fields.reservedPeriod ?? '',
  });
  return receipt;
}

async function freshBalance(db: D1Database, key: AgentKey): Promise<{ key: AgentKey; balance: BalanceView }> {
  const fresh = (await getAgentKeyById(db, key.key_id)) ?? key;
  return { key: fresh, balance: balanceView(fresh) };
}

async function refuseBudget(ctx: CallContext, tool: GovernedTool, priceMc: Millicents): Promise<ClearingOutcome> {
  const { key, balance } = await freshBalance(ctx.env.DB, ctx.key);
  const unusable = keyUnusable(key, Date.now());
  if (unusable && !unusable.ok) return { kind: 'rejected', httpStatus: unusable.status, error: unusable.error };
  const receipt = await writeLedger(ctx, tool, {
    status: 'refused_budget',
    statusCode: 402,
    priceMc,
    refundMc: 0,
    resultSha256: null,
    errorDetail: null,
    latencyMs: 0,
  });
  const error = fail(
    'budget_exceeded',
    `Budget exceeded: ${balance.remaining_usd} left, ${tool.name} costs ${mcToUsd(priceMc)}. Stop calling paid tools with this key.`,
    { ...balance, tool_name: tool.name, call_price_cents: mcToCents(priceMc), receipt_id: receipt.id }
  );
  return { kind: 'refused', httpStatus: 402, error, receipt, priceMc, balance };
}

async function refundFailure(
  ctx: CallContext,
  tool: GovernedTool,
  priceMc: Millicents,
  reservedPeriod: string,
  upstream: { status: number; message: string },
  latencyMs: number
): Promise<ClearingOutcome> {
  await countFailedCall(ctx.env.DB, ctx.key.key_id, Date.now());
  const receipt = await writeLedger(ctx, tool, {
    status: 'upstream_error',
    statusCode: upstream.status,
    priceMc,
    refundMc: priceMc,
    resultSha256: null,
    errorDetail: upstream.message.slice(0, 500),
    latencyMs,
    reservedPeriod,
  });
  const { balance } = await freshBalance(ctx.env.DB, ctx.key);
  const extra = { tool_name: tool.name, upstream_status: upstream.status, receipt_id: receipt.id };
  // 400: the upstream refused the arguments (fix them, do not retry); 504: too slow; 502: it failed.
  if (upstreamRejectedArguments(upstream.status)) {
    const error = fail('invalid_arguments', `Upstream ${tool.target.upstream} rejected the arguments: ${upstream.message}. Nothing was charged; fix the arguments before calling again.`, extra);
    return { kind: 'upstream_error', httpStatus: 400, error, receipt, priceMc, balance };
  }
  const error = fail('upstream_error', `Upstream ${tool.target.upstream} failed: ${upstream.message}. Nothing was charged.`, extra);
  return { kind: 'upstream_error', httpStatus: upstream.status === 504 ? 504 : 502, error, receipt, priceMc, balance };
}

/**
 * The one path every governed call takes, over REST and MCP alike:
 * known tool -> required arguments -> allowlist -> atomic budget reservation ->
 * upstream -> signed ledger entry (charge on success, refund on failure).
 */
export async function clearToolCall(ctx: CallContext): Promise<ClearingOutcome> {
  const tool = await findTool(ctx.env, ctx.toolName);
  if (!tool) {
    return {
      kind: 'rejected',
      httpStatus: 404,
      error: fail('unknown_tool', `Unknown tool '${ctx.toolName}'. List tools at GET /v1/tools or MCP tools/list.`),
    };
  }
  const problems = validateArguments(tool.inputSchema, ctx.args);
  if (problems.length > 0) {
    return {
      kind: 'rejected',
      httpStatus: 400,
      error: fail('invalid_arguments', `Arguments do not fit the ${tool.name} input schema: ${problems.join('; ')}. Nothing was charged.`, { problems }),
    };
  }
  const priceMc = priceFor(ctx.key, tool);

  if (!isToolAllowed(ctx.key, tool.name)) {
    const receipt = await writeLedger(ctx, tool, {
      status: 'refused_allowlist',
      statusCode: 403,
      priceMc,
      refundMc: 0,
      resultSha256: null,
      errorDetail: null,
      latencyMs: 0,
    });
    const balance = balanceView(ctx.key);
    const error = fail('tool_not_allowed', `Tool '${tool.name}' is not on this agent key's allowlist. Nothing was charged.`, {
      key_id: ctx.key.key_id,
      tool_name: tool.name,
      allowlist: parseAllowlist(ctx.key),
      receipt_id: receipt.id,
    });
    return { kind: 'refused', httpStatus: 403, error, receipt, priceMc, balance };
  }

  const limit = failedCallLimit(ctx.env);
  if ((await failedCallsThisHour(ctx.env.DB, ctx.key.key_id, Date.now())) >= limit) {
    return {
      kind: 'rejected',
      httpStatus: 429,
      error: fail('too_many_failed_calls', `This key made ${limit} failed upstream calls this UTC hour. Failed calls are free, so they are capped; fix the arguments and try next hour.`, { key_id: ctx.key.key_id, limit }),
    };
  }

  const reservedAt = Date.now();
  if (!(await reserveBudget(ctx.env.DB, ctx.key.key_id, priceMc, reservedAt))) {
    return refuseBudget(ctx, tool, priceMc);
  }
  const reservedPeriod = periodKey(ctx.key.budget_period, reservedAt);

  const started = Date.now();
  const upstream = await executeUpstreamTool(ctx.env, tool, ctx.args);
  const latencyMs = Date.now() - started;

  if (!upstream.ok) return refundFailure(ctx, tool, priceMc, reservedPeriod, upstream, latencyMs);

  const receipt = await writeLedger(ctx, tool, {
    status: 'success',
    statusCode: 200,
    priceMc,
    refundMc: 0,
    resultSha256: await sha256Hex(canonicalJson(upstream.data)),
    errorDetail: null,
    latencyMs,
  });
  const { balance } = await freshBalance(ctx.env.DB, ctx.key);
  return { kind: 'success', httpStatus: 200, result: upstream.data, receipt, priceMc, balance };
}

/**
 * Receipt as returned to agents and auditors: the signed bytes and the signature.
 * unsigned_view is a parsed copy for reading only; a verifier must trust payload alone.
 */
export function receiptView(receipt: Receipt) {
  return {
    receipt_id: receipt.id,
    payload: receipt.payload,
    signature: receipt.signature,
    alg: 'Ed25519',
    key_fingerprint: receipt.key_fingerprint,
    public_key_url: '/.well-known/receipt-signing-key.json',
    unsigned_view: JSON.parse(receipt.payload) as Record<string, unknown>,
  };
}

/** The x-clearing-* headers, the same on success and on every refusal. */
export function clearingHeaders(outcome: Exclude<ClearingOutcome, { kind: 'rejected' }>): Record<string, string> {
  return {
    'x-clearing-receipt': outcome.receipt.id,
    'x-clearing-signature': outcome.receipt.signature,
    'x-clearing-price-cents': String(outcome.kind === 'success' ? mcToCents(outcome.priceMc) : 0),
    'x-clearing-remaining-budget-cents': String(outcome.balance.remaining_cents),
  };
}
