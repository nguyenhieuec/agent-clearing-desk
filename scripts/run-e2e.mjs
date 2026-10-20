#!/usr/bin/env node
/**
 * Live end-to-end run against the deployed desk, with real upstream calls.
 *
 *   node scripts/run-e2e.mjs [output.json]
 *   agent-vault run --env ADMIN_SECRET=galuxium-clearing-desk-admin -- node scripts/run-e2e.mjs out.json
 *
 * Without ADMIN_SECRET only the public sandbox flow runs (what a judge can repeat).
 * With it, the operator flow also runs: tenants, a concurrency burst, DeepWiki, rotation, revoke,
 * a daily budget, and a tool added at run time from a public MCP server.
 */
import fs from 'node:fs';
import { checkResponse, verifyReceipt } from './verify-receipt.mjs';

const BASE_URL = process.env.CLEARING_DESK_URL || 'https://agent-clearing-desk.nguyenhieuec.workers.dev';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const DUTY_ARGS = {
  lines: [{ description: 'cotton t-shirt', origin: 'CN', qty: 3, unit_value_eur: 25 }],
  channel: 'ioss',
};
const VAT_ARGS = { country: 'IE', vatNumber: '6388047V' };

const steps = [];
let publicKey;

async function request(path, { method = 'GET', headers = {}, json } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: json === undefined ? method : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  const clearing = Object.fromEntries([...res.headers].filter(([k]) => k.startsWith('x-clearing-')));
  return { status: res.status, ms: Date.now() - started, headers: clearing, body };
}

function check(name, res, expectStatus, extra = true) {
  const pass = res.status === expectStatus && extra;
  steps.push({ step: name, pass, status: res.status, expected: expectStatus, ms: res.ms, headers: res.headers, body: trim(res.body) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${res.status} (${res.ms} ms)`);
  return res;
}

/** Keep the saved output readable: long upstream answers are cut, receipts kept whole. */
function trim(body) {
  if (!body || typeof body !== 'object' || !('result' in body)) return body;
  return { ...body, result: JSON.stringify(body.result).slice(0, 400) };
}

const asKey = key => ({ 'x-api-key': key });
const run = (key, tool, args) => request(`/v1/tools/${tool}/run`, { headers: asKey(key), json: args });
const admin = (path, json) => request(path, { headers: { authorization: `Bearer ${ADMIN_SECRET}` }, json });

async function verifyAll(label, receipts) {
  const results = [];
  for (const r of receipts) {
    const tampered = { ...r, payload: r.payload.replace(/"amount_mc":\d+/, '"amount_mc":999999') };
    results.push({ id: r.receipt_id, valid: await verifyReceipt(r, publicKey), tampered_valid: await verifyReceipt(tampered, publicKey) });
  }
  const pass = results.length > 0 && results.every(r => r.valid && !r.tampered_valid);
  steps.push({ step: label, pass, results });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${results.length} receipts`);
}

async function publicChecks() {
  check('health', await request('/health'), 200);
  const jwks = check('public signing key', await request('/.well-known/receipt-signing-key.json'), 200);
  publicKey = jwks.body.keys[0];
  check('admin API refuses a request without a token', await request('/api/admin/keys'), 401);
}

async function sandboxFlow() {
  const minted = check('sandbox: mint key (2 cents, 2 tools, 60 min)', await request('/api/demo/keys', { method: 'POST' }), 201);
  const key = minted.body.key;
  const receipts = [];
  const take = res => res.body.receipt && receipts.push(res.body.receipt);
  take(check('sandbox: eu_duty_estimate is cleared and charged 1 cent', await run(key, 'eu_duty_estimate', DUTY_ARGS), 200));
  const refused = await run(key, 'get_app_reviews', { apps: ['com.spotify.music'] });
  take(check('sandbox: get_app_reviews is off the allowlist', refused, 403, Boolean(refused.headers['x-clearing-receipt'])));
  take(check('sandbox: check_vat_number is cleared', await run(key, 'check_vat_number', VAT_ARGS), 200));
  take(check('sandbox: third paid call is refused, budget spent', await run(key, 'eu_duty_estimate', DUTY_ARGS), 402));
  const usage = check('sandbox: usage shows 2 cents spent', await request('/v1/usage', { headers: asKey(key) }), 200);
  steps.at(-1).pass &&= usage.body.spent_cents === 2;
  await verifyAll('sandbox: every receipt verifies offline, a tampered copy does not', receipts);
}

async function operatorKey(orgId, budgetCents, allowlist) {
  const res = await admin('/api/admin/keys', { orgId, name: `e2e-${budgetCents}c`, budgetCents, allowlist });
  return res.body;
}

async function concurrencyBurst(orgId) {
  const { key } = await operatorKey(orgId, 1, ['eu_duty_estimate']);
  const burst = await Promise.all(Array.from({ length: 10 }, () => run(key, 'eu_duty_estimate', DUTY_ARGS)));
  const codes = burst.map(r => r.status);
  const pass = codes.filter(c => c === 200).length === 1 && codes.filter(c => c === 402).length === 9;
  steps.push({ step: 'operator: 10 concurrent calls on a 1-cent key, exactly 1 cleared', pass, statuses: codes });
  console.log(`${pass ? 'PASS' : 'FAIL'} concurrency burst: ${codes.join(',')}`);
}

async function rotationAndRevoke(orgId) {
  const { key, key_id } = await operatorKey(orgId, 5, ['check_vat_number']);
  const rotated = check('operator: agent rotates its own key', await request('/v1/key/rotate', { method: 'POST', headers: asKey(key) }), 200);
  check('operator: old key stops at once', await run(key, 'check_vat_number', VAT_ARGS), 401);
  check('operator: new key works', await run(rotated.body.key, 'check_vat_number', VAT_ARGS), 200);
  check('operator: revoke key', await admin(`/api/admin/keys/${key_id}/revoke`, {}), 200);
  check('operator: revoked key is refused', await run(rotated.body.key, 'check_vat_number', VAT_ARGS), 403);
}

async function mcpFlow(key) {
  const rpc = (id, method, params) => request('/mcp', { headers: asKey(key), json: { jsonrpc: '2.0', id, method, params } });
  check('mcp: initialize', await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }), 200);
  const list = check('mcp: tools/list', await rpc(2, 'tools/list', {}), 200);
  steps.at(-1).pass &&= list.body.result.tools.length >= 9;
  const bal = check('mcp: check_agent_balance', await rpc(3, 'tools/call', { name: 'check_agent_balance', arguments: {} }), 200);
  steps.at(-1).pass &&= typeof bal.body.result.structuredContent.remaining_cents === 'number';
}

