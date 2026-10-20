import { fromBase64Url, toBase64Url } from './crypto.ts';

/**
 * Upstream credentials an operator gives the desk at run time are stored only sealed:
 * AES-256-GCM under UPSTREAM_SECRET_KEY (a Worker secret, 32 random bytes in base64),
 * bound to the tool name, so a row copied to another tool does not open.
 */
async function sealingKey(secret: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('UPSTREAM_SECRET_KEY must be 32 bytes in base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

export async function sealSecret(secret: string, boundTo: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(boundTo) },
    await sealingKey(secret, 'encrypt'),
    new TextEncoder().encode(plaintext)
  );
  return `${toBase64Url(iv.buffer)}.${toBase64Url(sealed)}`;
}

export async function openSecret(secret: string, boundTo: string, sealed: string): Promise<string> {
  const [iv, data] = sealed.split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: new TextEncoder().encode(boundTo) },
    await sealingKey(secret, 'decrypt'),
    fromBase64Url(data)
  );
  return new TextDecoder().decode(plain);
}
