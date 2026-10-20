import type { AgentKey, AuditLog, Env } from './types.ts';
import {
  claimDailySlot,
  createAgentKey,
  createOrganization,
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
import type { BudgetPeriod } from './types.ts';
import { BUDGET_PERIODS } from './budget-period.ts';
import type { GovernedTool } from './tools.ts';
import { disableTool, findTool, listTools, registerMcpTool } from './tool-registry.ts';
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
  budgetPeriod?: unknown;
}

async function unknownTools(env: Env, names: string[]): Promise<string[]> {
  const found = await Promise.all(names.map(n => (n === '*' ? true : findTool(env, n))));
  return names.filter((_, i) => !found[i]);
}

async function parseAllowlistInput(env: Env, value: unknown): Promise<string[] | string> {
  if (!Array.isArray(value) || value.length === 0) return 'allowlist must be a non-empty array of tool names or ["*"]';
  const names = value.map(String);
  const unknown = await unknownTools(env, names);
  return unknown.length ? `unknown tool(s) in allowlist: ${unknown.join(', ')}` : names;
}

async function parseOverrides(env: Env, value: unknown): Promise<Record<string, number> | string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object') return 'priceOverridesCents must be an object';
  const entries = Object.entries(value as Record<string, unknown>);
  const unknown = await unknownTools(env, entries.map(([tool]) => tool));
  if (unknown.length) return `unknown tool in priceOverridesCents: ${unknown.join(', ')}`;
  const out: Record<string, number> = {};
  for (const [tool, cents] of entries) {
    if (typeof cents !== 'number' || cents < 0) return `price for ${tool} must be a number >= 0`;
    out[tool] = centsToMc(cents);
  }
  return out;
}

async function handleCreateKey(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as KeyRequest;
  if (typeof body.name !== 'string' || !body.name.trim()) return bad('name is required');
  if (typeof body.budgetCents !== 'number' || body.budgetCents < 0) return bad('budgetCents must be a number >= 0');
  const period = (body.budgetPeriod ?? 'none') as BudgetPeriod;
  if (!BUDGET_PERIODS.includes(period)) return bad('budgetPeriod must be none, daily or monthly');
  const allowlist = await parseAllowlistInput(env, body.allowlist);
  if (typeof allowlist === 'string') return bad(allowlist);
  const overrides = await parseOverrides(env, body.priceOverridesCents);
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
    budgetPeriod: period,
  });
  return jsonResponse({ key: created.rawKey, ...keyView(created.key) }, 201);
}

function toolView(t: GovernedTool) {
  return {
    name: t.name,
    upstream: t.target.upstream,
    custom: t.custom,
    ...(t.custom && t.target.kind === 'mcp'
      ? {
          mcp_url: t.target.url,
          upstream_tool: t.target.tool,
          // Only the header name is shown; the credential itself stays sealed in D1.
          upstream_auth: t.target.authHeader ? `${t.target.authHeader.name} header, sealed` : 'none',
        }
      : {}),
    cost_cents: mcToCents(t.costMc),
    price_cents: mcToCents(t.priceMc),
    margin_cents: mcToCents(t.priceMc - t.costMc),
  };
}

interface ToolRequest {
  name?: unknown;
  mcpUrl?: unknown;
  upstreamTool?: unknown;
  costCents?: unknown;
  priceCents?: unknown;
  timeoutMs?: unknown;
  title?: unknown;
  description?: unknown;
  authHeader?: unknown;
}

/** The optional {name, value} credential header for a paid upstream; undefined when not given. */
function parseAuthHeader(raw: unknown): { name: string; value: string } | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  const h = raw as { name?: unknown; value?: unknown };
  if (typeof h.name !== 'string' || typeof h.value !== 'string') return 'authHeader must be {name, value}';
  return { name: h.name.toLowerCase(), value: h.value };
}

const isCents = (v: unknown): v is number => typeof v === 'number' && v >= 0;

/** POST /api/admin/tools: put one tool of any Streamable HTTP MCP server behind the gate, no deploy. */
async function handleCreateTool(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ToolRequest;
  if (typeof body.name !== 'string' || typeof body.mcpUrl !== 'string' || typeof body.upstreamTool !== 'string') {
    return bad('name, mcpUrl and upstreamTool are required');
  }
  if (!isCents(body.costCents) || !isCents(body.priceCents)) return bad('costCents and priceCents must be numbers >= 0');
  const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 15_000;
  if (timeoutMs < 1000 || timeoutMs > 60_000) return bad('timeoutMs must be between 1000 and 60000');
  const authHeader = parseAuthHeader(body.authHeader);
  if (typeof authHeader === 'string') return bad(authHeader);
  const created = await registerMcpTool(env, {
    name: body.name,
    mcpUrl: body.mcpUrl,
    upstreamTool: body.upstreamTool,
    costMc: centsToMc(body.costCents),
    priceMc: centsToMc(body.priceCents),
    timeoutMs,
    title: typeof body.title === 'string' ? body.title : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    authHeader,
  });
  return typeof created === 'string' ? bad(created) : jsonResponse(toolView(created), 201);
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
  if (path === '/api/admin/tools') return jsonResponse({ tools: (await listTools(env)).map(toolView) });
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
    if (path === '/api/admin/tools') return handleCreateTool(request, env);
    const tool = path.match(/^\/api\/admin\/tools\/([a-z][a-z0-9_]{2,63})\/disable$/);
    if (tool) {
      return (await disableTool(env, tool[1]))
        ? jsonResponse({ name: tool[1], status: 'disabled' })
        : bad(`no active custom tool named ${tool[1]}`, 404);
    }
    const m = path.match(/^\/api\/admin\/keys\/(key_[a-f0-9]{16})\/(rotate|revoke|budget)$/);
    if (m) return handleKeyAction(m[1], m[2], request, env);
  }
  return jsonResponse({ error: { code: 'not_found', message: `Route not found: ${request.method} ${path}` } }, 404);
}

export const SANDBOX_KEY = {
  budgetCents: 2,
  allowlist: ['eu_duty_estimate', 'check_vat_number'],
  ttlMinutes: 60,
};

/**
 * POST /api/demo/keys: anyone may mint one sandbox key with a fixed 2 cent budget,
 * a fixed 2-tool allowlist and a 60 minute life, in its own organization so no
 * sandbox key can read another one's receipts. A global daily cap, taken in one
 * conditional SQL statement, bounds what the whole public sandbox can ever spend.
 */
export async function handleDemoKeyRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return bad('Use POST', 405);
  const limit = Number(env.DEMO_DAILY_KEY_LIMIT || 100);
  const slot = await claimDailySlot(env.DB, 'sandbox_keys', limit, Date.now());
  if (slot === null) {
    return jsonResponse(
      { error: { code: 'rate_limited', message: `The public sandbox minted its ${limit} keys for today (UTC). Try again tomorrow.` } },
      429
    );
  }
  // The daily slot number tells sandbox organizations apart in the console, even within one second.
  const org = await createOrganization(env.DB, `Sandbox #${slot}, ${new Date().toISOString().slice(5, 10)}`, 'sandbox@agent-clearing-desk.invalid');
  const created = await createAgentKey(env.DB, {
    orgId: org.id,
    name: `sandbox #${slot}`,
    budgetMc: centsToMc(SANDBOX_KEY.budgetCents),
    allowlist: SANDBOX_KEY.allowlist,
    expiresAt: Date.now() + SANDBOX_KEY.ttlMinutes * 60_000,
  });
  return jsonResponse({ key: created.rawKey, ...keyView(created.key), sandbox_keys_left_today: limit - slot }, 201);
}
