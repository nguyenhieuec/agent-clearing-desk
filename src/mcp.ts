import type { AgentKey, Env, RpcRequest } from './types.ts';
import { authenticateAgent, balanceView, clearToolCall, parseAllowlist, receiptView, type ClearingOutcome } from './clearing.ts';
import { getReceiptById } from './db.ts';
import { mcpToolList } from './tools.ts';
import { listTools } from './tool-registry.ts';
import { extractAgentKey } from './proxy.ts';
import { mcToCents } from './money.ts';
import { publicSigningKey, verifyReceiptSignature } from './crypto.ts';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type RpcId = RpcRequest['id'];

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Tool output: the same JSON as text (for any client) and as structuredContent. */
function toolResult(id: RpcId, structured: object, isError = false) {
  return rpcResult(id, {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
}

function balanceTool(id: RpcId, key: AgentKey) {
  return toolResult(id, { ...balanceView(key), name: key.name, allowlist: parseAllowlist(key) });
}

async function receiptTool(id: RpcId, key: AgentKey, args: Record<string, unknown>, env: Env) {
  const receiptId = String(args.receipt_id ?? '');
  const receipt = await getReceiptById(env.DB, receiptId);
  if (!receipt || receipt.org_id !== key.org_id) {
    return toolResult(id, { error: { code: 'not_found', message: `Receipt ${receiptId} not found` } }, true);
  }
  const signatureValid = await verifyReceiptSignature(
    await publicSigningKey(env.RECEIPT_SIGNING_KEY),
    receipt.payload,
    receipt.signature
  );
  return toolResult(id, { receipt: receiptView(receipt), signature_valid: signatureValid });
}

function outcomeResult(id: RpcId, outcome: ClearingOutcome) {
  if (outcome.kind === 'rejected') return toolResult(id, outcome.error, true);
  // The whole signed receipt rides along, so an MCP client can verify with no second call.
  const clearing = {
    receipt_id: outcome.receipt.id,
    signature: outcome.receipt.signature,
    price_cents: outcome.kind === 'success' ? mcToCents(outcome.priceMc) : 0,
    ...outcome.balance,
    receipt: receiptView(outcome.receipt),
  };
  if (outcome.kind !== 'success') return toolResult(id, { ...outcome.error, clearing }, true);
  return toolResult(id, { result: outcome.result, clearing });
}

async function toolsCall(id: RpcId, params: Record<string, unknown> | undefined, request: Request, env: Env) {
  const name = typeof params?.name === 'string' ? params.name : '';
  if (!name) return rpcError(id, -32602, 'params.name is required');
  const auth = await authenticateAgent(env.DB, extractAgentKey(request));
  if (!auth.ok) return toolResult(id, auth.error, true);
  const args = (params?.arguments ?? {}) as Record<string, unknown>;

  if (name === 'check_agent_balance') return balanceTool(id, auth.key);
  if (name === 'get_call_receipt') return receiptTool(id, auth.key, args, env);
  return outcomeResult(id, await clearToolCall({ env, key: auth.key, toolName: name, args, protocol: 'mcp' }));
}

function initialize(id: RpcId, params: Record<string, unknown> | undefined) {
  const requested = String(params?.protocolVersion ?? '');
  return rpcResult(id, {
    protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'agent-clearing-desk', title: 'Agent Clearing Desk', version: '0.3.0' },
    instructions:
      'Every paid tool call is checked against your key allowlist and budget before it runs, and returns a signed receipt. ' +
      'On budget_exceeded or tool_not_allowed, stop: retrying will not succeed. check_agent_balance and get_call_receipt are free.',
  });
}

async function handleRpc(rpc: RpcRequest, request: Request, env: Env): Promise<unknown | null> {
  if (!rpc || typeof rpc !== 'object') return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = rpc;
  if (id === undefined) return null; // notifications need no answer
  if (method === 'initialize') return initialize(id, params);
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: mcpToolList(await listTools(env)) });
  if (method === 'tools/call') return toolsCall(id, params, request, env);
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Stateless Streamable HTTP MCP endpoint (JSON responses, no session). */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify(rpcError(null, -32000, 'Use POST for MCP JSON-RPC')), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, 'Invalid JSON body')), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const batch = Array.isArray(body) ? (body as RpcRequest[]) : [body as RpcRequest];
  const answers: unknown[] = [];
  for (const rpc of batch) {
    const out = await handleRpc(rpc, request, env);
    if (out !== null) answers.push(out);
  }
  if (answers.length === 0) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
