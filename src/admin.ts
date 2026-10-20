import type { AgentKey, AuditLog, Env } from './types.ts';
import {
  countKeysCreatedSince,
  createAgentKey,
  createOrganization,
  findOrganizationByName,
  getOrganization,
  getOverviewStats,
  listAgentKeys,
  listAuditLogs,
  listOrganizations,
  listReceipts,
  revokeAgentKey,
  rotateAgentKey,
  updateAgentBudget,
} from './db.ts';
import { balanceView, parseAllowlist, receiptView } from './clearing.ts';
import { timingSafeEqual } from './crypto.ts';
import { centsToMc, mcToCents } from './money.ts';
import { GOVERNED_TOOLS, findGovernedTool } from './tools.ts';
import { jsonResponse } from './proxy.ts';

/** Public key view: never includes key_hash. */
export function keyView(key: AgentKey) {
  return {
    ...balanceView(key),
    key_prefix: key.key_prefix,
    org_id: key.org_id,
    name: key.name,
    allowlist: parseAllowlist(key),
    price_overrides_cents: Object.fromEntries(
      Object.entries(JSON.parse(key.price_overrides) as Record<string, number>).map(([t, mc]) => [t, mcToCents(mc)])
    ),
    status: key.status,
    expires_at: key.expires_at,
    created_at: key.created_at,
    updated_at: key.updated_at,
  };
}

export function auditView(log: AuditLog) {
  return {
    ...log,
    cost_cents: mcToCents(log.cost_mc),
    price_cents: mcToCents(log.price_mc),
    margin_cents: mcToCents(log.margin_mc),
  };
}

function bad(message: string, status = 400): Response {
  return jsonResponse({ error: { code: 'bad_request', message } }, status);
}

function authorizeAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) {
    return jsonResponse({ error: { code: 'admin_disabled', message: 'Admin API is closed on this deployment' } }, 503);
  }
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(token, env.ADMIN_SECRET)) {
    return jsonResponse({ error: { code: 'unauthorized', message: 'Admin bearer token required' } }, 401);
  }
  return null;
}

interface KeyRequest {
  orgId?: unknown;
  name?: unknown;
  budgetCents?: unknown;
  allowlist?: unknown;
  priceOverridesCents?: unknown;
  expiresInMinutes?: unknown;
}

function parseAllowlistInput(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'allowlist must be a non-empty array of tool names or ["*"]';
  const names = value.map(String);
  const unknown = names.filter(n => n !== '*' && !findGovernedTool(n));
  return unknown.length ? `unknown tool(s) in allowlist: ${unknown.join(', ')}` : names;
}

function parseOverrides(value: unknown): Record<string, number> | string {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object') return 'priceOverridesCents must be an object';
  const out: Record<string, number> = {};
  for (const [tool, cents] of Object.entries(value as Record<string, unknown>)) {
    if (!findGovernedTool(tool)) return `unknown tool in priceOverridesCents: ${tool}`;
    if (typeof cents !== 'number' || cents < 0) return `price for ${tool} must be a number >= 0`;
    out[tool] = centsToMc(cents);
  }
  return out;
}

async function handleCreateKey(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as KeyRequest;
  if (typeof body.name !== 'string' || !body.name.trim()) return bad('name is required');
  if (typeof body.budgetCents !== 'number' || body.budgetCents < 0) return bad('budgetCents must be a number >= 0');
  const allowlist = parseAllowlistInput(body.allowlist);
  if (typeof allowlist === 'string') return bad(allowlist);
  const overrides = parseOverrides(body.priceOverridesCents);
  if (typeof overrides === 'string') return bad(overrides);
  if (typeof body.orgId !== 'string' || !(await getOrganization(env.DB, body.orgId))) return bad('orgId must name an existing organization');
  const minutes = typeof body.expiresInMinutes === 'number' ? body.expiresInMinutes : null;

  const created = await createAgentKey(env.DB, {
    orgId: body.orgId,
    name: body.name.trim(),
    budgetMc: centsToMc(body.budgetCents),
    allowlist,
    priceOverrides: overrides,
    expiresAt: minutes ? Date.now() + minutes * 60_000 : null,
  });
  return jsonResponse({ key: created.rawKey, ...keyView(created.key) }, 201);
}

async function handleCreateOrg(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; email?: unknown };
  if (typeof body.name !== 'string' || typeof body.email !== 'string') return bad('name and email are required');
  return jsonResponse(await createOrganization(env.DB, body.name, body.email), 201);
}

