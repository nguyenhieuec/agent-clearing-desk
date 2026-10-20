import type { Env } from './types.ts';

const CONNECT_TOKEN_URL = 'https://connect.openkrill.app/oauth/token';
const CONNECT_RESOURCE = 'https://connect.openkrill.app/mcp';
const CREDENTIAL = 'openkrill-connect';
/** Refresh a little before expiry so a token never lapses during an upstream call. */
const EXPIRY_MARGIN_MS = 60_000;

interface StoredCredential {
  refresh_token: string;
  access_token: string;
  access_expires_at: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function readCredential(env: Env): Promise<StoredCredential | null> {
  return env.DB.prepare(
    'SELECT refresh_token, access_token, access_expires_at FROM upstream_credentials WHERE name = ?'
  )
    .bind(CREDENTIAL)
    .first<StoredCredential>();
}

async function refresh(env: Env, refreshToken: string): Promise<Required<TokenResponse>> {
  const res = await fetch(CONNECT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AgentClearingDesk/1.0' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.OPENKRILL_CLIENT_ID ?? '',
      resource: CONNECT_RESOURCE,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new Error(`OpenKrill token refresh failed: HTTP ${res.status}`);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
}

/**
 * Saves a refreshed pair only if no other isolate rotated the refresh token first.
 * The loser of a race reads the winner's pair instead, so the stored refresh token is always the newest.
 */
async function saveRotated(env: Env, previous: string | null, next: Required<TokenResponse>, now: number): Promise<string> {
  const expiresAt = now + next.expires_in * 1000;
  const write = previous === null
    ? env.DB.prepare(
        'INSERT OR IGNORE INTO upstream_credentials (name, refresh_token, access_token, access_expires_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(CREDENTIAL, next.refresh_token, next.access_token, expiresAt, now)
    : env.DB.prepare(
        'UPDATE upstream_credentials SET refresh_token = ?, access_token = ?, access_expires_at = ?, updated_at = ? WHERE name = ? AND refresh_token = ?'
      ).bind(next.refresh_token, next.access_token, expiresAt, now, CREDENTIAL, previous);
  const { meta } = await write.run();
  if (meta.changes === 1) return next.access_token;
  const winner = await readCredential(env);
  return winner?.access_token ?? next.access_token;
}

/**
 * The credential the desk sends to OpenKrill: a static API key when one is set, otherwise a
 * Connect access token, refreshed from the rotating refresh token kept in D1.
 * The OPENKRILL_REFRESH_TOKEN secret only seeds the first refresh.
 */
export async function openkrillCredential(env: Env, now = Date.now()): Promise<string | undefined> {
  if (env.OPENKRILL_API_KEY) return env.OPENKRILL_API_KEY;
  if (!env.OPENKRILL_CLIENT_ID || !env.OPENKRILL_REFRESH_TOKEN) return undefined;
  const stored = await readCredential(env);
  if (stored && stored.access_expires_at - EXPIRY_MARGIN_MS > now) return stored.access_token;
  const current = stored?.refresh_token ?? env.OPENKRILL_REFRESH_TOKEN;
  return saveRotated(env, stored ? current : null, await refresh(env, current), now);
}
