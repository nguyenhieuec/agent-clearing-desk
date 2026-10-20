import type { AgentKey, Env, McpToolDefinition, RpcRequest } from './types.ts';
import {
  checkBudget,
  createBudgetExceededError,
  createToolNotAllowedError,
  isToolAllowed,
  resolveToolPricing,
} from './metering.ts';
import {
  getAgentKeyByRawKey,
  getReceiptById,
  recordClearingTransaction,
} from './db.ts';
import { verifyReceipt } from './crypto.ts';
import { executeUpstreamTool } from './upstream.ts';

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'eu_duty_estimate',
    description:
      'EU customs duty & VAT: 3 EUR/item on EU imports <=150 EUR. T-shirts, clothes, goods.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'string',
          description: "Description of items (e.g. '3 T-shirts')",
        },
        quantity: {
          type: 'number',
          description: 'Number of items in the consignment',
        },
        unit_value_eur: {
          type: 'number',
          description: 'Value per item in EUR',
        },
      },
    },
  },
  {
    name: 'list_jobs',
    description:
      'Find open jobs at companies: roles, titles, locations from Greenhouse, Lever, Ashby.',
    inputSchema: {
      type: 'object',
      properties: {
        companies: {
          type: 'string',
          description: 'Company name or careers page slug (e.g. airbnb)',
        },
        keyword: {
          type: 'string',
          description: 'Job title or skill keyword (e.g. engineer, designer)',
        },
        location: {
          type: 'string',
          description: 'Location or remote filter',
        },
      },
    },
  },
  {
    name: 'get_app_reviews',
    description:
      'Get app reviews & ratings for iOS App Store and Google Play apps.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Store URL, numeric Apple ID, or Play package name',
        },
        countries: {
          type: 'string',
          description: 'Two-letter country code (default us)',
        },
      },
    },
  },
  {
    name: 'find_tariff_codes',
    description:
      'Find tariff codes & duty rates for product imports into UK and US.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product name or trade description',
        },
      },
    },
  },
  {
    name: 'check_vat_number',
    description:
      'Verify EU VAT number in official VIES registry for valid registration.',
    inputSchema: {
      type: 'object',
      properties: {
        vat_number: {
          type: 'string',
          description: 'Full EU VAT number including country prefix (e.g. DE123456789)',
        },
      },
    },
  },
  {
    name: 'check_agent_balance',
    description:
      'Check agent budget balance, spent amount, and remaining allowance.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_call_receipt',
    description:
      'Fetch signed clearing receipt by receipt ID.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt_id: {
          type: 'string',
          description: 'Receipt ID starting with rcpt_',
        },
      },
    },
  },
];

function rpcResult(id: RpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcTextError(id: RpcRequest['id'], text: string, extra?: Record<string, unknown>) {
  return rpcResult(id, {
    isError: true,
    content: [{ type: 'text', text }],
    ...extra,
  });
}

function firstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function normalizeMcpArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };
  args.items = firstDefined(args, ['items', 'item', 'description', 'product']);
  args.quantity = firstDefined(args, ['quantity', 'qty', 'count']);
  args.companies = firstDefined(args, ['companies', 'company', 'employer']);
  args.app = firstDefined(args, ['app', 'app_id', 'package', 'name']);
  args.query = firstDefined(args, ['query', 'product', 'item', 'description']);
  args.vat_number = firstDefined(args, ['vat_number', 'vat', 'number', 'id']);
  return args;
}

function extractMcpKey(request: Request, params?: Record<string, unknown>): string | undefined {
  const header =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (header?.trim()) return header.trim();
  const meta = params?._meta;
  if (meta && typeof meta === 'object') {
    const apiKey = (meta as Record<string, unknown>).apiKey;
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  }
  return undefined;
}

function buildBalanceResponse(id: RpcRequest['id'], agentKey: AgentKey) {
  const remainingCents = agentKey.budget_cents - agentKey.spent_cents;
  return rpcResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          key_id: agentKey.key_id,
          name: agentKey.name,
          budget_cents: agentKey.budget_cents,
          budget_usd: (agentKey.budget_cents / 100).toFixed(2),
          spent_cents: agentKey.spent_cents,
          spent_usd: (agentKey.spent_cents / 100).toFixed(2),
          remaining_cents: remainingCents,
          remaining_usd: (remainingCents / 100).toFixed(2),
          status: agentKey.status,
          allowlist: JSON.parse(agentKey.allowlist || '["*"]'),
        }),
      },
    ],
    structuredContent: {
      key_id: agentKey.key_id,
      budget_cents: agentKey.budget_cents,
      spent_cents: agentKey.spent_cents,
      remaining_cents: remainingCents,
    },
  });
}

async function buildReceiptResponse(
  id: RpcRequest['id'],
  args: Record<string, unknown>,
  db: D1Database
) {
  const receiptId = String(args.receipt_id || '');
  const receipt = await getReceiptById(db, receiptId);
  if (!receipt) {
    return rpcTextError(id, `Receipt not found: ${receiptId}`);
  }
  const valid = await verifyReceipt(receipt);
  return rpcResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ receipt, signature_valid: valid }),
      },
    ],
    structuredContent: { receipt, signature_valid: valid },
  });
}