async function handleKeyAction(keyId: string, action: string, request: Request, env: Env): Promise<Response> {
  if (action === 'rotate') {
    const rotated = await rotateAgentKey(env.DB, keyId);
    return rotated
      ? jsonResponse({ key: rotated.rawKey, ...keyView(rotated.key) })
      : bad(`key ${keyId} not found or revoked`, 404);
  }
  if (action === 'revoke') {
    return (await revokeAgentKey(env.DB, keyId))
      ? jsonResponse({ key_id: keyId, status: 'revoked' })
      : bad(`key ${keyId} not found`, 404);
  }
  const body = (await request.json().catch(() => ({}))) as { budgetCents?: unknown };
  if (typeof body.budgetCents !== 'number' || body.budgetCents < 0) return bad('budgetCents must be a number >= 0');
  const updated = await updateAgentBudget(env.DB, keyId, centsToMc(body.budgetCents));
  return updated ? jsonResponse(keyView(updated)) : bad('key not found, or new budget is below what is already spent', 409);
}

async function handleAdminGet(path: string, url: URL, env: Env): Promise<Response | null> {
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
  const keyId = url.searchParams.get('key_id') || undefined;
  if (path === '/api/admin/overview') {
    const s = await getOverviewStats(env.DB);
    return jsonResponse({
      organizations: s.orgs,
      active_keys: s.activeKeys,
      allocated_budget_cents: mcToCents(s.budgetMc),
      metered_spend_cents: mcToCents(s.spentMc),
      upstream_cost_cents: mcToCents(s.costMc),
      clearing_margin_cents: mcToCents(s.marginMc),
      signed_receipts: s.receipts,
      refusals: s.refusals,
      upstream_errors: s.upstreamErrors,
    });
  }
  if (path === '/api/admin/orgs') return jsonResponse({ organizations: await listOrganizations(env.DB) });
  if (path === '/api/admin/keys') return jsonResponse({ keys: (await listAgentKeys(env.DB, limit)).map(keyView) });
  if (path === '/api/admin/audit') {
    return jsonResponse({ audit_logs: (await listAuditLogs(env.DB, { keyId }, limit)).map(auditView) });
  }
  if (path === '/api/admin/receipts') {
    return jsonResponse({ receipts: (await listReceipts(env.DB, { keyId }, limit)).map(receiptView) });
  }
  if (path === '/api/admin/tools') {
    return jsonResponse({
      tools: GOVERNED_TOOLS.map(t => ({
        name: t.name,
        upstream: t.target.upstream,
        cost_cents: mcToCents(t.costMc),
        price_cents: mcToCents(t.priceMc),
        margin_cents: mcToCents(t.priceMc - t.costMc),
      })),
    });
  }
  return null;
}

/** /api/admin/*: operator API, bearer ADMIN_SECRET on every route. */
export async function handleAdminRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const denied = authorizeAdmin(request, env);
  if (denied) return denied;
  const path = url.pathname;
  if (request.method === 'GET') {
    const res = await handleAdminGet(path, url, env);
    if (res) return res;
  }
  if (request.method === 'POST') {
    if (path === '/api/admin/orgs') return handleCreateOrg(request, env);
    if (path === '/api/admin/keys') return handleCreateKey(request, env);
    const m = path.match(/^\/api\/admin\/keys\/(key_[a-f0-9]{16})\/(rotate|revoke|budget)$/);
    if (m) return handleKeyAction(m[1], m[2], request, env);
  }
  return jsonResponse({ error: { code: 'not_found', message: `Route not found: ${request.method} ${path}` } }, 404);
}

export const SANDBOX_ORG_NAME = 'Public sandbox';
export const SANDBOX_KEY = {
  budgetCents: 2,
  allowlist: ['eu_duty_estimate', 'check_vat_number'],
  ttlMinutes: 60,
};

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * POST /api/demo/keys: anyone may mint one sandbox key with a fixed 2 cent budget,
 * a fixed 2-tool allowlist and a 60 minute life. A global daily cap bounds what the
 * whole public sandbox can ever spend.
 */
export async function handleDemoKeyRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return bad('Use POST', 405);
  const org =
    (await findOrganizationByName(env.DB, SANDBOX_ORG_NAME)) ??
    (await createOrganization(env.DB, SANDBOX_ORG_NAME, 'sandbox@agent-clearing-desk.invalid'));
  const limit = Number(env.DEMO_DAILY_KEY_LIMIT || 100);
  const used = await countKeysCreatedSince(env.DB, org.id, startOfUtcDay(Date.now()));
  if (used >= limit) {
    return jsonResponse(
      { error: { code: 'rate_limited', message: `The public sandbox minted its ${limit} keys for today (UTC). Try again tomorrow.` } },
      429
    );
  }
  const created = await createAgentKey(env.DB, {
    orgId: org.id,
    name: `sandbox-${new Date().toISOString().slice(11, 19)}`,
    budgetMc: centsToMc(SANDBOX_KEY.budgetCents),
    allowlist: SANDBOX_KEY.allowlist,
    expiresAt: Date.now() + SANDBOX_KEY.ttlMinutes * 60_000,
  });
  return jsonResponse({ key: created.rawKey, ...keyView(created.key), sandbox_keys_left_today: limit - used - 1 }, 201);
}
