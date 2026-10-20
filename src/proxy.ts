import type { AgentKey, Env } from './types.ts';
import {
  checkBudget,
  createBudgetExceededError,
  createToolNotAllowedError,
  isToolAllowed,
  resolveCatalogPricing,
  resolveToolPricing,
} from './metering.ts';
import {
  getAgentKeyByRawKey,
  getReceiptById,
  getUsage,
  listReceipts,
  recordClearingTransaction,
} from './db.ts';
import { verifyReceipt } from './crypto.ts';
import { executeUpstreamTool, fetchUpstreamOpenkrillUsage } from './upstream.ts';
import { MCP_TOOLS } from './mcp.ts';

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
    },
  });
}

function extractApiKey(request: Request): string | null {
  const header =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return header?.trim() || null;
}

async function requireValidKey(
  request: Request,
  db: D1Database,
  missingMsg: string
): Promise<{ key: AgentKey } | { errorResponse: Response }> {
  const rawKey = extractApiKey(request);
  if (!rawKey) {
    return {
      errorResponse: jsonResponse(
        { error: { code: 'unauthorized', message: missingMsg } },
        401
      ),
    };
  }
  const key = await getAgentKeyByRawKey(db, rawKey);
  if (!key) {
    return {
      errorResponse: jsonResponse(
        { error: { code: 'unauthorized', message: 'Invalid API key' } },
        401
      ),
    };
  }
  return { key };
}

async function handleListTools(request: Request, env: Env): Promise<Response> {
  const rawKey = extractApiKey(request);
  const key = rawKey ? await getAgentKeyByRawKey(env.DB, rawKey) : null;
  const keyInfo = key
    ? {
        key_id: key.key_id,
        budget_cents: key.budget_cents,
        spent_cents: key.spent_cents,
        remaining_cents: Math.max(0, key.budget_cents - key.spent_cents),
      }
    : null;

  const toolsWithPricing = MCP_TOOLS.map(t => {
    const p = key ? resolveToolPricing(key, t.name) : resolveCatalogPricing(t.name);
    return {
      ...t,
      pricing: {
        cost_cents: p.costCents,
        price_cents: p.priceCents,
        margin_cents: p.marginCents,
        default_price_usd: `$${(p.priceCents / 100).toFixed(4)}`,
      },
    };
  });

  return jsonResponse({
    tools: toolsWithPricing,
    authenticated_key: keyInfo,
  });
}

async function handleGetUsage(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireValidKey(request, env.DB, 'API key required for /v1/usage');
  if ('errorResponse' in auth) return auth.errorResponse;

  const period = url.searchParams.get('period') || undefined;
  const usage = await getUsage(env.DB, auth.key.key_id, period);
  const upstreamUsage = await fetchUpstreamOpenkrillUsage(env, usage.period);
  if (upstreamUsage) {
    usage.upstream_openkrill_usage = upstreamUsage;
  }
  return jsonResponse(usage);
}

async function handleGetReceiptById(receiptId: string, env: Env): Promise<Response> {
  const receipt = await getReceiptById(env.DB, receiptId);
  if (!receipt) {
    return jsonResponse(
      { error: { code: 'not_found', message: `Receipt ${receiptId} not found` } },
      404
    );
  }
  const signatureValid = await verifyReceipt(receipt);
  return jsonResponse({ receipt, signature_valid: signatureValid });
}

async function handleListReceipts(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireValidKey(request, env.DB, 'API key required for receipts');
  if ('errorResponse' in auth) return auth.errorResponse;

  const limit = Number(url.searchParams.get('limit') || 50);
  const receipts = await listReceipts(env.DB, auth.key.key_id, limit);
  return jsonResponse({ receipts });
}

