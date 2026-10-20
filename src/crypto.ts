import type { Receipt } from './types.ts';

/**
 * Compute SHA-256 hex digest of a string using Web Crypto API.
 */
export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random hex string of given byte length.
 */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a new agent key secret and associated identifiers.
 * Raw key format: cd_live_<48 hex chars>
 */
export async function generateAgentKeyCredentials(): Promise<{
  rawKey: string;
  keyHash: string;
  keyId: string;
  keyPrefix: string;
}> {
  const secretPart = randomHex(24);
  const rawKey = `cd_live_${secretPart}`;
  const keyHash = await sha256Hex(rawKey);
  const keyId = `key_${keyHash.slice(0, 16)}`;
  const keyPrefix = `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`;
  return { rawKey, keyHash, keyId, keyPrefix };
}

/**
 * Generate a unique receipt identifier.
 */
export function generateReceiptId(): string {
  return `rcpt_${randomHex(12)}`;
}

/**
 * Generate a unique audit log identifier.
 */
export function generateAuditLogId(): string {
  return `aud_${randomHex(12)}`;
}

/**
 * Generate a unique organization identifier.
 */
export function generateOrgId(): string {
  return `org_${randomHex(8)}`;
}

export interface ReceiptFields {
  receiptId: string;
  auditLogId: string;
  keyId: string;
  orgId: string;
  toolName: string;
  amountCents: number;
  currency: string;
  issuedAt: number;
}

async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign a receipt with HMAC-SHA256 over its canonical fields. The key lives only in
 * the Worker secret, so a party holding the D1 rows alone cannot forge a receipt.
 */
export async function computeReceiptHash(signingKey: string, fields: ReceiptFields): Promise<string> {
  const canonical = [
    fields.receiptId,
    fields.auditLogId,
    fields.keyId,
    fields.orgId,
    fields.toolName,
    fields.amountCents.toString(),
    fields.currency,
    fields.issuedAt.toString(),
  ].join('|');
  return hmacSha256Hex(signingKey, `desk-receipt:v2:${canonical}`);
}

/**
 * Verify whether a receipt's signature matches its contents.
 */
export async function verifyReceipt(receipt: Receipt, signingKey: string): Promise<boolean> {
  const expectedHash = await computeReceiptHash(signingKey, {
    receiptId: receipt.id,
    auditLogId: receipt.audit_log_id,
    keyId: receipt.key_id,
    orgId: receipt.org_id,
    toolName: receipt.tool_name,
    amountCents: receipt.amount_cents,
    currency: receipt.currency,
    issuedAt: receipt.issued_at,
  });
  return receipt.receipt_hash === expectedHash;
}
