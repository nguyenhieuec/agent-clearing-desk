import type { Env, JsonSchema, Millicents } from './types.ts';
import { BUILTIN_TOOLS, DESK_TOOLS, findBuiltinTool, type GovernedTool } from './tools.ts';
import { listMcpServerTools } from './upstream.ts';
import { sealSecret } from './sealed-secret.ts';
import { invalidPatterns } from './json-schema.ts';

interface CustomToolRow {
  name: string;
  title: string;
  description: string;
  upstream: string;
  mcp_url: string;
  upstream_tool: string;
  input_schema: string;
  cost_mc: Millicents;
  price_mc: Millicents;
  timeout_ms: number;
  status: 'active' | 'disabled';
  created_at: number;
  auth_header_name: string | null;
  auth_header_sealed: string | null;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
/** Credential headers an operator may set: Authorization or a vendor x- header. */
const AUTH_HEADER = /^(authorization|x-[a-z0-9-]{1,40})$/;

function fromRow(row: CustomToolRow): GovernedTool {
  return {
    name: row.name,
    title: row.title,
    description: row.description,
    target: {
      kind: 'mcp',
      upstream: row.upstream,
      url: row.mcp_url,
      tool: row.upstream_tool,
      auth: row.auth_header_sealed ? 'header' : 'none',
      ...(row.auth_header_name && row.auth_header_sealed
        ? { authHeader: { name: row.auth_header_name, sealed: row.auth_header_sealed } }
        : {}),
      handshake: true,
    },
    costMc: row.cost_mc,
    priceMc: row.price_mc,
    timeoutMs: row.timeout_ms,
    inputSchema: JSON.parse(row.input_schema) as JsonSchema,
    custom: true,
  };
}

/** A governed tool by name: a built-in one, or an active tool an operator added. */
export async function findTool(env: Env, name: string): Promise<GovernedTool | undefined> {
  const builtin = findBuiltinTool(name);
  if (builtin) return builtin;
  const row = await env.DB.prepare("SELECT * FROM custom_tools WHERE name = ? AND status = 'active'")
    .bind(name)
    .first<CustomToolRow>();
  return row ? fromRow(row) : undefined;
}

/** Every governed tool agents can call now, built-in tools first. */
export async function listTools(env: Env): Promise<GovernedTool[]> {
  const { results } = await env.DB.prepare("SELECT * FROM custom_tools WHERE status = 'active' ORDER BY created_at")
    .all<CustomToolRow>();
  return [...BUILTIN_TOOLS, ...results.map(fromRow)];
}

export interface NewMcpTool {
  name: string;
  mcpUrl: string;
  upstreamTool: string;
  costMc: Millicents;
  priceMc: Millicents;
  timeoutMs: number;
  title?: string;
  description?: string;
  /** Credential for a paid upstream; stored sealed, never returned. */
  authHeader?: { name: string; value: string };
}

function checkAuthHeader(env: Env, auth: NewMcpTool['authHeader']): string | null {
  if (!auth) return null;
  if (!AUTH_HEADER.test(auth.name)) return 'authHeader.name must be authorization or an x- header, in lower case';
  if (!auth.value) return 'authHeader.value is required';
  return env.UPSTREAM_SECRET_KEY ? null : 'this desk has no UPSTREAM_SECRET_KEY, so it cannot store an upstream credential';
}

function checkNewTool(input: NewMcpTool): string | null {
  if (!TOOL_NAME.test(input.name)) return 'name must be 3 to 64 characters: a-z, 0-9 and _, starting with a letter';
  if (findBuiltinTool(input.name) || DESK_TOOLS.some(t => t.name === input.name)) return `${input.name} is a built-in tool name`;
  let url: URL;
  try {
    url = new URL(input.mcpUrl);
  } catch {
    return 'mcpUrl must be a URL';
  }
  return url.protocol === 'https:' ? null : 'mcpUrl must use https';
}

/**
 * Add one tool of a Streamable HTTP MCP server. The desk reads the server's own tools/list,
 * so the schema agents see and the argument check both come from the upstream, not from the operator.
 */
export async function registerMcpTool(env: Env, input: NewMcpTool): Promise<GovernedTool | string> {
  const invalid = checkNewTool(input) ?? checkAuthHeader(env, input.authHeader);
  if (invalid) return invalid;
  let listed: Awaited<ReturnType<typeof listMcpServerTools>>;
  try {
    listed = await listMcpServerTools(input.mcpUrl, input.authHeader);
  } catch (err) {
    return `could not read tools/list from ${input.mcpUrl}: ${String(err instanceof Error ? err.message : err)}`;
  }
  const remote = listed.find(t => t.name === input.upstreamTool);
  if (!remote) return `${input.mcpUrl} does not list a tool named ${input.upstreamTool}`;
  const badPatterns = invalidPatterns(remote.inputSchema);
  if (badPatterns.length > 0) return `the input schema of ${input.upstreamTool} has a pattern the desk cannot check: ${badPatterns[0]}`;
  const row: CustomToolRow = {
    name: input.name,
    title: input.title || input.upstreamTool,
    description: `${input.description || remote.description || input.upstreamTool} Metered by Agent Clearing Desk.`.slice(0, 1000),
    upstream: new URL(input.mcpUrl).hostname,
    mcp_url: input.mcpUrl,
    upstream_tool: input.upstreamTool,
    input_schema: JSON.stringify(remote.inputSchema ?? { type: 'object', properties: {} }),
    cost_mc: input.costMc,
    price_mc: input.priceMc,
    timeout_ms: input.timeoutMs,
    status: 'active',
    created_at: Date.now(),
    auth_header_name: input.authHeader?.name ?? null,
    auth_header_sealed: input.authHeader
      ? await sealSecret(env.UPSTREAM_SECRET_KEY as string, input.name, input.authHeader.value)
      : null,
  };
  const { meta } = await env.DB.prepare(
    `INSERT OR IGNORE INTO custom_tools (name, title, description, upstream, mcp_url, upstream_tool, input_schema,
       cost_mc, price_mc, timeout_ms, status, created_at, auth_header_name, auth_header_sealed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  )
    .bind(row.name, row.title, row.description, row.upstream, row.mcp_url, row.upstream_tool, row.input_schema,
      row.cost_mc, row.price_mc, row.timeout_ms, row.created_at, row.auth_header_name, row.auth_header_sealed)
    .run();
  return meta.changes === 1 ? fromRow(row) : `a tool named ${input.name} already exists`;
}

/** Stop a custom tool: agents get 404 for it from now on, and its ledger history stays. */
export async function disableTool(env: Env, name: string): Promise<boolean> {
  const { meta } = await env.DB.prepare("UPDATE custom_tools SET status = 'disabled' WHERE name = ? AND status = 'active'")
    .bind(name)
    .run();
  return meta.changes === 1;
}
