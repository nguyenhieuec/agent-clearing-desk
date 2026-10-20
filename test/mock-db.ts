import type {
  AgentKey,
  AuditLog,
  Organization,
  Receipt,
  UsageEvent,
} from '../src/types.ts';

/**
 * In-memory D1Database test double implementing the Cloudflare D1 interface
 * for organizations, agent_keys, audit_logs, receipts, and usage_events.
 */
export function createMockD1Database(): D1Database {
  const orgs: Organization[] = [];
  const keys: AgentKey[] = [];
  const auditLogs: AuditLog[] = [];
  const receipts: Receipt[] = [];
  const usageEvents: UsageEvent[] = [];

  function createPreparedStatement(sql: string, params: unknown[] = []): any {
    return {
      bind(...values: unknown[]) {
        return createPreparedStatement(sql, values);
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const res = await this.all();
        if (!res.results || res.results.length === 0) return null;
        if (colName) return (res.results[0] as Record<string, unknown>)[colName] as T;
        return res.results[0] as T;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const trimmed = sql.trim();

        // 1. SELECT agent_keys by key_hash
        if (trimmed.includes('FROM agent_keys WHERE key_hash = ?')) {
          const hash = params[0] as string;
          const found = keys.find(k => k.key_hash === hash);
          return { results: found ? [{ ...found } as unknown as T] : [], success: true, meta: {} as any };
        }

        // 2. SELECT agent_keys by key_id
        if (trimmed.includes('FROM agent_keys WHERE key_id = ?')) {
          const id = params[0] as string;
          const found = keys.find(k => k.key_id === id);
          return { results: found ? [{ ...found } as unknown as T] : [], success: true, meta: {} as any };
        }

        // 3. SELECT all agent_keys
        if (trimmed.startsWith('SELECT * FROM agent_keys')) {
          if (trimmed.includes('WHERE org_id = ?')) {
            const orgId = params[0] as string;
            const matches = keys.filter(k => k.org_id === orgId).map(k => ({ ...k }));
            return { results: matches as unknown as T[], success: true, meta: {} as any };
          }
          return { results: keys.map(k => ({ ...k })).reverse() as unknown as T[], success: true, meta: {} as any };
        }

        // 4. SELECT organizations
        if (trimmed.startsWith('SELECT * FROM organizations')) {
          return { results: [...orgs].reverse() as unknown as T[], success: true, meta: {} as any };
        }

        // 5. SELECT receipts by id
        if (trimmed.includes('FROM receipts WHERE id = ?')) {
          const id = params[0] as string;
          const found = receipts.find(r => r.id === id);
          return { results: found ? [found as unknown as T] : [], success: true, meta: {} as any };
        }

        // 6. SELECT receipts list
        if (trimmed.startsWith('SELECT * FROM receipts')) {
          if (trimmed.includes('WHERE key_id = ?')) {
            const keyId = params[0] as string;
            const limit = Number(params[1] || 50);
            const matches = receipts.filter(r => r.key_id === keyId).slice(0, limit);
            return { results: matches as unknown as T[], success: true, meta: {} as any };
          }
          const limit = Number(params[0] || 50);
          return { results: receipts.slice(0, limit) as unknown as T[], success: true, meta: {} as any };
        }

        // 7. SELECT audit_logs
        if (trimmed.startsWith('SELECT * FROM audit_logs')) {
          let matches = [...auditLogs];
          if (trimmed.includes('WHERE key_id = ?')) {
            const keyId = params[0] as string;
            matches = matches.filter(a => a.key_id === keyId);
            if (trimmed.includes('AND status = ?')) {
              const status = params[1] as string;
              matches = matches.filter(a => a.status === status);
            }
          }
          const limit = typeof params[params.length - 1] === 'number' ? (params[params.length - 1] as number) : 50;
          return { results: matches.slice(0, limit) as unknown as T[], success: true, meta: {} as any };
        }

        // 8. SELECT usage_events
        if (trimmed.includes('FROM usage_events WHERE key_id = ? AND period = ?')) {
          const keyId = params[0] as string;
          const period = params[1] as string;
          const matches = usageEvents.filter(u => u.key_id === keyId && u.period === period);
          return { results: matches as unknown as T[], success: true, meta: {} as any };
        }

        // 9. Overview count queries
        if (trimmed.includes('SELECT COUNT(*) as count FROM organizations')) {
          return { results: [{ count: orgs.length }] as unknown as T[], success: true, meta: {} as any };
        }
        if (trimmed.includes('SELECT COUNT(*) as count FROM receipts')) {
          return { results: [{ count: receipts.length }] as unknown as T[], success: true, meta: {} as any };
        }
        if (trimmed.includes('COALESCE(SUM(margin_cents), 0) as total_margin FROM audit_logs')) {
          const totalMargin = auditLogs.reduce((acc, a) => acc + (a.margin_cents || 0), 0);
          return { results: [{ total_margin: totalMargin }] as unknown as T[], success: true, meta: {} as any };
        }
        if (trimmed.includes('FROM agent_keys WHERE status = \'active\'')) {
          const activeKeys = keys.filter(k => k.status === 'active');
          const totalBudget = activeKeys.reduce((acc, k) => acc + k.budget_cents, 0);
          const totalSpent = activeKeys.reduce((acc, k) => acc + k.spent_cents, 0);
          return {
            results: [{ count: activeKeys.length, total_budget: totalBudget, total_spent: totalSpent }] as unknown as T[],
            success: true,
            meta: {} as any,
          };
        }

        return { results: [], success: true, meta: {} as any };
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        const trimmed = sql.trim();

        // 1. INSERT organizations
        if (trimmed.startsWith('INSERT INTO organizations')) {
          orgs.push({
            id: params[0] as string,
            name: params[1] as string,
            email: params[2] as string,
            created_at: params[3] as number,
          });
          return { results: [], success: true, meta: {} as any };
        }

        // 2. INSERT agent_keys
        if (trimmed.startsWith('INSERT INTO agent_keys')) {
          keys.push({
            key_hash: params[0] as string,
            key_id: params[1] as string,
            key_prefix: params[2] as string,
            org_id: params[3] as string,
            name: params[4] as string,
            budget_cents: params[5] as number,
            spent_cents: 0,
            allowlist: params[6] as string,
            per_call_price_cents: params[7] as number,
            tool_pricing_overrides: params[8] as string,
            status: 'active',
            created_at: params[9] as number,
            updated_at: params[10] as number,
          });
          return { results: [], success: true, meta: {} as any };
        }

        // 3. UPDATE agent_keys (rotation)
        if (trimmed.startsWith('UPDATE agent_keys\n       SET key_hash = ?')) {
          const keyHash = params[0] as string;
          const keyPrefix = params[1] as string;
          const updatedAt = params[2] as number;
          const keyId = params[3] as string;
          const k = keys.find(item => item.key_id === keyId);
          if (k) {
            k.key_hash = keyHash;
            k.key_prefix = keyPrefix;
            k.updated_at = updatedAt;
          }
          return { results: [], success: true, meta: {} as any };
        }

        // 4. UPDATE agent_keys status (revocation)
        if (trimmed.startsWith('UPDATE agent_keys SET status = ?')) {
          const status = params[0] as 'active' | 'revoked';
          const updatedAt = params[1] as number;
          const keyId = params[2] as string;
          const k = keys.find(item => item.key_id === keyId);
          if (k) {
            k.status = status;
            k.updated_at = updatedAt;
          }
          return { results: [], success: true, meta: {} as any };
        }

        // 5. UPDATE agent_keys budget
        if (trimmed.startsWith('UPDATE agent_keys SET budget_cents = ?')) {
          const budget = params[0] as number;
          const updatedAt = params[1] as number;
          const keyId = params[2] as string;
          const k = keys.find(item => item.key_id === keyId);
          if (k) {
            k.budget_cents = budget;
            k.updated_at = updatedAt;
          }
          return { results: [], success: true, meta: {} as any };
        }

        // 6. UPDATE agent_keys spent_cents
        if (trimmed.startsWith('UPDATE agent_keys SET spent_cents = spent_cents + ?')) {
          const amount = params[0] as number;
          const updatedAt = params[1] as number;
          const keyId = params[2] as string;
          const k = keys.find(item => item.key_id === keyId);
          if (k) {
            k.spent_cents += amount;
            k.updated_at = updatedAt;
          }
          return { results: [], success: true, meta: {} as any };
        }

        // 7. INSERT audit_logs
        if (trimmed.startsWith('INSERT INTO audit_logs')) {
          auditLogs.unshift({
            id: params[0] as string,
            org_id: params[1] as string,
            key_id: params[2] as string,
            tool_name: params[3] as string,
            protocol: params[4] as 'http' | 'mcp',
            request_method: params[5] as string,
            status: params[6] as 'success' | 'refused_budget' | 'refused_allowlist' | 'error',
            status_code: params[7] as number,
            params_summary: params[8] as string,
            cost_cents: params[9] as number,
            price_cents: params[10] as number,
            margin_cents: params[11] as number,
            created_at: params[12] as number,
          });
          return { results: [], success: true, meta: {} as any };
        }

        // 8. INSERT receipts
        if (trimmed.startsWith('INSERT INTO receipts')) {
          receipts.unshift({
            id: params[0] as string,
            audit_log_id: params[1] as string,
            key_id: params[2] as string,
            org_id: params[3] as string,
            tool_name: params[4] as string,
            amount_cents: params[5] as number,
            currency: params[6] as string,
            receipt_hash: params[7] as string,
            issued_at: params[8] as number,
          });
          return { results: [], success: true, meta: {} as any };
        }

        // 9. UPSERT usage_events
        if (trimmed.startsWith('INSERT INTO usage_events')) {
          const keyId = params[0] as string;
          const event = params[1] as string;
          const period = params[2] as string;
          const spentCents = params[3] as number;
          const existing = usageEvents.find(
            u => u.key_id === keyId && u.event === event && u.period === period
          );
          if (existing) {
            existing.count += 1;
            existing.spent_cents += spentCents;
          } else {
            usageEvents.push({
              key_id: keyId,
              event,
              period,
              count: 1,
              spent_cents: spentCents,
            });
          }
          return { results: [], success: true, meta: {} as any };
        }

        return { results: [], success: true, meta: {} as any };
      },
      raw<T = unknown[]>(): Promise<T[]> {
        return Promise.resolve([]);
      },
    };
  }

  const db = {
    prepare(sql: string): D1PreparedStatement {
      return createPreparedStatement(sql) as unknown as D1PreparedStatement;
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run<T>());
      }
      return results;
    },
    async exec(query: string): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
  };

  return db as unknown as D1Database;
}
