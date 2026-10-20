import type { ReceiptPayload } from './types.ts';

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison for bearer secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * New agent key: cd_live_<48 hex>. Only its SHA-256 is stored; key_id is a random
 * handle, so it reveals nothing about the secret and survives rotation.
 */
export async function generateAgentKeyCredentials(): Promise<{
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const rawKey = `cd_live_${randomHex(24)}`;
  return {
    rawKey,
    keyHash: await sha256Hex(rawKey),
    keyPrefix: `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`,
  };
}

export interface PublicSigningKey {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

interface LoadedSigningKey {
  privateKey: CryptoKey;
  publicJwk: PublicSigningKey;
}

let cached: { secret: string; loaded: Promise<LoadedSigningKey> } | null = null;

async function loadSigningKey(secret: string): Promise<LoadedSigningKey> {
  const jwk = JSON.parse(secret) as JsonWebKey & { x: string };
  // Import only the key material: Node exports alg "Ed25519", which workerd rejects (it wants "EdDSA").
  const material = { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d };
  const privateKey = await crypto.subtle.importKey('jwk', material, { name: 'Ed25519' }, false, ['sign']);
  const kid = (await sha256Hex(jwk.x)).slice(0, 16);
  return {
    privateKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' },
  };
}

function signingKey(secret: string): Promise<LoadedSigningKey> {
  if (!cached || cached.secret !== secret) {
    cached = { secret, loaded: loadSigningKey(secret) };
  }
  return cached.loaded;
}

export async function publicSigningKey(secret: string): Promise<PublicSigningKey> {
  return (await signingKey(secret)).publicJwk;
}

/** Fixed key order, so the same receipt always serialises to the same bytes. */
export function canonicalReceiptPayload(p: ReceiptPayload): string {
  return JSON.stringify({
    v: p.v,
    receipt_id: p.receipt_id,
    audit_log_id: p.audit_log_id,
    org_id: p.org_id,
    key_id: p.key_id,
    tool: p.tool,
    upstream: p.upstream,
    protocol: p.protocol,
    outcome: p.outcome,
    http_status: p.http_status,
    amount_mc: p.amount_mc,
    cost_mc: p.cost_mc,
    currency: p.currency,
    params_sha256: p.params_sha256,
    result_sha256: p.result_sha256,
    issued_at: p.issued_at,
  });
}

export async function signReceiptPayload(
  secret: string,
  payload: string
): Promise<{ signature: string; kid: string }> {
  const key = await signingKey(secret);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, encoder.encode(payload));
  return { signature: toBase64Url(sig), kid: key.publicJwk.kid };
}

/**
 * Verify with only the public key. This is the same check an auditor runs offline
 * (scripts/verify-receipt.mjs or the browser console), with no call to the desk.
 */
export async function verifyReceiptSignature(
  publicJwk: Pick<PublicSigningKey, 'x'>,
  payload: string,
  signature: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signature), encoder.encode(payload));
}
