import type { Env } from './types.ts';
import type { GovernedTool } from './tools.ts';
import { openkrillCredential } from './openkrill-auth.ts';
import { openSecret } from './sealed-secret.ts';

export type UpstreamResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; message: string };

const DEFAULT_OPENKRILL = 'https://api.openkrill.app';

function openkrillBase(env: Env): string {
  return env.OPENKRILL_BASE_URL || DEFAULT_OPENKRILL;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'AgentClearingDesk/1.0',
  };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

/** Streamable HTTP MCP servers may answer with one SSE message instead of plain JSON. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const data = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .find(line => line.startsWith('{'));
  if (!data) throw new Error('empty event stream from upstream');
  return JSON.parse(data) as Record<string, unknown>;
}

function mcpResultData(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function errorText(result: Record<string, unknown>): string {
  const data = mcpResultData(result);
  if (data && typeof data === 'object' && 'text' in data) return String((data as { text: unknown }).text);
  return JSON.stringify(data).slice(0, 300);
}

type McpTool = GovernedTool & { target: { kind: 'mcp' } };
type Failure = { ok: false; status: number; message: string };

/** Request headers for one MCP upstream, with its credential: OpenKrill's, an operator's sealed header, or none. */
async function mcpHeaders(env: Env, tool: McpTool): Promise<Record<string, string>> {
  const { target } = tool;
  if (target.auth === 'openkrill') return headers(await openkrillCredential(env));
  if (target.auth !== 'header' || !target.authHeader) return headers();
  if (!env.UPSTREAM_SECRET_KEY) throw new Error('UPSTREAM_SECRET_KEY is not set, so the stored upstream credential cannot be opened');
  return { ...headers(), [target.authHeader.name]: await openSecret(env.UPSTREAM_SECRET_KEY, tool.name, target.authHeader.sealed) };
}

function rpcPost(url: string, h: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
}

/**
 * The MCP lifecycle: initialize, then notifications/initialized. Returns the headers for the
 * next requests, with the Mcp-Session-Id and protocol version when the server sets them,
 * so stateful servers work as well as stateless ones.
 */
async function openMcpSession(
  url: string,
  h: Record<string, string>,
  signal: AbortSignal
): Promise<{ ok: true; headers: Record<string, string> } | Failure> {
  const res = await rpcPost(url, h, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-clearing-desk', version: '0.4.0' } },
  }, signal);
  if (!res.ok) return { ok: false, status: res.status, message: `initialize answered HTTP ${res.status}` };
  const rpc = await readJsonRpc(res);
  if (rpc.error) return { ok: false, status: 502, message: `initialize failed: ${(rpc.error as { message?: string }).message ?? 'error'}` };
  const session = res.headers.get('mcp-session-id');
  const version = (rpc.result as { protocolVersion?: string } | undefined)?.protocolVersion;
  const next = { ...h, ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) };
  await (await rpcPost(url, next, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal)).arrayBuffer();
  return { ok: true, headers: next };
}

/** JSON-RPC "invalid params" is the agent's mistake, like an HTTP 400. */
const INVALID_PARAMS = -32602;

async function callMcp(env: Env, tool: McpTool, args: Record<string, unknown>, signal: AbortSignal): Promise<UpstreamResult> {
  const { target } = tool;
  const url = target.url.startsWith('/') ? `${openkrillBase(env)}${target.url}` : target.url;
  let h = await mcpHeaders(env, tool);
  if (target.handshake) {
    const session = await openMcpSession(url, h, signal);
    if (!session.ok) return session;
    h = session.headers;
  }
  const res = await rpcPost(url, h, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: target.tool, arguments: args } }, signal);
  if (!res.ok) return { ok: false, status: res.status, message: `upstream HTTP ${res.status}` };
  const rpc = await readJsonRpc(res);
  if (rpc.error) {
    const err = rpc.error as { code?: number; message?: string };
    return { ok: false, status: err.code === INVALID_PARAMS ? 400 : 502, message: err.message || 'upstream JSON-RPC error' };
  }
  const result = (rpc.result ?? {}) as Record<string, unknown>;
  if (result.isError) return { ok: false, status: 502, message: errorText(result) };
  return { ok: true, data: mcpResultData(result) };
}

async function callRest(
  env: Env,
  tool: GovernedTool & { target: { kind: 'rest' } },
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<UpstreamResult> {
  const url = `${openkrillBase(env)}/v1/tools/${encodeURIComponent(tool.target.tool)}/run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(await openkrillCredential(env)),
    body: JSON.stringify(args),
    signal,
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = body?.error as { message?: string } | undefined;
    return { ok: false, status: res.status, message: err?.message || `upstream HTTP ${res.status}` };
  }
  return { ok: true, data: body };
}

/**
 * The tools an MCP server lists, for an operator adding one of them to the desk. Runs the
 * full lifecycle with the operator's credential header, the same way calls will run.
 */
export async function listMcpServerTools(
  url: string,
  auth?: { name: string; value: string },
  timeoutMs = 15_000
): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const session = await openMcpSession(url, { ...headers(), ...(auth ? { [auth.name]: auth.value } : {}) }, signal);
  if (!session.ok) throw new Error(session.message);
  const res = await rpcPost(url, session.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, signal);
  if (!res.ok) throw new Error(`tools/list answered HTTP ${res.status}`);
  const rpc = await readJsonRpc(res);
  const tools = (rpc.result as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');
  return tools as { name: string; description?: string; inputSchema?: unknown }[];
}

/**
 * Run a governed tool on its upstream. Every failure (HTTP error, tool error, timeout,
 * bad payload) comes back as ok:false; the desk never substitutes its own data.
 */
export async function executeUpstreamTool(
  env: Env,
  tool: GovernedTool,
  args: Record<string, unknown>
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
  try {
    return tool.target.kind === 'mcp'
      ? await callMcp(env, tool as McpTool, args, controller.signal)
      : await callRest(env, tool as GovernedTool & { target: { kind: 'rest' } }, args, controller.signal);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      message: timedOut ? `upstream timed out after ${tool.timeoutMs} ms` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
