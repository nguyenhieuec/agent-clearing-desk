import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types.ts';
import { createMockD1Database } from './mock-db.ts';
import {
  createAgentKey,
  createOrganization,
  getAgentKeyByRawKey,
} from '../src/db.ts';

function createTestEnv(): Env {
  return {
    DB: createMockD1Database(),
    OPENKRILL_BASE_URL: 'https://api.openkrill.app',
    DEFAULT_PRICE_CENTS: '5',
  };
}

describe('Agent Clearing Desk', () => {
  describe('Key Lifecycle and Cryptography', () => {
    it('creates an org and issues an agent key with hashed storage', async () => {
      const env = createTestEnv();
      const org = await createOrganization(env.DB, 'Acme Corp', 'billing@acme.example');
      expect(org.id).toMatch(/^org_/);

      const { rawKey, key } = await createAgentKey(env.DB, {
        orgId: org.id,
        name: 'EU Duty Agent',
        budgetCents: 50, // 50 cents = $0.50
        allowlist: ['eu_duty_estimate', 'tariffs'],
        perCallPriceCents: 1, // 1 cent per call
      });

      expect(rawKey).toMatch(/^cd_live_[a-f0-9]{48}$/);
      expect(key.key_id).toMatch(/^key_[a-f0-9]{16}$/);
      expect(key.key_hash).not.toBe(rawKey);
      expect(key.budget_cents).toBe(50);
      expect(key.spent_cents).toBe(0);

      // Verify DB lookup by raw key
      const found = await getAgentKeyByRawKey(env.DB, rawKey);
      expect(found).not.toBeNull();
      expect(found?.key_id).toBe(key.key_id);
    });
  });
});
