import type { AgentKey, Env } from './types.ts';
import {
  authenticateAgent,
  balanceView,
  clearingHeaders,
  clearToolCall,
  parseAllowlist,
  priceFor,
  receiptView,
} from './clearing.ts';
import { currentPeriod, getReceiptById, getUsageEvents, listReceipts, rotateAgentKey } from './db.ts';
import { GOVERNED_TOOLS, inputSchemaFor } from './tools.ts';
import { mcToCents, mcToUsd } from './money.ts';

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function extractAgentKey(request: Request): string | null {
  const raw =
    request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return raw?.trim() || null;
}

type Authed = (key: AgentKey) => Promise<Response>;

async function withAgent(request: Request, env: Env, handler: Authed): Promise<Response> {
  const auth = await authenticateAgent(env.DB, extractAgentKey(request));
  if (!auth.ok) return jsonResponse(auth.error, auth.status);
  return handler(auth.key);
}

function toolCatalog(key: AgentKey | null) {
  const allowlist = key ? parseAllowlist(key) : null;
  return GOVERNED_TOOLS.map(tool => {
    const priceMc = key ? priceFor(key, tool) : tool.priceMc;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      upstream: tool.target.upstream,
      inputSchema: inputSchemaFor(tool.name),
      price_cents: mcToCents(priceMc),
      price_usd: mcToUsd(priceMc),
      ...(allowlist ? { allowed: allowlist.includes('*') || allowlist.includes(tool.name) } : {}),
    };
  });
}

async function handleListTools(request: Request, env: Env): Promise<Response> {
  const rawKey = extractAgentKey(request);
  if (!rawKey) return jsonResponse({ tools: toolCatalog(null) });
  return withAgent(request, env, async key =>
    jsonResponse({ tools: toolCatalog(key), balance: balanceView(key) })
  );
}

async function handleUsage(key: AgentKey, env: Env, url: URL): Promise<Response> {
  const period = url.searchParams.get('period') || currentPeriod();
  const events = await getUsageEvents(env.DB, key.key_id, period);
  return jsonResponse({
    period,
    ...balanceView(key),
    items: events.map(e => ({ tool: e.event, calls: e.count, spent_cents: mcToCents(e.spent_mc) })),
    total_calls: events.reduce((n, e) => n + e.count, 0),
  });
}

/** Receipts are visible to keys of the same organization only. */
async function handleGetReceipt(key: AgentKey, env: Env, receiptId: string): Promise<Response> {
  const receipt = await getReceiptById(env.DB, receiptId);
  if (!receipt || receipt.org_id !== key.org_id) {
    return jsonResponse({ error: { code: 'not_found', message: `Receipt ${receiptId} not found` } }, 404);
  }
  return jsonResponse({ receipt: receiptView(receipt) });
}

async function handleListReceipts(key: AgentKey, env: Env, url: URL): Promise<Response> {
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
  const receipts = await listReceipts(env.DB, { keyId: key.key_id }, limit);
  return jsonResponse({ receipts: receipts.map(receiptView) });
}

/** An agent may rotate its own secret; the old one stops working at once. */
async function handleSelfRotate(key: AgentKey, env: Env): Promise<Response> {
  const rotated = await rotateAgentKey(env.DB, key.key_id);
  if (!rotated) return jsonResponse({ error: { code: 'key_revoked', message: 'Key cannot be rotated' } }, 409);
  return jsonResponse({ key_id: rotated.key.key_id, key: rotated.rawKey, key_prefix: rotated.key.key_prefix });
}

async function readArgs(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleRunTool(key: AgentKey, env: Env, request: Request, toolName: string): Promise<Response> {
  const args = await readArgs(request);
  if (!args) {
    return jsonResponse({ error: { code: 'bad_request', message: 'Body must be a JSON object of tool arguments' } }, 400);
  }
  const outcome = await clearToolCall({ env, key, toolName, args, protocol: 'http' });
  if (outcome.kind === 'rejected') return jsonResponse(outcome.error, outcome.httpStatus);
  const headers = clearingHeaders(outcome);
  const receipt = receiptView(outcome.receipt);
  if (outcome.kind !== 'success') {
    return jsonResponse({ ...outcome.error, receipt, balance: outcome.balance }, outcome.httpStatus, headers);
  }
  return jsonResponse({ result: outcome.result, receipt, balance: outcome.balance }, 200, headers);
}

export async function handleProxyRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/v1/tools' && method === 'GET') return handleListTools(request, env);
  if (path === '/v1/usage' && method === 'GET') return withAgent(request, env, key => handleUsage(key, env, url));
  if (path === '/v1/receipts' && method === 'GET') {
    return withAgent(request, env, key => handleListReceipts(key, env, url));
  }
  if (path === '/v1/key/rotate' && method === 'POST') return withAgent(request, env, key => handleSelfRotate(key, env));

  const receiptMatch = path.match(/^\/v1\/receipts\/(rcpt_[a-f0-9]{24})$/);
  if (receiptMatch && method === 'GET') {
    return withAgent(request, env, key => handleGetReceipt(key, env, receiptMatch[1]));
  }
  const runMatch = path.match(/^\/v1\/tools\/([a-z0-9_-]+)\/run$/);
  if (runMatch && method === 'POST') {
    return withAgent(request, env, key => handleRunTool(key, env, request, runMatch[1]));
  }
  return jsonResponse({ error: { code: 'not_found', message: `Route not found: ${method} ${path}` } }, 404);
}