async function parseRunArgs(
  request: Request,
  url: URL
): Promise<Record<string, unknown>> {
  if (request.method === 'GET') {
    const args: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams.entries()) {
      args[k] = v;
    }
    return args;
  }
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handleRunTool(
  toolName: string,
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const auth = await requireValidKey(
    request,
    env.DB,
    'Missing API key. Provide x-api-key or Authorization: Bearer <key>'
  );
  if ('errorResponse' in auth) return auth.errorResponse;
  const { key } = auth;

  if (key.status === 'revoked') {
    return jsonResponse(
      { error: { code: 'key_revoked', message: 'Agent key has been revoked' } },
      403
    );
  }

  const args = await parseRunArgs(request, url);
  const paramsSummary = JSON.stringify(args).slice(0, 500);

  if (!isToolAllowed(key, toolName)) {
    const err = createToolNotAllowedError(key, toolName);
    await recordClearingTransaction(env.DB, {
      key,
      toolName,
      protocol: 'http',
      requestMethod: request.method,
      status: 'refused_allowlist',
      statusCode: 403,
      paramsSummary,
      costCents: 0,
      priceCents: 0,
      marginCents: 0,
    });
    return jsonResponse(err, 403);
  }

  const pricing = resolveToolPricing(key, toolName);
  const budgetCheck = checkBudget(key, pricing.priceCents);

  if (!budgetCheck.allowed) {
    const { receipt } = await recordClearingTransaction(env.DB, {
      key,
      toolName,
      protocol: 'http',
      requestMethod: request.method,
      status: 'refused_budget',
      statusCode: 402,
      paramsSummary,
      costCents: 0,
      priceCents: 0,
      marginCents: 0,
    });
    const err = createBudgetExceededError(key, toolName, pricing.priceCents, receipt.id);
    return jsonResponse(err, 402, {
      'x-clearing-receipt': receipt.id,
      'x-clearing-receipt-hash': receipt.receipt_hash,
    });
  }

  const upstream = await executeUpstreamTool(env, toolName, args);
  const { auditLog, receipt } = await recordClearingTransaction(env.DB, {
    key,
    toolName,
    protocol: 'http',
    requestMethod: request.method,
    status: upstream.ok ? 'success' : 'error',
    statusCode: upstream.status,
    paramsSummary,
    costCents: pricing.costCents,
    priceCents: pricing.priceCents,
    marginCents: pricing.marginCents,
  });

  const newSpent = key.spent_cents + (upstream.ok ? pricing.priceCents : 0);
  const remainingBudget = Math.max(0, key.budget_cents - newSpent);

  return jsonResponse(
    {
      result: upstream.data,
      clearing_receipt: {
        receipt_id: receipt.id,
        receipt_hash: receipt.receipt_hash,
        amount_cents: receipt.amount_cents,
        amount_usd: (receipt.amount_cents / 100).toFixed(4),
        currency: receipt.currency,
        issued_at: receipt.issued_at,
        remaining_budget_cents: remainingBudget,
        remaining_budget_usd: (remainingBudget / 100).toFixed(4),
        audit_log_id: auditLog.id,
      },
    },
    upstream.status,
    {
      'x-clearing-receipt': receipt.id,
      'x-clearing-receipt-hash': receipt.receipt_hash,
      'x-clearing-price-cents': pricing.priceCents.toString(),
      'x-clearing-remaining-budget-cents': remainingBudget.toString(),
    }
  );
}

/**
 * Handle HTTP proxy routes under /v1/
 */
export async function handleProxyRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/v1/tools' && method === 'GET') {
    return handleListTools(request, env);
  }
  if (path === '/v1/usage' && method === 'GET') {
    return handleGetUsage(request, env, url);
  }
  if (path === '/v1/receipts' && method === 'GET') {
    return handleListReceipts(request, env, url);
  }

  const receiptMatch = path.match(/^\/v1\/receipts\/([a-zA-Z0-9_-]+)$/);
  if (receiptMatch && method === 'GET') {
    return handleGetReceiptById(receiptMatch[1], env);
  }

  const runMatch = path.match(/^\/v1\/tools\/([a-zA-Z0-9_-]+)\/run$/);
  if (runMatch && (method === 'GET' || method === 'POST')) {
    return handleRunTool(runMatch[1], request, env, url);
  }

  return jsonResponse(
    { error: { code: 'not_found', message: `Route not found: ${path}` } },
    404
  );
}
