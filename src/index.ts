import type { Env } from './types.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleProxyRequest, jsonResponse } from './proxy.ts';
import { handleAdminRequest, handleDemoKeyRequest } from './admin.ts';
import { publicSigningKey } from './crypto.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key, authorization, mcp-protocol-version',
  'access-control-expose-headers':
    'x-clearing-receipt, x-clearing-signature, x-clearing-price-cents, x-clearing-remaining-budget-cents',
  'access-control-max-age': '86400',
};

/** Agent-facing routes are open to any origin; the admin API stays same-origin. */
function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === '/health') return jsonResponse({ status: 'ok', service: 'agent-clearing-desk', time: Date.now() });
  if (path === '/.well-known/receipt-signing-key.json') {
    return withCors(jsonResponse({ keys: [await publicSigningKey(env.RECEIPT_SIGNING_KEY)] }));
  }
  if (path === '/mcp') return withCors(await handleMcpRequest(request, env));
  if (path.startsWith('/v1/')) return withCors(await handleProxyRequest(request, env, url));
  if (path.startsWith('/api/admin/')) return handleAdminRequest(request, env, url);
  if (path === '/api/demo/keys') return handleDemoKeyRequest(request, env);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env, new URL(request.url));
    } catch (err) {
      console.error('unhandled', err);
      return jsonResponse({ error: { code: 'internal_error', message: 'Internal error' } }, 500);
    }
  },
};
