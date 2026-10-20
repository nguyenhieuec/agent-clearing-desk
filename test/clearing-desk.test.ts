import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import type { Env } from '../src/types.ts';
import { verifyReceiptSignature } from '../src/crypto.ts';
import { createSqliteD1, rawSqlite } from './sqlite-d1.ts';
// @ts-expect-error plain .mjs script without types
import { checkResponse } from '../scripts/verify-receipt.mjs';

const ADMIN = 'test-admin-secret';
const ORIGIN = 'https://desk.test';

async function makeSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}

let env: Env;
let upstreamCalls: { url: string; body: unknown; headers: Record<string, string> }[];
let upstreamMode: 'ok' | 'fail' | 'hang' | 'reject';
/** When set, the next upstream tool call waits for this before it fails with 500. */
let upstreamGate: Promise<void> | undefined;

const CUSTOM_MCP = 'https://mcp.example.test/mcp';
/** A paid MCP server: every request needs its bearer token, and calls need the session from initialize. */
const PAID_MCP = 'https://paid.example.test/mcp';
const PAID_TOKEN = 'Bearer upstream-secret-token';
const CUSTOM_SCHEMA = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

/** The MCP lifecycle and tools/list of the fake custom servers; undefined for a tool call. */
function customServer(url: string, body: { method: string }, h: Record<string, string>): Response | undefined {
  if (url === PAID_MCP && h.authorization !== PAID_TOKEN) return new Response('unauthorized', { status: 401 });
  const session = url === PAID_MCP ? 'sess-paid' : 'sess-free';
  if (body.method === 'initialize') {
    return Response.json({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': session } });
  }
  if (h['mcp-session-id'] !== session) return new Response('no session', { status: 400 });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search', description: 'Search', inputSchema: CUSTOM_SCHEMA }] } });
  }
  return undefined;
}

/** The only fake in this suite: the upstream tool servers. The desk, SQL and crypto are real. */
async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const headers = { ...(init?.headers as Record<string, string>) };
  upstreamCalls.push({ url, body, headers });
  const lifecycle = url === CUSTOM_MCP || url === PAID_MCP ? customServer(url, body, headers) : undefined;
  if (lifecycle) return lifecycle;
  if (upstreamGate) {
    const gate = upstreamGate;
    upstreamGate = undefined;
    await gate;
    return new Response('late boom', { status: 500 });
  }
  if (upstreamMode === 'fail') return Promise.resolve(new Response('boom', { status: 500 }));
  if (upstreamMode === 'reject') return Promise.resolve(new Response('vatNumber is not valid', { status: 422 }));
  if (upstreamMode === 'hang') {
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }
  if (url.endsWith('/run')) return Promise.resolve(Response.json({ ok: true, echo: body }));
  const structuredContent = { tool: body.params.name, args: body.params.arguments };
  return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: { content: [], structuredContent } }));
}

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const request = new Request(`${ORIGIN}${path}`, {
    ...rest,
    method: rest.method ?? (json === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(rest.headers as Record<string, string>) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return worker.fetch(request, env);
}

const admin = { authorization: `Bearer ${ADMIN}` };

async function newOrg(name = 'Acme'): Promise<string> {
  const res = await call('/api/admin/orgs', { headers: admin, json: { name, email: `${name}@example.com` } });
  return ((await res.json()) as { id: string }).id;
}

async function newKey(orgId: string, budgetCents: number, allowlist: string[] = ['*'], budgetPeriod?: string) {
  const res = await call('/api/admin/keys', { headers: admin, json: { orgId, name: 'agent', budgetCents, allowlist, budgetPeriod } });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; key_id: string };
}

/** Tool calls that reached an upstream, without the MCP lifecycle requests. */
const toolCalls = () => upstreamCalls.filter(c => !['initialize', 'notifications/initialized', 'tools/list'].includes((c.body as { method?: string })?.method ?? ''));

const DUTY_ARGS = {
  lines: [{ description: 'cotton t-shirt', origin: 'CN', qty: 3, unit_value_eur: 25 }],
  channel: 'ioss',
};

function runDuty(key: string) {
  return call('/v1/tools/eu_duty_estimate/run', { headers: { 'x-api-key': key }, json: DUTY_ARGS });
}

beforeEach(async () => {
  env = { DB: createSqliteD1(), RECEIPT_SIGNING_KEY: await makeSigningKey(), ADMIN_SECRET: ADMIN, OPENKRILL_API_KEY: 'ok_test' };
  upstreamCalls = [];
  upstreamMode = 'ok';
  upstreamGate = undefined;
  vi.stubGlobal('fetch', vi.fn(fakeUpstream));
});

afterEach(() => vi.unstubAllGlobals());

describe('admin API', () => {
  it('is closed (503) when ADMIN_SECRET is unset', async () => {
    env.ADMIN_SECRET = undefined;
    expect((await call('/api/admin/keys', { headers: admin })).status).toBe(503);
  });

  it('refuses a missing or wrong bearer token', async () => {
    expect((await call('/api/admin/keys')).status).toBe(401);
    expect((await call('/api/admin/keys', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await call('/api/admin/orgs', { json: { name: 'x', email: 'y' } })).status).toBe(401);
  });

  it('never returns key hashes in the key list', async () => {
    await newKey(await newOrg(), 10);
    const body = await (await call('/api/admin/keys', { headers: admin })).text();
    expect(body).not.toContain('key_hash');
  });

  it('rejects an allowlist with an unknown tool', async () => {
    const orgId = await newOrg();
    const res = await call('/api/admin/keys', { headers: admin, json: { orgId, name: 'a', budgetCents: 1, allowlist: ['rm_rf'] } });
    expect(res.status).toBe(400);
  });
});

describe('clearing a call', () => {
  it('charges, forwards the arguments unchanged and signs a receipt that verifies offline', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const res = await runDuty(key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clearing-price-cents')).toBe('1');
    expect(res.headers.get('x-clearing-remaining-budget-cents')).toBe('9');
    expect(upstreamCalls[0].body).toMatchObject({ params: { name: 'eu_duty_estimate', arguments: DUTY_ARGS } });

    const body = (await res.json()) as { receipt: { payload: string; signature: string; unsigned_view: Record<string, unknown> } };
    expect(body.receipt.unsigned_view).toMatchObject({ outcome: 'success', amount_mc: 1000, cost_mc: 500 });
    expect(body.receipt.unsigned_view.result_sha256).toMatch(/^[a-f0-9]{64}$/);

    const jwks = (await (await call('/.well-known/receipt-signing-key.json')).json()) as { keys: { x: string }[] };
    const pub = jwks.keys[0];
    expect(await verifyReceiptSignature(pub, body.receipt.payload, body.receipt.signature)).toBe(true);
    const tampered = body.receipt.payload.replace('"amount_mc":1000', '"amount_mc":1');
    expect(await verifyReceiptSignature(pub, tampered, body.receipt.signature)).toBe(false);
  });

  it('refuses a tool off the allowlist with 403, headers, a receipt and no upstream call', async () => {
    const { key } = await newKey(await newOrg(), 10, ['check_vat_number']);
    const res = await runDuty(key);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-clearing-receipt')).toMatch(/^rcpt_/);
    expect(res.headers.get('x-clearing-price-cents')).toBe('0');
    expect(upstreamCalls).toHaveLength(0);
  });

  it('rejects missing required arguments before any charge', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const res = await call('/v1/tools/check_vat_number/run', { headers: { 'x-api-key': key }, json: { country: 'IE' } });
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('refunds the reservation and signs an upstream_error receipt when the upstream fails', async () => {
    const { key } = await newKey(await newOrg(), 10);
    upstreamMode = 'fail';
    const res = await runDuty(key);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-clearing-remaining-budget-cents')).toBe('10');
    const body = (await res.json()) as { receipt: { unsigned_view: Record<string, unknown> } };
    expect(body.receipt.unsigned_view).toMatchObject({ outcome: 'upstream_error', amount_mc: 0 });
  });

  it('lets exactly one of 20 concurrent calls through on a key with room for one', async () => {
    const { key, key_id } = await newKey(await newOrg(), 1);
    const statuses = (await Promise.all(Array.from({ length: 20 }, () => runDuty(key)))).map(r => r.status);
    expect(statuses.filter(s => s === 200)).toHaveLength(1);
    expect(statuses.filter(s => s === 402)).toHaveLength(19);
    expect(upstreamCalls).toHaveLength(1);
    const row = rawSqlite(env.DB).prepare('SELECT spent_mc FROM agent_keys WHERE key_id = ?').get(key_id) as { spent_mc: number };
    expect(row.spent_mc).toBe(1000);
  });

  it('serves the same clearing over MCP with the key from a header', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const res = await call('/mcp', {
      headers: { 'x-api-key': key },
      json: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'eu_duty_estimate', arguments: DUTY_ARGS } },
    });
    const rpc = (await res.json()) as { result: { isError?: boolean; structuredContent: { clearing: { price_cents: number } } } };
    expect(rpc.result.isError).toBeUndefined();
    expect(rpc.result.structuredContent.clearing.price_cents).toBe(1);
  });
});

