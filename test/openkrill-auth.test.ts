import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openkrillCredential } from '../src/openkrill-auth.ts';
import type { Env } from '../src/types.ts';
import { createSqliteD1, rawSqlite } from './sqlite-d1.ts';

let env: Env;
let issued: number;
let refreshBodies: URLSearchParams[];

/** A fake Connect token endpoint that rotates the refresh token on every use, like the real one. */
function fakeTokenEndpoint(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = new URLSearchParams(String(init?.body));
  refreshBodies.push(body);
  if (body.get('refresh_token') === 'dead') return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  issued += 1;
  return Promise.resolve(Response.json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 }));
}

beforeEach(() => {
  env = { DB: createSqliteD1(), RECEIPT_SIGNING_KEY: '', OPENKRILL_CLIENT_ID: 'client-1', OPENKRILL_REFRESH_TOKEN: 'seed' };
  issued = 0;
  refreshBodies = [];
  vi.stubGlobal('fetch', vi.fn(fakeTokenEndpoint));
});

afterEach(() => vi.unstubAllGlobals());

describe('OpenKrill Connect credential', () => {
  it('prefers a static API key and makes no token call', async () => {
    env.OPENKRILL_API_KEY = 'ok_static';
    expect(await openkrillCredential(env)).toBe('ok_static');
    expect(refreshBodies).toHaveLength(0);
  });

  it('seeds from the secret, reuses the token, then refreshes with the rotated token', async () => {
    const t0 = 1_000_000;
    expect(await openkrillCredential(env, t0)).toBe('at-1');
    expect(refreshBodies[0].get('refresh_token')).toBe('seed');
    expect(refreshBodies[0].get('client_id')).toBe('client-1');
    expect(await openkrillCredential(env, t0 + 60_000)).toBe('at-1');
    expect(refreshBodies).toHaveLength(1);

    expect(await openkrillCredential(env, t0 + 3_600_000)).toBe('at-2');
    expect(refreshBodies[1].get('refresh_token')).toBe('rt-1');
  });

  it('keeps the newest pair when another isolate rotated first', async () => {
    const t0 = 1_000_000;
    await openkrillCredential(env, t0);
    const db = rawSqlite(env.DB);
    // Another isolate refreshed between this isolate's read and its write.
    const original = env.DB.prepare.bind(env.DB);
    let raced = false;
    env.DB.prepare = ((sql: string) => {
      if (!raced && sql.startsWith('UPDATE upstream_credentials')) {
        raced = true;
        db.prepare("UPDATE upstream_credentials SET refresh_token = 'rt-other', access_token = 'at-other'").run();
      }
      return original(sql);
    }) as typeof env.DB.prepare;
    expect(await openkrillCredential(env, t0 + 3_600_000)).toBe('at-other');
    expect(db.prepare('SELECT refresh_token FROM upstream_credentials').get()).toEqual({ refresh_token: 'rt-other' });
  });

  it('throws when the refresh token is refused, so the call is refunded as an upstream error', async () => {
    env.OPENKRILL_REFRESH_TOKEN = 'dead';
    await expect(openkrillCredential(env)).rejects.toThrow(/HTTP 400/);
  });
});
