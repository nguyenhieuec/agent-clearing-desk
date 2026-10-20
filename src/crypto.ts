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

/**
 * Sign a receipt with a deterministic SHA-256 digest of its canonical fields.
 */
export async function computeReceiptHash(fields: {
  receiptId: string;
  auditLogId: string;
  keyId: string;
  orgId: string;
  toolName: string;
  amountCents: number;
  currency: string;
  issuedAt: number;
}): Promise<string> {
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
  return sha256Hex(`desk-receipt:v1:${canonical}`);
}

/**
 * Verify whether a receipt's hash matches its contents.
 */
export async function verifyReceipt(receipt: Receipt): Promise<boolean> {
  const expectedHash = await computeReceiptHash({
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