describe('offline verifier script', () => {
  async function successDoc() {
    const { key } = await newKey(await newOrg(), 10);
    const doc = (await (await runDuty(key)).json()) as { result: unknown; receipt: { payload: string; unsigned_view: Record<string, unknown> } };
    const jwks = (await (await call('/.well-known/receipt-signing-key.json')).json()) as { keys: unknown[] };
    return { doc, pub: jwks.keys[0] };
  }

  it('passes a real response and checks the arguments that were sent', async () => {
    const { doc, pub } = await successDoc();
    const out = await checkResponse(doc, pub, DUTY_ARGS);
    expect(out.valid).toBe(true);
    expect(out.checks).toEqual({ signature: true, result_hash: true, input_hash: true, unsigned_view: true });
  });

  it('fails a response whose result, readable copy or claimed input was changed', async () => {
    const { doc, pub } = await successDoc();
    expect((await checkResponse({ ...doc, result: { forged: true } }, pub)).checks.result_hash).toBe(false);
    const view = { ...doc.receipt.unsigned_view, amount_mc: 1 };
    expect((await checkResponse({ ...doc, receipt: { ...doc.receipt, unsigned_view: view } }, pub)).valid).toBe(false);
    expect((await checkResponse(doc, pub, { ...DUTY_ARGS, channel: 'post' })).checks.input_hash).toBe(false);
  });
});

