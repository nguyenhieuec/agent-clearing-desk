import type { Env } from './types.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleProxyRequest } from './proxy.ts';
import { handleAdminRequest } from './admin.ts';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-api-key, authorization',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      // 1. Health check
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'agent-clearing-desk', time: Date.now() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // 2. Model Context Protocol endpoint
      if (path === '/mcp') {
        const res = await handleMcpRequest(request, env);
        res.headers.set('access-control-allow-origin', '*');
        return res;
      }

      // 3. HTTP Proxy API (/v1/*)
      if (path.startsWith('/v1/')) {
        const res = await handleProxyRequest(request, env, url);
        res.headers.set('access-control-allow-origin', '*');
        return res;
      }

      // 4. Admin UI and Admin REST API
      if (path === '/' || path === '/admin' || path.startsWith('/api/admin/')) {
        const res = await handleAdminRequest(request, env, url);
        res.headers.set('access-control-allow-origin', '*');
        return res;
      }

      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({
          error: {
            code: 'internal_error',
            message: `Internal server error: ${message}`,
          },
        }),
        {
          status: 500,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        }
      );
    }
  },
};
