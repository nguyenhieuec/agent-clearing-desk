#!/usr/bin/env node
/**
 * Verify an Agent Clearing Desk receipt offline with only the public key.
 *
 *   node scripts/verify-receipt.mjs response.json [public-key.json] [--input args.json]
 *
 * response.json is a whole clearing response ({result, receipt, ...}), an MCP tools/call
 * result (structuredContent with result and clearing.receipt), or just a `receipt`.
 * Only the signed `payload` bytes count. The script checks:
 * - the Ed25519 signature over payload;
 * - when the response has a `result`, that its SHA-256 is the signed result_sha256
 *   (a success receipt with no result is reported as "not checked": it proves the charge, not the answer);
 * - with --input, that the SHA-256 of the arguments you sent is the signed params_sha256;
 * - that the readable unsigned_view copy says the same as the signed payload.
 * Without a key file the public key is fetched once from the desk's /.well-known URL;
 * after that, the check needs nothing from the desk.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const BASE_URL = process.env.CLEARING_DESK_URL || 'https://agent-clearing-desk.nguyenhieuec.workers.dev';

function fromBase64Url(text) {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function verifyReceipt(receipt, publicJwk) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    fromBase64Url(receipt.signature),
    new TextEncoder().encode(receipt.payload)
  );
}

/** JSON with object keys sorted at every level, as the desk hashes it (src/crypto.ts canonicalJson). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Receipts before v4 hashed plain JSON.stringify; v4 and later hash canonical JSON. */
function hasher(signed) {
  const serialise = signed.v === 'cd-receipt-v3' ? JSON.stringify : canonicalJson;
  return value => createHash('sha256').update(serialise(value)).digest('hex');
}

/** The receipt and the result, from a REST response, an MCP structuredContent, or a bare receipt. */
function unwrap(doc) {
  const sc = doc.structuredContent ?? doc;
  return { receipt: sc.receipt ?? sc.clearing?.receipt ?? sc, hasResult: 'result' in sc, result: sc.result };
}

/** Every check that applies to this response; the receipt is valid only if all of them pass. */
export async function checkResponse(doc, publicJwk, input) {
  const { receipt, hasResult, result } = unwrap(doc);
  const signed = JSON.parse(receipt.payload);
  const sha256 = hasher(signed);
  const checks = { signature: await verifyReceipt(receipt, publicJwk) };
  if (hasResult) checks.result_hash = signed.result_sha256 === sha256(result);
  else if (signed.outcome === 'success') checks.result_hash = 'not checked: no result in the file';
  if (input !== undefined) checks.input_hash = signed.params_sha256 === sha256(input);
  if (receipt.unsigned_view) checks.unsigned_view = isDeepStrictEqual(receipt.unsigned_view, signed);
  const valid = Object.values(checks).every(c => c === true || typeof c === 'string');
  return { valid, proves_answer: checks.result_hash === true, checks, signed };
}

async function loadPublicKey(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8')).keys?.[0] ?? JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${BASE_URL}/.well-known/receipt-signing-key.json`);
  return (await res.json()).keys[0];
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--input');
  const inputFile = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const [responseFile, keyFile] = args;
  if (!responseFile) {
    console.error('usage: node scripts/verify-receipt.mjs response.json [public-key.json] [--input args.json]');
    process.exit(2);
  }
  const { valid, proves_answer, checks, signed } = await checkResponse(
    readJson(responseFile),
    await loadPublicKey(keyFile),
    inputFile ? readJson(inputFile) : undefined
  );
  const { receipt_id, tool, outcome, amount_mc, cost_mc } = signed;
  console.log(JSON.stringify({ valid, proves_answer, checks, signed: { receipt_id, tool, outcome, amount_mc, cost_mc } }));
  process.exit(valid ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
