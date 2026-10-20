#!/usr/bin/env node
/**
 * Verify an Agent Clearing Desk receipt offline with only the public key.
 *
 *   node scripts/verify-receipt.mjs response.json [public-key.json] [--input args.json]
 *
 * response.json is a whole clearing response ({result, receipt, ...}) or just its `receipt`.
 * Only the signed `payload` bytes count. The script checks:
 * - the Ed25519 signature over payload;
 * - when the response has a `result`, that its SHA-256 is the signed result_sha256;
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

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Every check that applies to this response; the receipt is valid only if all pass. */
export async function checkResponse(doc, publicJwk, input) {
  const receipt = doc.receipt ?? doc;
  const signed = JSON.parse(receipt.payload);
  const checks = { signature: await verifyReceipt(receipt, publicJwk) };
  if ('result' in doc) checks.result_hash = signed.result_sha256 === sha256(doc.result);
  if (input !== undefined) checks.input_hash = signed.params_sha256 === sha256(input);
  if (receipt.unsigned_view) checks.unsigned_view = isDeepStrictEqual(receipt.unsigned_view, signed);
  return { valid: Object.values(checks).every(Boolean), checks, signed };
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
  const { valid, checks, signed } = await checkResponse(
    readJson(responseFile),
    await loadPublicKey(keyFile),
    inputFile ? readJson(inputFile) : undefined
  );
  const { receipt_id, tool, outcome, amount_mc, cost_mc } = signed;
  console.log(JSON.stringify({ valid, checks, signed: { receipt_id, tool, outcome, amount_mc, cost_mc } }));
  process.exit(valid ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
