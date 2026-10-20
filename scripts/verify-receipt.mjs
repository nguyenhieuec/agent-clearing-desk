#!/usr/bin/env node
/**
 * Verify an Agent Clearing Desk receipt offline with only the public key.
 *
 *   node scripts/verify-receipt.mjs receipt.json [public-key.json]
 *
 * receipt.json is the `receipt` object from any clearing response ({payload, signature, ...}).
 * Without a key file the public key is fetched once from the desk's /.well-known URL;
 * after that, the check needs nothing from the desk.
 */
import fs from 'node:fs';

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

async function loadPublicKey(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8')).keys?.[0] ?? JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${BASE_URL}/.well-known/receipt-signing-key.json`);
  return (await res.json()).keys[0];
}

async function main() {
  const [receiptFile, keyFile] = process.argv.slice(2);
  if (!receiptFile) {
    console.error('usage: node scripts/verify-receipt.mjs receipt.json [public-key.json]');
    process.exit(2);
  }
  const doc = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const receipt = doc.receipt ?? doc;
  const ok = await verifyReceipt(receipt, await loadPublicKey(keyFile));
  const fields = JSON.parse(receipt.payload);
  console.log(JSON.stringify({ valid: ok, receipt_id: fields.receipt_id, outcome: fields.outcome, amount_mc: fields.amount_mc }));
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