/** The full offline check a third party runs: signature, result hash, input hash, readable copy. */
function proveAnswer(label, res, args) {
  return checkResponse(res.body, publicKey, args).then(({ valid, checks }) => {
    steps.push({ step: label, pass: valid, checks });
    console.log(`${valid ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(checks)}`);
  });
}

async function customToolFlow(orgId) {
  const name = `e2e_topics_${Date.now().toString(36)}`;
  const tool = { name, mcpUrl: 'https://mcp.deepwiki.com/mcp', upstreamTool: 'read_wiki_structure', costCents: 0, priceCents: 0.5 };
  check('operator: add a tool from a public MCP server at run time', await admin('/api/admin/tools', tool), 201);
  const { key } = (await admin('/api/admin/keys', { orgId, name: 'e2e-daily', budgetCents: 1, allowlist: [name], budgetPeriod: 'daily' })).body;
  const args = { repoName: 'cloudflare/workerd' };
  const first = check('operator: the added tool is cleared on a daily 1-cent key', await run(key, name, args), 200);
  steps.at(-1).pass &&= first.body.balance?.budget_period === 'daily' && typeof first.body.balance?.resets_at === 'string';
  await proveAnswer('operator: verifier proves the answer and the input of the added tool', first, args);
  check('operator: second call fits, third is refused for today', (await run(key, name, args), await run(key, name, args)), 402);
  check('operator: disable the added tool', await admin(`/api/admin/tools/${name}/disable`, {}), 200);
  check('operator: a disabled tool is unknown', await run(key, name, args), 404);
}

async function operatorFlow() {
  if (!ADMIN_SECRET) return console.log('SKIP operator flow: ADMIN_SECRET not set');
  const orgA = (await admin('/api/admin/orgs', { name: 'E2E Org A', email: 'a@e2e.invalid' })).body.id;
  const orgB = (await admin('/api/admin/orgs', { name: 'E2E Org B', email: 'b@e2e.invalid' })).body.id;
  const a = await operatorKey(orgA, 5, ['eu_duty_estimate', 'ask_repo_question']);
  const b = await operatorKey(orgB, 5, ['eu_duty_estimate']);

  const wiki = await run(a.key, 'ask_repo_question', { repoName: 'cloudflare/workers-sdk', question: 'How does wrangler apply D1 migrations?' });
  check('operator: ask_repo_question is cleared through the DeepWiki upstream', wiki, 200, (wiki.body.receipt ? JSON.parse(wiki.body.receipt.payload).upstream : null) === 'deepwiki');
  const receiptId = wiki.headers['x-clearing-receipt'];
  check('tenant: org A reads its receipt', await request(`/v1/receipts/${receiptId}`, { headers: asKey(a.key) }), 200);
  check('tenant: org B cannot read org A receipt', await request(`/v1/receipts/${receiptId}`, { headers: asKey(b.key) }), 404);
  await verifyAll('operator: DeepWiki receipt verifies offline', [wiki.body.receipt]);
  await proveAnswer('operator: verifier proves the DeepWiki answer and input', wiki, {
    repoName: 'cloudflare/workers-sdk',
    question: 'How does wrangler apply D1 migrations?',
  });

  await concurrencyBurst(orgA);
  await rotationAndRevoke(orgA);
  await mcpFlow(b.key);
  await customToolFlow(orgA);
  check('operator: overview', await admin('/api/admin/overview'), 200);
}

async function main() {
  const out = process.argv[2];
  const started = new Date().toISOString();
  await publicChecks();
  await sandboxFlow();
  await operatorFlow();
  const failed = steps.filter(s => !s.pass).length;
  const report = { base_url: BASE_URL, started, finished: new Date().toISOString(), passed: steps.length - failed, failed, steps };
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${steps.length - failed}/${steps.length} passed`);
  process.exit(failed ? 1 : 0);
}

await main();