describe('budget periods', () => {
  afterEach(() => vi.useRealTimers());

  it('starts a daily budget from 0 on the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 21, 23, 0) });
    const { key } = await newKey(await newOrg(), 1, ['*'], 'daily');
    expect((await runDuty(key)).status).toBe(200);
    expect((await runDuty(key)).status).toBe(402);
    vi.setSystemTime(Date.UTC(2026, 9, 22, 0, 1));
    const res = await runDuty(key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: { resets_at: string } };
    expect(body.balance.resets_at).toBe('2026-10-23T00:00:00.000Z');
  });

  it('keeps a monthly budget spent for the rest of the month', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 1) });
    const { key } = await newKey(await newOrg(), 1, ['*'], 'monthly');
    expect((await runDuty(key)).status).toBe(200);
    vi.setSystemTime(Date.UTC(2026, 9, 31, 23, 59));
    expect((await runDuty(key)).status).toBe(402);
    vi.setSystemTime(Date.UTC(2026, 10, 1));
    expect((await runDuty(key)).status).toBe(200);
  });

  it('rejects an unknown period', async () => {
    const orgId = await newOrg();
    const res = await call('/api/admin/keys', { headers: admin, json: { orgId, name: 'a', budgetCents: 1, budgetPeriod: 'hourly' } });
    expect(res.status).toBe(400);
  });
});

