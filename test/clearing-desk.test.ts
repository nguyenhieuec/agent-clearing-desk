import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types.ts';
import worker from '../src/index.ts';
import { createMockD1Database } from './mock-db.ts';
import {
  createAgentKey,
  createOrganization,
  getAgentKeyByRawKey,
  recordClearingTransaction,
  rotateAgentKey,
} from '../src/db.ts';
import { verifyReceipt } from '../src/crypto.ts';
import {
  checkBudget,
  createBudgetExceededError,
  createToolNotAllowedError,
  isToolAllowed,
  resolveToolPricing,
} from '../src/metering.ts';

function createTestEnv(): Env {
  return {
    DB: createMockD1Database(),
    OPENKRILL_BASE_URL: 'https://api.openkrill.app',
    DEFAULT_PRICE_CENTS: '5',
    RECEIPT_SIGNING_KEY: 'test-receipt-signing-key',
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
        budgetCents: 50,
        allowlist: ['eu_duty_estimate', 'tariffs'],
        perCallPriceCents: 1,
      });

      expect(rawKey).toMatch(/^cd_live_[a-f0-9]{48}$/);
      expect(key.key_id).toMatch(/^key_[a-f0-9]{16}$/);
      expect(key.key_hash).not.toBe(rawKey);
      expect(key.budget_cents).toBe(50);
      expect(key.spent_cents).toBe(0);

      const found = await getAgentKeyByRawKey(env.DB, rawKey);
      expect(found).not.toBeNull();
      expect(found?.key_id).toBe(key.key_id);
    });

    it('rotates an agent key while preserving key_id and invalidating the old token', async () => {
      const env = createTestEnv();
      const org = await createOrganization(env.DB, 'Rotation Org', 'sec@acme.example');
      const { rawKey, key } = await createAgentKey(env.DB, {
        orgId: org.id,
        name: 'Rotatable Agent',
        budgetCents: 20,
        allowlist: ['*'],
      });

      const rotated = await rotateAgentKey(env.DB, key.key_id);
      expect(rotated).not.toBeNull();
      expect(rotated!.rawKey).not.toBe(rawKey);
      expect(rotated!.key.key_id).toBe(key.key_id);

      const oldLookup = await getAgentKeyByRawKey(env.DB, rawKey);
      expect(oldLookup).toBeNull();
      const newLookup = await getAgentKeyByRawKey(env.DB, rotated!.rawKey);
      expect(newLookup?.key_id).toBe(key.key_id);
    });
  });

  describe('Pre-Flight Metering, Spread Accounting, and Cryptographic Receipts', () => {
    it('enforces tool allowlists (403) and budget circuit breakers (402)', async () => {
      const env = createTestEnv();
      const org = await createOrganization(env.DB, 'Guardrail Org', 'finops@acme.example');
      const { key } = await createAgentKey(env.DB, {
        orgId: org.id,
        name: 'Scoped Buyer',
        budgetCents: 1,
        allowlist: ['eu_duty_estimate'],
        perCallPriceCents: 2,
        toolPricingOverrides: { eu_duty_estimate: 2 },
      });

      expect(isToolAllowed(key, 'find_tariff_codes')).toBe(false);
      const notAllowedErr = createToolNotAllowedError(key, 'find_tariff_codes');
      expect(notAllowedErr.error.code).toBe('tool_not_allowed');

      expect(isToolAllowed(key, 'eu_duty_estimate')).toBe(true);
      const pricing = resolveToolPricing(key, 'eu_duty_estimate');
      const budgetRes = checkBudget(key, pricing.priceCents);
      expect(budgetRes.allowed).toBe(false);
      const budgetErr = createBudgetExceededError(key, 'eu_duty_estimate', pricing.priceCents, 'rcpt_test');
      expect(budgetErr.error.code).toBe('budget_exceeded');
    });

    it('computes wholesale-to-retail clearing margin and signs verifiable receipts', async () => {
      const env = createTestEnv();
      const org = await createOrganization(env.DB, 'Ledger Org', 'audit@acme.example');
      const { key } = await createAgentKey(env.DB, {
        orgId: org.id,
        name: 'Audit Buyer',
        budgetCents: 10,
        allowlist: ['eu_duty_estimate'],
        perCallPriceCents: 5,
      });

      const pricing = resolveToolPricing(key, 'eu_duty_estimate');
      expect(pricing.priceCents).toBeGreaterThan(pricing.costCents);
      expect(pricing.marginCents).toBeCloseTo(pricing.priceCents - pricing.costCents, 5);

      const tx = await recordClearingTransaction(env.DB, {
        key,
        toolName: 'eu_duty_estimate',
        protocol: 'http',
        requestMethod: 'POST',
        status: 'success',
        statusCode: 200,
        paramsSummary: '{"items":"shirts"}',
        costCents: pricing.costCents,
        priceCents: pricing.priceCents,
        marginCents: pricing.marginCents,
        signingKey: env.RECEIPT_SIGNING_KEY,
      });

      expect(tx.receipt.id).toMatch(/^rcpt_/);
      expect(await verifyReceipt(tx.receipt, env.RECEIPT_SIGNING_KEY)).toBe(true);
      expect(await verifyReceipt(tx.receipt, 'another-key')).toBe(false);
      const tampered = { ...tx.receipt, amount_cents: tx.receipt.amount_cents + 1 };
      expect(await verifyReceipt(tampered, env.RECEIPT_SIGNING_KEY)).toBe(false);
    });

    it('serves GET/HEAD on /admin and /health via worker entrypoint', async () => {
      const env = createTestEnv();
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
      const healthRes = await worker.fetch(new Request('https://desk.example/health'), env, ctx);
      expect(healthRes.status).toBe(200);

      const headAdmin = await worker.fetch(new Request('https://desk.example/admin', { method: 'HEAD' }), env, ctx);
      expect(headAdmin.status).toBe(200);
    });
  });
});