async function executeMeteredMcpTool(
  id: RpcRequest['id'],
  toolName: string,
  args: Record<string, unknown>,
  agentKey: AgentKey,
  env: Env
) {
  const paramsSummary = JSON.stringify(args).slice(0, 500);

  if (!isToolAllowed(agentKey, toolName)) {
    const err = createToolNotAllowedError(agentKey, toolName);
    await recordClearingTransaction(env.DB, {
      key: agentKey,
      toolName,
      protocol: 'mcp',
      requestMethod: 'tools/call',
      status: 'refused_allowlist',
      statusCode: 403,
      paramsSummary,
      costCents: 0,
      priceCents: 0,
      marginCents: 0,
    });
    return rpcTextError(id, err.error.message, { structuredContent: err });
  }

  const pricing = resolveToolPricing(agentKey, toolName);
  const budgetCheck = checkBudget(agentKey, pricing.priceCents);

  if (!budgetCheck.allowed) {
    const { receipt } = await recordClearingTransaction(env.DB, {
      key: agentKey,
      toolName,
      protocol: 'mcp',
      requestMethod: 'tools/call',
      status: 'refused_budget',
      statusCode: 402,
      paramsSummary,
      costCents: 0,
      priceCents: 0,
      marginCents: 0,
    });
    const err = createBudgetExceededError(agentKey, toolName, pricing.priceCents, receipt.id);
    return rpcTextError(id, err.error.message, {
      structuredContent: err,
      _meta: { receipt_id: receipt.id, receipt_hash: receipt.receipt_hash },
    });
  }

  const upstream = await executeUpstreamTool(env, toolName, args);
  const { auditLog, receipt } = await recordClearingTransaction(env.DB, {
    key: agentKey,
    toolName,
    protocol: 'mcp',
    requestMethod: 'tools/call',
    status: upstream.ok ? 'success' : 'error',
    statusCode: upstream.status,
    paramsSummary,
    costCents: pricing.costCents,
    priceCents: pricing.priceCents,
    marginCents: pricing.marginCents,
  });

  const newSpent = agentKey.spent_cents + (upstream.ok ? pricing.priceCents : 0);
  const remainingBudget = Math.max(0, agentKey.budget_cents - newSpent);
  const meta = {
    clearing_desk: {
      receipt_id: receipt.id,
      receipt_hash: receipt.receipt_hash,
      amount_cents: receipt.amount_cents,
      amount_usd: (receipt.amount_cents / 100).toFixed(4),
      remaining_budget_cents: remainingBudget,
      remaining_budget_usd: (remainingBudget / 100).toFixed(4),
      audit_log_id: auditLog.id,
    },
  };

  const payload = { ...upstream.data, _clearing_receipt: meta.clearing_desk };
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    _meta: meta,
  });
}

async function handleToolsCall(
  id: RpcRequest['id'],
  params: Record<string, unknown> | undefined,
  rawKey: string | undefined,
  env: Env
) {
  const toolName = params?.name as string | undefined;
  if (!toolName) return rpcError(id, -32602, 'params.name is required');
  if (!rawKey) {
    return rpcTextError(
      id,
      'Unauthorized: missing agent key. Provide x-api-key header or Authorization: Bearer <key>'
    );
  }

  const agentKey = await getAgentKeyByRawKey(env.DB, rawKey);
  if (!agentKey) return rpcTextError(id, 'Unauthorized: invalid agent key');
  if (agentKey.status === 'revoked') {
    return rpcTextError(id, 'Forbidden: agent key has been revoked');
  }

  const rawArgs = (params?.arguments as Record<string, unknown>) || {};
  const args = normalizeMcpArgs(rawArgs);

  if (toolName === 'check_agent_balance') return buildBalanceResponse(id, agentKey);
  if (toolName === 'get_call_receipt') return buildReceiptResponse(id, args, env.DB);

  return executeMeteredMcpTool(id, toolName, args, agentKey, env);
}

async function handleSingleRpc(
  rpc: RpcRequest,
  request: Request,
  env: Env
): Promise<unknown | null> {
  if (!rpc || typeof rpc !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = rpc;
  const isNotification = id === undefined;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'agent-clearing-desk',
        version: '0.1.0',
        title: 'Agent Clearing Desk',
      },
      instructions:
        'Agent Clearing Desk meters tool calls, enforces budget caps, and issues signed audit receipts.',
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    if (isNotification) return null;
    const rawKey = extractMcpKey(request, params);
    return handleToolsCall(id, params, rawKey, env);
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle incoming MCP POST requests.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, 'Invalid JSON body')),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const requests: RpcRequest[] = Array.isArray(body)
    ? (body as RpcRequest[])
    : [body as RpcRequest];

  const responses: unknown[] = [];
  for (const rpc of requests) {
    const out = await handleSingleRpc(rpc, request, env);
    if (out !== null) responses.push(out);
  }

  const resultBody = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(resultBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
