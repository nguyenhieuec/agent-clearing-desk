import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import type { Env } from '../src/types.ts';
import { verifyReceiptSignature } from '../src/crypto.ts';
import { createSqliteD1, rawSqlite } from './sqlite-d1.ts';

const ADMIN = 'test-admin-secret';
const ORIGIN = 'https://desk.test';

async function makeSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}

let env: Env;
let upstreamCalls: { url: string; body: unknown }[];
let upstreamMode: 'ok' | 'fail';

/** The only fake in this suite: the upstream tool servers. The desk, SQL and crypto are real. */
function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  upstreamCalls.push({ url, body });
  if (upstreamMode === 'fail') return Promise.resolve(new Response('boom', { status: 500 }));
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

async function newKey(orgId: string, budgetCents: number, allowlist: string[] = ['*']) {
  const res = await call('/api/admin/keys', { headers: admin, json: { orgId, name: 'agent', budgetCents, allowlist } });
  expect(res.status).toBe(201);
  return (await res.json()) as { key: string; key_id: string };
}

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

    const body = (await res.json()) as { receipt: { payload: string; signature: string; fields: Record<string, unknown> } };
    expect(body.receipt.fields).toMatchObject({ outcome: 'success', amount_mc: 1000, cost_mc: 500 });
    expect(body.receipt.fields.result_sha256).toMatch(/^[a-f0-9]{64}$/);

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
    const body = (await res.json()) as { receipt: { fields: Record<string, unknown> } };
    expect(body.receipt.fields).toMatchObject({ outcome: 'upstream_error', amount_mc: 0 });
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