describe('operator-added MCP tools', () => {
  const tool = { name: 'web_search', mcpUrl: CUSTOM_MCP, upstreamTool: 'search', costCents: 0.5, priceCents: 1, timeoutMs: 1000 };

  it('adds a tool from its own tools/list, clears a call through it and stops it once disabled', async () => {
    const created = await call('/api/admin/tools', { headers: admin, json: tool });
    expect(created.status).toBe(201);
    const { key } = await newKey(await newOrg(), 10, ['web_search']);
    const list = (await (await call('/mcp', { headers: { 'x-api-key': key }, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(list.result.tools.find(t => t.name === 'web_search')?.inputSchema).toEqual(CUSTOM_SCHEMA);

    const run = (args: unknown) => call('/v1/tools/web_search/run', { headers: { 'x-api-key': key }, json: args });
    expect((await run({})).status).toBe(400);
    const ok = await run({ q: 'agent budgets' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-clearing-price-cents')).toBe('1');
    expect(toolCalls().at(-1)).toMatchObject({
      url: CUSTOM_MCP,
      body: { params: { name: 'search', arguments: { q: 'agent budgets' } } },
      headers: { 'mcp-session-id': 'sess-free' },
    });

    expect((await call('/api/admin/tools/web_search/disable', { method: 'POST', headers: admin })).status).toBe(200);
    expect((await run({ q: 'again' })).status).toBe(404);
  });

  it('refuses a plain http URL, a bad name, a clash with a built-in tool and a tool the server does not list', async () => {
    const post = (json: unknown) => call('/api/admin/tools', { headers: admin, json });
    expect((await post({ ...tool, mcpUrl: 'http://mcp.example.test/mcp' })).status).toBe(400);
    expect((await post({ ...tool, name: 'Bad-Name' })).status).toBe(400);
    expect((await post({ ...tool, name: 'eu_duty_estimate' })).status).toBe(400);
    expect((await post({ ...tool, upstreamTool: 'missing' })).status).toBe(400);
  });

  it('answers 504 and refunds the price when the upstream is slower than the tool timeout', async () => {
    await call('/api/admin/tools', { headers: admin, json: tool });
    const { key } = await newKey(await newOrg(), 10);
    upstreamMode = 'hang';
    const res = await call('/v1/tools/web_search/run', { headers: { 'x-api-key': key }, json: { q: 'slow' } });
    expect(res.status).toBe(504);
    expect(res.headers.get('x-clearing-remaining-budget-cents')).toBe('10');
  });
});

describe('keys and tenants', () => {
  it('stops the old secret at once after a self-rotation', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const rotated = (await (await call('/v1/key/rotate', { method: 'POST', headers: { 'x-api-key': key } })).json()) as { key: string };
    expect((await runDuty(key)).status).toBe(401);
    expect((await runDuty(rotated.key)).status).toBe(200);
  });

  it('refuses a revoked key', async () => {
    const { key, key_id } = await newKey(await newOrg(), 10);
    await call(`/api/admin/keys/${key_id}/revoke`, { method: 'POST', headers: admin });
    expect((await runDuty(key)).status).toBe(403);
  });

  it('hides a receipt from a key of another organization', async () => {
    const a = await newKey(await newOrg('A'), 10);
    const b = await newKey(await newOrg('B'), 10);
    const receiptId = (await runDuty(a.key)).headers.get('x-clearing-receipt');
    expect((await call(`/v1/receipts/${receiptId}`, { headers: { 'x-api-key': a.key } })).status).toBe(200);
    expect((await call(`/v1/receipts/${receiptId}`, { headers: { 'x-api-key': b.key } })).status).toBe(404);
  });
});

describe('public sandbox', () => {
  it('mints a fixed 2 cent, 2-tool key and stops at the daily cap', async () => {
    env.DEMO_DAILY_KEY_LIMIT = '2';
    const first = (await (await call('/api/demo/keys', { method: 'POST' })).json()) as {
      budget_cents: number;
      allowlist: string[];
    };
    expect(first.budget_cents).toBe(2);
    expect(first.allowlist).toEqual(['eu_duty_estimate', 'check_vat_number']);
    expect((await call('/api/demo/keys', { method: 'POST' })).status).toBe(201);
    expect((await call('/api/demo/keys', { method: 'POST' })).status).toBe(429);
  });

  it('puts every sandbox key in its own organization', async () => {
    const mint = async () => (await (await call('/api/demo/keys', { method: 'POST' })).json()) as { key: string; org_id: string };
    const a = await mint();
    const b = await mint();
    expect(a.org_id).not.toBe(b.org_id);
    const receiptId = (await runDuty(a.key)).headers.get('x-clearing-receipt');
    expect((await call(`/v1/receipts/${receiptId}`, { headers: { 'x-api-key': b.key } })).status).toBe(404);
  });
});

describe('ledger integrity', () => {
  it('refuses to change or delete audit rows and receipts', async () => {
    const { key } = await newKey(await newOrg(), 10);
    await runDuty(key);
    const db = rawSqlite(env.DB);
    expect(() => db.exec("UPDATE receipts SET signature = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit_logs')).toThrow(/append-only/);
  });

  it('cannot record spend above the budget even outside the reservation path', async () => {
    const { key_id } = await newKey(await newOrg(), 1);
    const db = rawSqlite(env.DB);
    expect(() => db.prepare('UPDATE agent_keys SET spent_mc = 1001 WHERE key_id = ?').run(key_id)).toThrow(/CHECK/);
  });
});

describe('free traffic and late refunds', () => {
  afterEach(() => vi.useRealTimers());

  it('refuses arguments that break the tool schema before any reservation or upstream call', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const res = await call('/v1/tools/check_vat_number/run', { headers: { 'x-api-key': key }, json: { country: 'IE', vatNumber: '1', extra: 1 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; problems: string[] } };
    expect(body.error.code).toBe('invalid_arguments');
    expect(body.error.problems).toEqual(['arguments.vatNumber must have at least 2 characters', 'arguments.extra is not an allowed argument']);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('answers 400, not 502, when the upstream rejects the arguments, and charges nothing', async () => {
    const { key } = await newKey(await newOrg(), 10);
    upstreamMode = 'reject';
    const res = await runDuty(key);
    expect(res.status).toBe(400);
    expect(res.headers.get('x-clearing-remaining-budget-cents')).toBe('10');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_arguments');
  });

  it('stops a key with 429 after too many failed calls in one hour, without calling the upstream', async () => {
    env.FAILED_CALLS_PER_HOUR = '2';
    const { key } = await newKey(await newOrg(), 10);
    upstreamMode = 'fail';
    expect((await runDuty(key)).status).toBe(502);
    expect((await runDuty(key)).status).toBe(502);
    const third = await runDuty(key);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('too_many_failed_calls');
    expect(upstreamCalls).toHaveLength(2);
  });

  it('does not refund yesterday\'s reservation into today\'s daily budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 21, 23, 59, 59) });
    const { key } = await newKey(await newOrg(), 1, ['*'], 'daily');
    let release!: () => void;
    upstreamGate = new Promise(resolve => (release = resolve));
    const lateFailure = runDuty(key);
    while (upstreamCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    vi.setSystemTime(Date.UTC(2026, 9, 22, 0, 0, 1));
    expect((await runDuty(key)).status).toBe(200);
    release();
    expect((await lateFailure).status).toBe(502);
    expect((await runDuty(key)).status).toBe(402);
  });
});

describe('proof of the input and the answer', () => {
  async function pubKey() {
    return ((await (await call('/.well-known/receipt-signing-key.json')).json()) as { keys: unknown[] }).keys[0];
  }

  it('hashes canonical JSON, so the same arguments in another key order still prove the input', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const doc = await (await runDuty(key)).json();
    const reordered = { channel: 'ioss', lines: [{ unit_value_eur: 25, qty: 3, origin: 'CN', description: 'cotton t-shirt' }] };
    const out = await checkResponse(doc, await pubKey(), reordered);
    expect(out.checks.input_hash).toBe(true);
    expect(out.signed.v).toBe('cd-receipt-v4');
  });

  it('says a success receipt without its result proves the charge but not the answer', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const doc = (await (await runDuty(key)).json()) as { receipt: unknown };
    const out = await checkResponse({ receipt: doc.receipt }, await pubKey());
    expect(out.valid).toBe(true);
    expect(out.proves_answer).toBe(false);
    expect(out.checks.result_hash).toMatch(/not checked/);
  });

  it('puts the whole signed receipt in an MCP tools/call result, and it verifies with the answer', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const rpc = (await (await call('/mcp', {
      headers: { 'x-api-key': key },
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eu_duty_estimate', arguments: DUTY_ARGS } },
    })).json()) as { result: { structuredContent: { clearing: { receipt_id: string } } } };
    const out = await checkResponse(rpc.result, await pubKey(), DUTY_ARGS);
    expect(out).toMatchObject({ valid: true, proves_answer: true });
    expect(out.checks).toEqual({ signature: true, result_hash: true, input_hash: true, unsigned_view: true });

    const fetched = (await (await call('/mcp', {
      headers: { 'x-api-key': key },
      json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_call_receipt', arguments: { receipt_id: rpc.result.structuredContent.clearing.receipt_id } } },
    })).json()) as { result: { structuredContent: { signature_valid: boolean } } };
    expect(fetched.result.structuredContent.signature_valid).toBe(true);
  });

  it('shows the list price in every governed tool description in tools/list', async () => {
    const { key } = await newKey(await newOrg(), 10);
    const list = (await (await call('/mcp', { headers: { 'x-api-key': key }, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(list.result.tools.find(t => t.name === 'eu_duty_estimate')?.description).toContain('Price per successful call, in US cents: 1. Failed calls are free.');
  });
});

describe('paid MCP servers added at run time', () => {
  const paid = {
    name: 'paid_search', mcpUrl: PAID_MCP, upstreamTool: 'search', costCents: 0.5, priceCents: 1, timeoutMs: 1000,
    authHeader: { name: 'authorization', value: PAID_TOKEN },
  };

  beforeEach(() => {
    env.UPSTREAM_SECRET_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  });

  it('seals the credential, never shows it, and sends it with the MCP session on each call', async () => {
    expect((await call('/api/admin/tools', { headers: admin, json: paid })).status).toBe(201);
    const listed = await (await call('/api/admin/tools', { headers: admin })).text();
    expect(listed).not.toContain('upstream-secret-token');
    expect(listed).toContain('authorization header, sealed');
    const row = rawSqlite(env.DB).prepare('SELECT auth_header_sealed FROM custom_tools').get() as { auth_header_sealed: string };
    expect(row.auth_header_sealed).not.toContain('upstream-secret-token');

    const { key } = await newKey(await newOrg(), 10, ['paid_search']);
    const res = await call('/v1/tools/paid_search/run', { headers: { 'x-api-key': key }, json: { q: 'agent budgets' } });
    expect(res.status).toBe(200);
    expect(toolCalls().at(-1)?.headers).toMatchObject({ authorization: PAID_TOKEN, 'mcp-session-id': 'sess-paid' });
  });

  it('refuses a credential when the desk has no key to seal it, and a server that refuses the credential', async () => {
    const post = (json: unknown) => call('/api/admin/tools', { headers: admin, json });
    expect((await post({ ...paid, authHeader: { name: 'authorization', value: 'Bearer wrong' } })).status).toBe(400);
    expect((await post({ ...paid, authHeader: { name: 'cookie', value: 'x' } })).status).toBe(400);
    env.UPSTREAM_SECRET_KEY = undefined;
    const res = await post(paid);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('UPSTREAM_SECRET_KEY');
  });
});
